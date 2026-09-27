import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import {
  createTestLink,
  createTestProject,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The OBSOLETE-NEIGHBOUR read over REAL state (Story MOTIR-6576 · Subtask MOTIR-6657).
// Real Postgres through `dispatchPromptService.getDispatchPrompt`: which neighbours
// the service finds MARKED — the parent, the `is_blocked_by` blockers, the work
// items the card's `## Context refs` name — how each is named once, and that the
// read is bounded and can never stop a dispatch. The TEXT itself is fixed by
// `obsoleteNeighboursSection.test.ts`.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function item(title: string, over: { parentId?: string; kind?: 'story' | 'task' } = {}) {
  // A parented leaf is a subtask; a root leaf must be a task (a subtask needs a parent).
  return createTestWorkItem(fx, {
    kind: over.kind ?? (over.parentId ? 'subtask' : 'task'),
    type: 'code',
    title,
    parentId: over.parentId ?? null,
  });
}

/** Finish a work item and mark it — the only state a mark can sit in (MOTIR-6575). */
async function mark(row: WorkItem, obsolescence: 'outdated' | 'deprecated', noteMd?: string) {
  await adminDb.workItem.update({
    where: { id: row.id },
    data: { status: 'done', obsolescence, obsolescenceNoteMd: noteMd ?? null },
  });
}

async function supersede(newer: WorkItem, older: WorkItem) {
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: newer.id,
    toId: older.id,
    kind: 'supersedes',
    createdById: fx.ownerId,
  });
}

async function blockedBy(card: WorkItem, blocker: WorkItem) {
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: card.id,
    toId: blocker.id,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
}

async function setRefs(card: WorkItem, refs: string[]) {
  await adminDb.workItem.update({
    where: { id: card.id },
    data: { descriptionMd: ['Do it.', '', '## Context refs', '', ...refs].join('\n') },
  });
}

async function promptFor(card: WorkItem) {
  return (await dispatchPromptService.getDispatchPrompt(fx.projectId, card.identifier, fx.ctx))
    .prompt;
}

const obsoleteLines = (prompt: string) => prompt.match(/^- ⚠ .*$/gm) ?? [];

describe('the marked PARENT', () => {
  it('a done parent marked outdated → one line: its superseder and ONLY the note’s first line', async () => {
    const story = await item('Old story', { kind: 'story' });
    const newer = await item('New story', { kind: 'story' });
    const card = await item('The card', { parentId: story.id });
    await mark(story, 'outdated', 'Moved to the new story.\nSecond line never shown.');
    await supersede(newer, story);

    const lines = obsoleteLines(await promptFor(card));
    expect(lines).toEqual([
      `- ⚠ parent ${story.identifier} is OUTDATED — superseded by ${newer.identifier}. Moved to the new story.`,
    ]);
  });
});

describe('BLOCKERS and CONTEXT REFS', () => {
  it('a marked blocker and a chip-named marked ref get a line each; a blocker also named in the refs gets ONE, as blocker', async () => {
    const card = await item('The card');
    const blocker = await item('Blocker');
    const chipped = await item('Chipped');
    await mark(blocker, 'deprecated', 'Retired.');
    await mark(chipped, 'outdated');
    await blockedBy(card, blocker);
    await setRefs(card, [
      `- [${chipped.identifier}](motir:${chipped.id}) — the old contract`,
      `- [${blocker.identifier}](motir:${blocker.id}) — also a blocker`,
    ]);

    expect(obsoleteLines(await promptFor(card))).toEqual([
      `- ⚠ blocker ${blocker.identifier} is DEPRECATED — superseded by nothing recorded. Retired.`,
      `- ⚠ context ref ${chipped.identifier} is OUTDATED — superseded by nothing recorded.`,
    ]);
  });

  it('several superseders are listed in ascending key order', async () => {
    const card = await item('The card');
    const old = await item('Old');
    const a = await item('A');
    const b = await item('B');
    await mark(old, 'outdated');
    await supersede(b, old);
    await supersede(a, old);
    await blockedBy(card, old);
    expect(obsoleteLines(await promptFor(card))).toEqual([
      `- ⚠ blocker ${old.identifier} is OUTDATED — superseded by ${a.identifier}, ${b.identifier}.`,
    ]);
  });

  it('a BARE key resolves like a chip; another project’s item, an unknown key and a path add nothing', async () => {
    const card = await item('The card');
    const bare = await item('Bare');
    await mark(bare, 'outdated');
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const otherItem = await createTestWorkItem(
      { ...fx, projectId: other.id, projectIdentifier: other.identifier },
      { kind: 'task', type: 'code', title: 'Elsewhere' },
    );
    await mark(otherItem, 'outdated');
    await setRefs(card, [
      `- ${bare.identifier} — named by key`,
      `- [${otherItem.identifier}](motir:${otherItem.id}) — another project, by chip`,
      `- ${otherItem.identifier} — another project, by key`,
      '- PROD-9999 — no such item',
      '- `lib/dispatch/promptTemplate.ts` — a path',
    ]);

    expect(obsoleteLines(await promptFor(card))).toEqual([
      `- ⚠ context ref ${bare.identifier} is OUTDATED — superseded by nothing recorded.`,
    ]);
  });

  it('an UNMARKED neighbourhood adds no line and no guidance', async () => {
    const story = await item('Story', { kind: 'story' });
    const card = await item('The card', { parentId: story.id });
    const blocker = await item('Blocker');
    await blockedBy(card, blocker);
    await setRefs(card, [`- ${blocker.identifier} — named`]);
    const prompt = await promptFor(card);
    expect(obsoleteLines(prompt)).toEqual([]);
    expect(prompt).not.toContain('superseded it');
  });
});

describe('the read is BOUNDED and cannot stop a dispatch', () => {
  it('issues the same number of reads for one ref as for five', async () => {
    const card = await item('The card');
    const refs: WorkItem[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await item(`Ref ${i}`);
      await mark(r, 'outdated');
      refs.push(r);
    }
    const byIds = vi.spyOn(workItemRepository, 'findByIds');
    const byKeys = vi.spyOn(workItemRepository, 'findByIdentifiers');
    const superseders = vi.spyOn(workItemLinkRepository, 'findSupersedersOf');

    const count = async (named: WorkItem[]) => {
      await setRefs(
        card,
        named.map((r) => `- ${r.identifier} — ref`),
      );
      byIds.mockClear();
      byKeys.mockClear();
      superseders.mockClear();
      const lines = obsoleteLines(await promptFor(card));
      return {
        lines: lines.length,
        reads: [byIds.mock.calls.length, byKeys.mock.calls.length, superseders.mock.calls.length],
      };
    };
    const one = await count(refs.slice(0, 1));
    const five = await count(refs);
    expect(one.lines).toBe(1);
    expect(five.lines).toBe(5);
    expect(five.reads).toEqual(one.reads);
  });

  it('a throw inside the neighbour read renders no obsolescence line — never an error', async () => {
    const story = await item('Old story', { kind: 'story' });
    const card = await item('The card', { parentId: story.id });
    await mark(story, 'outdated');
    vi.spyOn(workItemLinkRepository, 'findSupersedersOf').mockRejectedValue(new Error('boom'));

    const prompt = await promptFor(card);
    expect(obsoleteLines(prompt)).toEqual([]);
    expect(prompt).toContain(`- Parent: ${story.identifier} — Old story`);
  });
});
