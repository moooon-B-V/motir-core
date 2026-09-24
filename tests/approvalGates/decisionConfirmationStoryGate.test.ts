import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE STORY'S motir-core GATE (Story MOTIR-5871 · Subtask MOTIR-5963). The per-card suites
// each saw a slice — the parser (`decisionRecord`), the raise and Confirm
// (`decisionConfirmationGate`), Overturn (`decisionOverturn`), the boundary
// (`decisionConfirmationReadback`), the prompt (`confirmedDecisionsRead`), the port and the
// rows. This file stands where they MEET, on real Postgres:
//
//   · the three decision kinds are DISJOINT over (type, executor) — one body that parses
//     under BOTH parsers, judged in every combination;
//   · decisions ACCUMULATE — two on one epic, both confirmed, the first untouched by the
//     second — and the epic's own body is byte-identical through raise, Confirm, Overturn;
//   · the record: none stamps none; an attachment stamps it, and a hard delete leaves the
//     row and reads back as removed;
//   · the boundary read carries exactly what the gates hold, in an order a consumer sorts;
//   · every `ApprovalGateState` member is handled by the decided-row fold — iterated from
//     the schema, not a hand list.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { aiBoundaryService } = await import('@/lib/services/aiBoundaryService');
const { decisionConfirmationGateService } =
  await import('@/lib/services/decisionConfirmationGateService');
const { toApprovalRecordDecidedRowDto } = await import('@/lib/mappers/approvalGateMappers');

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

const DECISION = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow',
  'Before and after.',
  '## Supersedes',
  'MOTIR-6',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

/** Sections for BOTH parsers — each ignores the other's headings. */
const BOTH = [
  DECISION,
  '## Question',
  'Where do exports live?',
  '## Why this is a choice',
  '**Situation:** two workflows',
  'Two workflows.',
  '## Options',
  '### A',
  '**Best if you want:** less to operate',
  'a',
  '### B',
  '**Best if you want:** more cost-effective',
  'b',
  '## What this choice gates',
  'The export story.',
].join('\n');

