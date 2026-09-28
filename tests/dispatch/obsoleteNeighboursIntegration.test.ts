import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { designAccessService } from '@/lib/services/designAccessService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestProject, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-6576's motir-core INTEGRATION gate (Subtask MOTIR-6660). The
// dispatch prompt for a card whose FINISHED neighbours are marked, generated
// through the same service entry point the dispatch route calls, against the real
// database — and every piece of the neighbourhood seeded through the real doors
// (`createWorkItem`, `updateStatus`, `updateWorkItem`, `linkWorkItems`), never a
// raw insert. The TEXT is fixed by `obsoleteNeighboursSection.test.ts`; this file
// proves the lines an agent reads are the ones the real state produces.

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

async function create(
  f: WorkItemFixture,
  input: {
    title: string;
    kind: 'story' | 'task' | 'subtask';
    parentId?: string;
    descriptionMd?: string;
  },
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    {
      projectId: f.projectId,
      kind: input.kind,
      title: input.title,
      parentId: input.parentId ?? null,
      descriptionMd: input.descriptionMd ?? null,
      ...(input.kind === 'story' ? {} : { type: 'code' as const }),
    },
    f.ctx,
  );
}

/** Walk a card to Done along the default workflow's legal hops. */
async function finish(f: WorkItemFixture, item: WorkItemDto) {
  await workItemsService.updateStatus(item.id, 'in_progress', f.ctx);
  await workItemsService.updateStatus(item.id, 'done', f.ctx);
}

async function mark(
  f: WorkItemFixture,
  item: WorkItemDto,
  obsolescence: 'outdated' | 'deprecated',
  obsolescenceNoteMd: string,
) {
  await workItemsService.updateWorkItem(item.id, { obsolescence, obsolescenceNoteMd }, f.ctx);
}

async function link(
  f: WorkItemFixture,
  from: WorkItemDto,
  to: WorkItemDto,
  kind: 'supersedes' | 'is_blocked_by',
) {
  await workItemsService.linkWorkItems({ fromId: from.id, toId: to.id, kind }, f.ctx);
}

async function promptFor(f: WorkItemFixture, item: WorkItemDto) {
  return (await dispatchPromptService.getDispatchPrompt(f.projectId, item.identifier, f.ctx))
    .prompt;
}

const obsoleteLines = (prompt: string) => prompt.match(/^- ⚠ .*$/gm) ?? [];
const GUIDANCE =
  "  An OUTDATED item's body is history: read what it does now from the items that" +
  ' superseded it. A DEPRECATED one was retired on purpose: do not build on it.';

/**
 * The neighbourhood the story is about: a finished story (the card's parent)
 * superseded by a newer one, a finished blocker, a finished work item named by
 * chip and another named by bare key — and the To Do card under test.
 */
async function neighbourhood(f: WorkItemFixture) {
  const oldStory = await create(f, { title: 'Old story', kind: 'story' });
  const newStory = await create(f, { title: 'New story', kind: 'story' });
  const blocker = await create(f, {
    title: 'Retired blocker',
    kind: 'subtask',
    parentId: oldStory.id,
  });
  const chipped = await create(f, { title: 'Old contract', kind: 'task' });
  const keyed = await create(f, { title: 'Old helper', kind: 'task' });
  const card = await create(f, {
    title: 'The card',
    kind: 'subtask',
    parentId: oldStory.id,
    descriptionMd: [
      'Build it.',
      '',
      '## Context refs',
      '',
      `- [${chipped.identifier}](motir:${chipped.id}) — the contract this reads`,
      `- ${keyed.identifier} — the helper it calls`,
      `- [${blocker.identifier}](motir:${blocker.id}) — also its blocker`,
      '- `lib/dispatch/promptTemplate.ts` — a path, not a work item',
    ].join('\n'),
  });
  await link(f, card, blocker, 'is_blocked_by');
  for (const done of [oldStory, newStory, blocker, chipped, keyed]) await finish(f, done);
  return { oldStory, newStory, blocker, chipped, keyed, card };
}

describe('the dispatch prompt names every MARKED finished neighbour (MOTIR-6660)', () => {
  it('parent, blocker, chip ref and bare-key ref — one line each, blocker deduplicated, superseders and note first lines', async () => {
    const n = await neighbourhood(fx);
    await mark(fx, n.oldStory, 'outdated', 'Superseded by the new story.\nThe detail below.');
    await link(fx, n.newStory, n.oldStory, 'supersedes');
    await mark(fx, n.blocker, 'deprecated', 'The direction was retired.');
    await mark(fx, n.chipped, 'outdated', '\n\nThe contract moved.');
    await link(fx, n.newStory, n.chipped, 'supersedes');
    await mark(fx, n.keyed, 'outdated', 'Folded into the new story.');

    const prompt = await promptFor(fx, n.card);
    expect(obsoleteLines(prompt)).toEqual([
      `- ⚠ parent ${n.oldStory.identifier} is OUTDATED — superseded by ${n.newStory.identifier}. Superseded by the new story.`,
      `- ⚠ blocker ${n.blocker.identifier} is DEPRECATED — superseded by nothing recorded. The direction was retired.`,
      `- ⚠ context ref ${n.chipped.identifier} is OUTDATED — superseded by ${n.newStory.identifier}. The contract moved.`,
      `- ⚠ context ref ${n.keyed.identifier} is OUTDATED — superseded by nothing recorded. Folded into the new story.`,
    ]);
    expect(prompt.split(GUIDANCE)).toHaveLength(2);
    // The lines sit in the CONTEXT section, before the card body.
    expect(prompt.indexOf(GUIDANCE)).toBeLessThan(prompt.indexOf('CARD DESCRIPTION'));
  });

  it('an UNMARKED neighbourhood gains no line: the prompt equals the marked one with exactly its obsolescence lines removed', async () => {
    const n = await neighbourhood(fx);
    const before = await promptFor(fx, n.card);
    expect(obsoleteLines(before)).toEqual([]);
    expect(before).not.toContain(GUIDANCE);

    await mark(fx, n.oldStory, 'outdated', 'Moved.');
    await mark(fx, n.keyed, 'deprecated', 'Gone.');
    const after = await promptFor(fx, n.card);
    expect(obsoleteLines(after)).toHaveLength(2);
    const stripped = after
      .split('\n')
      .filter((line) => !/^- ⚠ /.test(line) && line !== GUIDANCE)
      .join('\n');
    expect(stripped).toBe(before);
  });
});

