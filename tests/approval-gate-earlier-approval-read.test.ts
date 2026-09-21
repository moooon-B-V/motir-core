import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// THE RE-ASKED GATE'S EARLIER APPROVAL (Bug MOTIR-5863; § 28 panel 1's `af-record`, first
// span) — against a REAL Postgres.
//
// A merge gate re-asked after a press that did not land is a FRESH `awaiting` row: its
// `decidedByLabel` / `decidedAt` are null by construction. The band's first line names the
// approval that was SPENT — who gave it, when, over how many commits — and that is a
// DIFFERENT row, which `findLatestByWorkItem` deliberately never returns while a live
// question stands. So the read carries it on its own field.
//
// What is load-bearing here:
//
//   · IT IS THE LATEST APPROVAL, by DECISION time. Approvals accumulate (ADR §6d), so a
//     card approved twice has two; the band names the one that was just spent.
//   · `commits` IS THE EARLIER GATE'S MEMBER COUNT, not the current set's — the two can
//     differ, and naming the spent approval's own count is the point of the field.
//   · ONLY AN AWAITING MERGE GATE CARRIES ONE. A decided gate is its own record, and a
//     first ask has no history — both answer null, so their bands stay as they were.
//   · A SEND-BACK IS NOT AN APPROVAL. `changes_requested` spent nothing, so it names
//     nothing.

let fx: WorkItemFixture;
let itemId: string;

const CORE_V = 'moooon/motir-core#131@3f2a91c0000000000000000000000000000000aa';
const GATEWAY_V = 'moooon/motir-gateway#57@aa11bb2000000000000000000000000000000000';
const AI_V = 'moooon/motir-ai#88@bb22cc3000000000000000000000000000000000';

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API end to end' },
    fx.ctx,
  );
  itemId = story.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Seed = {
  state: 'awaiting' | 'approved' | 'changes_requested' | 'superseded';
  kind?: 'pull_request_approval' | 'design_result';
  subjectVersion?: string | null;
  decidedByLabel?: string | null;
  decidedAt?: Date | null;
  createdAt: Date;
};

async function seed(s: Seed) {
  const decided = s.state === 'approved' || s.state === 'changes_requested';
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: itemId,
      kind: s.kind ?? 'pull_request_approval',
      subjectId: `subject-${s.createdAt.getTime()}`,
      state: s.state,
      subjectVersion: s.subjectVersion ?? [CORE_V, GATEWAY_V].sort().join(','),
      decidedById: decided ? fx.ctx.userId : null,
      decidedByLabel: decided ? (s.decidedByLabel ?? 'Ada L.') : null,
      decidedAt: decided ? (s.decidedAt ?? s.createdAt) : null,
      createdAt: s.createdAt,
    },
  });
}

const read = () =>
  approvalGatesService.getForWorkItem(
    { workItemId: itemId, kind: 'pull_request_approval' },
    fx.ctx,
  );

describe('the re-asked merge gate carries the approval it replaced', () => {
  it('names who approved, when, and over how many commits — the spent approval, not the fresh ask', async () => {
    const spentAt = new Date('2026-09-15T14:22:00.000Z');
    await seed({
      state: 'approved',
      decidedAt: spentAt,
      createdAt: new Date('2026-09-15T14:00:00Z'),
    });
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });

    const r = await read();

    expect(r.gate?.state).toBe('awaiting');
    // The fresh row carries nobody — which is why the band cannot be drawn from it.
    expect(r.gate?.decidedByLabel).toBeNull();
    expect(r.earlierApproval).toEqual({
      decidedByLabel: 'Ada L.',
      decidedAt: spentAt.toISOString(),
      commits: 2,
    });
  });

  it('takes the LATEST approval by decision time when there are several', async () => {
    await seed({
      state: 'approved',
      decidedByLabel: 'Mara S.',
      decidedAt: new Date('2026-09-10T09:00:00Z'),
      createdAt: new Date('2026-09-10T08:00:00Z'),
    });
    await seed({
      state: 'approved',
      decidedByLabel: 'Ada L.',
      decidedAt: new Date('2026-09-15T14:22:00Z'),
      createdAt: new Date('2026-09-15T14:00:00Z'),
    });
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });

    expect((await read()).earlierApproval?.decidedByLabel).toBe('Ada L.');
  });

  it('counts the EARLIER gate’s members, which may differ from the current set', async () => {
    await seed({
      state: 'approved',
      subjectVersion: [AI_V, CORE_V, GATEWAY_V].sort().join(','),
      createdAt: new Date('2026-09-15T14:00:00Z'),
    });
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });

    const r = await read();
    expect(r.earlierApproval?.commits).toBe(3);
  });
});

describe('every other gate keeps the band it had', () => {
  it('a FIRST ask — nothing approved before it — carries none', async () => {
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });
    expect((await read()).earlierApproval).toBeNull();
  });

  it('a DECIDED gate carries none — it is its own record', async () => {
    await seed({ state: 'approved', createdAt: new Date('2026-09-15T14:00:00Z') });
    const r = await read();
    expect(r.gate?.state).toBe('approved');
    expect(r.earlierApproval).toBeNull();
  });

  it('a SEND-BACK is not an approval — it spent nothing, so it names nothing', async () => {
    await seed({ state: 'changes_requested', createdAt: new Date('2026-09-15T14:00:00Z') });
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });
    expect((await read()).earlierApproval).toBeNull();
  });

  it('another KIND’s approval never leaks into the merge gate’s band', async () => {
    await seed({
      state: 'approved',
      kind: 'design_result',
      subjectVersion: 'c0ffee00',
      createdAt: new Date('2026-09-15T14:00:00Z'),
    });
    await seed({ state: 'awaiting', createdAt: new Date('2026-09-15T15:05:00Z') });
    expect((await read()).earlierApproval).toBeNull();
  });

  it('no gate at all answers null, not undefined — the field is always present', async () => {
    const r = await read();
    expect(r.gate).toBeNull();
    expect(r.earlierApproval).toBeNull();
  });
});