async function create(extra: Record<string, unknown>) {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Item ${seq}`, ...extra },
    fx.ctx,
  );
}

async function decide(itemId: string, verb: 'approve' | 'overturn', decidedAt?: Date) {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: itemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  return approvalGatesService.decide(
    {
      gateId: read.gate!.id,
      decision: verb,
      source: 'ui',
      stamp: read.stamp!,
      ...(verb === 'overturn' ? { noteMd: 'Not what we agreed.' } : {}),
    },
    fx.ctx,
    decidedAt ? { decidedAt } : {},
  );
}

const kindsRaisedOn = async (workItemId: string) =>
  (await adminDb.approvalGate.findMany({ where: { workItemId }, orderBy: { kind: 'asc' } })).map(
    (gate) => gate.kind,
  );

describe('the three decision kinds are DISJOINT over (type, executor)', () => {
  it.each([
    ['decision', 'human', ['decision_confirmation']],
    // An agent's decision is asked through its pull request's document, never here.
    ['decision', 'coding_agent', []],
    ['choice', 'human', ['decision_choice']],
    ['choice', 'coding_agent', ['decision_choice']],
    ['code', 'human', []],
    ['code', 'coding_agent', []],
  ] as const)('%s + %s raises %j', async (type, executor, expected) => {
    const item = await create({ type, executor, descriptionMd: BOTH });
    expect(await kindsRaisedOn(item.id)).toEqual(expected);
  });
});

describe('decisions ACCUMULATE, and the epic’s own body is never written', () => {
  it('two decisions on one epic both stay done and decided; the second changes nothing on the first', async () => {
    const epicBody = 'The export capability, in the requester’s words.';
    const epic = await create({ kind: 'epic', title: 'Exports', descriptionMd: epicBody });
    const first = await create({
      parentId: epic.id,
      type: 'decision',
      executor: 'human',
      descriptionMd: DECISION,
    });
    const second = await create({
      parentId: epic.id,
      type: 'decision',
      executor: 'human',
      descriptionMd: DECISION.replace('workflow', 'less requirement'),
    });
    const third = await create({
      parentId: epic.id,
      type: 'decision',
      executor: 'human',
      descriptionMd: DECISION,
    });

    await decide(first.id, 'approve', new Date('2026-09-01T09:00:00Z'));
    const firstGate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: first.id },
    });
    await decide(second.id, 'approve', new Date('2026-09-15T09:00:00Z'));
    await decide(third.id, 'overturn');

    // The first is exactly as it was before the second was confirmed.
    expect(
      await adminDb.approvalGate.findFirstOrThrow({ where: { workItemId: first.id } }),
    ).toEqual(firstGate);
    const statuses = await adminDb.workItem.findMany({
      where: { id: { in: [first.id, second.id, third.id] } },
      select: { id: true, status: true },
    });
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [first.id]: 'done',
      [second.id]: 'done',
      [third.id]: 'cancelled',
    });

    // The epic's body is byte-identical after raise, Confirm and Overturn under it.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: epic.id } });
    expect(after.descriptionMd).toBe(epicBody);

    // THE BOUNDARY carries exactly what the gates hold, sortable by `decidedAt`.
    const subtree = await aiBoundaryService.getSubtree(fx.projectId, epic.identifier, 1, fx.ctx);
    const blocks = subtree.nodes
      .filter((node) => node.decision !== null)
      .map((node) => ({ key: node.key, ...node.decision! }))
      .sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''));
    expect(blocks.map((block) => [block.key, block.state])).toEqual([
      [first.identifier, 'confirmed'],
      [second.identifier, 'confirmed'],
      [third.identifier, 'overturned'],
    ]);
    expect(blocks[0]!.decidedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(blocks[2]!.replanOwed).toEqual(['MOTIR-6']);
  });
});

describe('the record', () => {
  it('none stamps none; an attachment stamps it, and a hard delete reads back as removed', async () => {
    const bare = await create({ type: 'decision', executor: 'human', descriptionMd: DECISION });
    const confirmedBare = await decide(bare.id, 'approve');
    expect(confirmedBare.gate.confirmedRecord).toEqual({ kind: 'none' });

    const recorded = await create({ type: 'decision', executor: 'human', descriptionMd: DECISION });
    const file = await adminDb.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ownerId,
        workItemId: recorded.id,
        source: 'panel',
        blobPathname: 'attachments/decision.md',
        mimeType: 'text/markdown',
        sizeBytes: 321,
        originalFilename: 'decision.md',
      },
    });
    const confirmed = await decide(recorded.id, 'approve');
    expect(confirmed.gate.confirmedRecord).toMatchObject({
      kind: 'attachment',
      attachmentId: file.id,
    });
    expect((await decisionConfirmationGateService.readBody(recorded.id, fx.ctx))!).toMatchObject({
      ok: true,
      port: { presentRecordIds: [file.id] },
    });

    await adminDb.attachment.delete({ where: { id: file.id } });
    // The gate row is intact, and the read no longer holds the stamped id — the band's
    // *record removed*.
    const row = await adminDb.approvalGate.findFirstOrThrow({ where: { workItemId: recorded.id } });
    expect(row.confirmedRecord).toMatchObject({ attachmentId: file.id });
    const body = await decisionConfirmationGateService.readBody(recorded.id, fx.ctx);
    expect(body).toMatchObject({ ok: true, port: { presentRecordIds: [], recordCount: 0 } });
  });
});

describe('every ApprovalGateState is handled by the decided-row fold', () => {
  function gateStates(): string[] {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const body = /enum ApprovalGateState \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    return body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => /^[a-z_]+$/.test(line));
  }

  it('reads a non-empty enum including overturned and declined, and maps exactly the DECIDED members', () => {
    const states = gateStates();
    expect(states).toContain('overturned');
    expect(states).toContain('declined');
    // `declined` is a plan gate's decision (Story MOTIR-6012 · MOTIR-6037; ADR §11.4) —
    // the plan's decline ends the question, so the decided-row fold draws it.
    const decided = new Set(['approved', 'changes_requested', 'overturned', 'declined']);
    for (const state of states) {
      const row = {
        id: 'g',
        kind: 'decision_confirmation',
        state,
        decidedAt: new Date(),
        decidedByLabel: null,
        decisionSource: 'ui',
        subjectVersion: null,
        createdAt: new Date(),
        workItem: {
          id: 'w',
          key: 1,
          identifier: 'X-1',
          title: 'T',
          kind: 'task',
          type: 'decision',
        },
        chosenOption: null,
        confirmedRecord: null,
      } as never;
      if (decided.has(state)) {
        expect(toApprovalRecordDecidedRowDto(row, null).state).toBe(state);
      } else {
        expect(() => toApprovalRecordDecidedRowDto(row, null)).toThrow(/not a decision/);
      }
    }
  });
});