describe('tenant isolation — a context ref never reaches outside the card’s project', () => {
  it('a marked work item in ANOTHER PROJECT of the same workspace adds no line, by chip or by key', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const otherFx: WorkItemFixture = {
      ...fx,
      projectId: other.id,
      projectIdentifier: other.identifier,
    };
    const elsewhere = await create(otherFx, { title: 'Elsewhere', kind: 'task' });
    await finish(otherFx, elsewhere);
    await mark(otherFx, elsewhere, 'outdated', 'Not this project.');

    const card = await create(fx, {
      title: 'The card',
      kind: 'task',
      descriptionMd: [
        '## Context refs',
        '',
        `- [${elsewhere.identifier}](motir:${elsewhere.id}) — by chip`,
        `- ${elsewhere.identifier} — by key`,
      ].join('\n'),
    });
    expect(obsoleteLines(await promptFor(fx, card))).toEqual([]);
  });

  it('a marked work item in ANOTHER WORKSPACE adds no line, even under a colliding key', async () => {
    const otherWs = await makeWorkItemFixture({ name: 'Globex', identifier: 'PROD' });
    const foreign = await create(otherWs, { title: 'Foreign', kind: 'task' });
    await finish(otherWs, foreign);
    await mark(otherWs, foreign, 'deprecated', 'Another tenant.');

    const card = await create(fx, {
      title: 'The card',
      kind: 'task',
      descriptionMd: [
        '## Context refs',
        '',
        `- [${foreign.identifier}](motir:${foreign.id}) — by chip`,
        // Same key string, but it resolves inside the card's own project, where
        // it names the card itself — which is never marked.
        `- ${foreign.identifier} — by key`,
      ].join('\n'),
    });
    expect(obsoleteLines(await promptFor(fx, card))).toEqual([]);
  });
});

describe('ordering and the no-refusal peers', () => {
  it('several marked blockers are listed in ascending key order, like the Depends-on line', async () => {
    const card = await create(fx, { title: 'The card', kind: 'task' });
    const first = await create(fx, { title: 'First', kind: 'task' });
    const second = await create(fx, { title: 'Second', kind: 'task' });
    // Linked in REVERSE key order, so the order the edges come back in cannot
    // be what the lines are sorted by.
    await link(fx, card, second, 'is_blocked_by');
    await link(fx, card, first, 'is_blocked_by');
    for (const b of [second, first]) {
      await finish(fx, b);
      await mark(fx, b, 'outdated', 'Old.');
    }
    expect(obsoleteLines(await promptFor(fx, card))).toEqual([
      `- ⚠ blocker ${first.identifier} is OUTDATED — superseded by nothing recorded. Old.`,
      `- ⚠ blocker ${second.identifier} is OUTDATED — superseded by nothing recorded. Old.`,
    ]);
  });

  it('the neighbour lines survive every other no-refusal peer read failing', async () => {
    const n = await neighbourhood(fx);
    await mark(fx, n.oldStory, 'outdated', 'Moved.');
    vi.spyOn(designAccessService, 'designsForWorkItem').mockRejectedValue(new Error('design'));
    vi.spyOn(approvalGateRepository, 'findConfirmedDecisionsUnderEpicOf').mockRejectedValue(
      new Error('decisions'),
    );
    vi.spyOn(approvalGatesService, 'latestRefusalFor').mockRejectedValue(new Error('refusal'));

    expect(obsoleteLines(await promptFor(fx, n.card))).toEqual([
      `- ⚠ parent ${n.oldStory.identifier} is OUTDATED — superseded by nothing recorded. Moved.`,
    ]);
  });
});

describe('workItemLinkRepository.findSupersedersOf', () => {
  it('answers [] for no ids, and each superseder with its key inside the bound transaction', async () => {
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findSupersedersOf([], tx),
      ),
    ).toEqual([]);

    const older = await create(fx, { title: 'Older', kind: 'task' });
    const newer = await create(fx, { title: 'Newer', kind: 'task' });
    await link(fx, newer, older, 'supersedes');
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemLinkRepository.findSupersedersOf([older.id], tx),
      ),
    ).toEqual([
      { toId: older.id, supersederKey: newer.key, supersederIdentifier: newer.identifier },
    ]);
  });
});
