import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE EPIC'S CONFIRMED DECISIONS, OVER REAL STATE (Story MOTIR-5871 · Subtask
// MOTIR-5959). Real Postgres through `dispatchPromptService.getDispatchPrompt`: a card
// under an epic renders every CONFIRMED `human` decision on that epic, oldest
// confirmation first — never an overturned or an awaiting one, and nothing at all for
// a card with no epic ancestor — read in ONE statement however many decisions the
// epic holds.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function body(decision: string, resulting: string) {
  return [
    '## Decision',
    decision,
    '## What changed',
    '**Change:** workflow',
    'Before and after.',
    '## Supersedes',
    'MOTIR-1',
    '## Resulting direction',
    resulting,
  ].join('\n');
}

async function create(extra: Record<string, unknown>) {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Item ${seq}`, ...extra },
    fx.ctx,
  );
}

async function decision(parentId: string, title: string, decision: string, resulting: string) {
  return create({
    parentId,
    title,
    type: 'decision',
    executor: 'human',
    descriptionMd: body(decision, resulting),
  });
}

async function decide(itemId: string, verb: 'approve' | 'overturn', decidedAt?: Date) {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: itemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  await approvalGatesService.decide(
    {
      gateId: read.gate!.id,
      decision: verb,
      source: 'api',
      stamp: read.stamp!,
      ...(verb === 'overturn' ? { noteMd: 'No.' } : {}),
    },
    fx.ctx,
    decidedAt ? { decidedAt } : {},
  );
}

async function promptFor(key: string) {
  return (await dispatchPromptService.getDispatchPrompt(fx.projectId, key, fx.ctx)).prompt;
}

describe('the epic’s confirmed decisions reach the prompt', () => {
  it('renders both confirmed decisions, the EARLIER confirmation first — and no overturned or awaiting one', async () => {
    const epic = await create({ kind: 'epic', title: 'Exports' });
    const story = await create({ kind: 'story', title: 'Export page', parentId: epic.id });
    const card = await create({
      kind: 'subtask',
      parentId: story.id,
      title: 'Build it',
      type: 'code',
      executor: 'coding_agent',
    });

    // Created in the OPPOSITE order to their confirmation, so the order asserted is
    // the confirmation date and not the creation order.
    const later = await decision(epic.id, 'Drop CSV', 'CSV is dropped.', 'XLSX only.');
    const earlier = await decision(epic.id, 'Use a bucket', 'Exports go to a bucket.', 'Bucket.');
    await decide(earlier.id, 'approve', new Date('2026-09-01T09:00:00Z'));
    await decide(later.id, 'approve', new Date('2026-09-15T09:00:00Z'));
    const overturned = await decision(epic.id, 'Keep Postgres', 'Postgres stays.', 'Postgres.');
    await decide(overturned.id, 'overturn');
    const awaiting = await decision(epic.id, 'Add PDF', 'PDF is added.', 'PDF too.');

    const prompt = await promptFor(card.identifier);
    expect(prompt).toContain('CONFIRMED DECISIONS ON THIS EPIC');
    expect(prompt).toContain(`  ${earlier.identifier} — Use a bucket`);
    expect(prompt).toContain('    confirmed 2026-09-01T09:00:00.000Z');
    expect(prompt).toContain('      Exports go to a bucket.');
    expect(prompt).toContain(`  ${later.identifier} — Drop CSV`);
    expect(prompt.indexOf(earlier.identifier)).toBeLessThan(prompt.indexOf(later.identifier));
    expect(prompt).not.toContain(overturned.identifier);
    expect(prompt).not.toContain(awaiting.identifier);
    expect(prompt).toContain('HOW TO READ THEM');
  });

  it('a card with no epic ancestor, or whose epic holds no confirmed decision, renders nothing', async () => {
    const orphan = await create({ title: 'Loose', type: 'code', executor: 'coding_agent' });
    expect(await promptFor(orphan.identifier)).not.toContain('CONFIRMED DECISIONS');

    const epic = await create({ kind: 'epic', title: 'Quiet epic' });
    const awaiting = await decision(epic.id, 'Pending', 'Maybe.', 'Maybe.');
    const card = await create({
      parentId: epic.id,
      title: 'Work',
      type: 'code',
      executor: 'coding_agent',
    });
    const prompt = await promptFor(card.identifier);
    expect(prompt).not.toContain('CONFIRMED DECISIONS');
    expect(prompt).not.toContain(awaiting.identifier);
  });

  it('reads through the NEAREST epic only — a sibling epic’s decisions do not leak in', async () => {
    const mine = await create({ kind: 'epic', title: 'Mine' });
    const theirs = await create({ kind: 'epic', title: 'Theirs' });
    const foreign = await decision(theirs.id, 'Their call', 'Theirs.', 'Theirs.');
    await decide(foreign.id, 'approve');
    const card = await create({
      parentId: mine.id,
      title: 'Work',
      type: 'code',
      executor: 'coding_agent',
    });
    expect(await promptFor(card.identifier)).not.toContain(foreign.identifier);
  });
});

describe('ONE statement, however many decisions', () => {
  it('an epic with three confirmed decisions costs the same queries as one with one', async () => {
    const countQueries = async (fn: () => Promise<unknown>): Promise<number> => {
      let calls = 0;
      const listener = (e: { query: string }) => {
        if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(e.query.trim())) calls += 1;
      };
      (db as unknown as { $on: (e: 'query', cb: (e: { query: string }) => void) => void }).$on(
        'query',
        listener,
      );
      await fn();
      return calls;
    };

    const small = await create({ kind: 'epic', title: 'Small' });
    const d = await decision(small.id, 'One', 'One.', 'One.');
    await decide(d.id, 'approve');
    const smallCard = await create({
      parentId: small.id,
      title: 'Small work',
      type: 'code',
      executor: 'coding_agent',
    });

    const big = await create({ kind: 'epic', title: 'Big' });
    for (let i = 0; i < 3; i += 1) {
      const each = await decision(big.id, `D${i}`, `D${i}.`, `D${i}.`);
      await decide(each.id, 'approve');
    }
    const bigCard = await create({
      parentId: big.id,
      title: 'Big work',
      type: 'code',
      executor: 'coding_agent',
    });

    const one = await countQueries(() => promptFor(smallCard.identifier));
    const three = await countQueries(() => promptFor(bigCard.identifier));
    expect(three - one).toBe(one);
  });
});
