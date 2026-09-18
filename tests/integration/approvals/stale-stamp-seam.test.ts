import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { shaFor } from '../../helpers/commitShaFixtures';
import { ensureWorkWaitsOn } from '../../helpers/designWaits';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY'S SEAM — a STALE RESULT CANNOT BE APPROVED (Story MOTIR-5232 · Subtask
// MOTIR-5236), against a REAL Postgres and the REAL doors on both sides.
//
// The stamp card's units write the moved inputs straight into the rows, which proves the
// comparison and nothing about the product. This suite takes the stamp from the real read,
// changes the card through the doors a person actually uses — a republish through
// `designEvidenceService`, an edit through `workItemsService.updateWorkItem`, a label and a
// watcher through their own services — and only then calls the real decide door. A mock
// of the edit would test this file's own arrangement.
//
// What it holds in place, and why each one is worth its own assertion:
//
//   · a republish answers SUPERSEDED and a criteria edit answers STALE, in ONE suite, so
//     the two refusals cannot drift into one — the difference is an ORDERING in `decide`;
//   · a refusal writes NOTHING: the gate row is read back field by field;
//   · the same stamp in means the decision lands, with its effect — otherwise a stuck
//     door would pass for a working guard;
//   · fields nobody was deciding about never move the stamp. A guard that refuses on an
//     assignee change trains people to retry past it;
//   · the read and the door hold ONE definition: a stamp from the read is accepted by the
//     door after every edit it must ignore, which it could not be if the two computed it
//     differently.
//
// ONE narrow mock: `@/lib/blob/uploader`, the one external, so a publish's authoritative
// size/type read is answerable (the disposition `tests/approval-gate-retention.test.ts`
// records). Nothing touching the database is mocked.

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { labelsService } = await import('@/lib/services/labelsService');
const { watchersService } = await import('@/lib/services/watchersService');
const { ApprovalGateStaleSubjectError, ApprovalGateSupersededError } =
  await import('@/lib/approvalGates/errors');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Approve a design' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Draw the frame',
      descriptionMd: '## Acceptance criteria\n\n- the frame is drawn',
    },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Publish one design version through the REAL publish path — which raises the gate. */
async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  await ensureWorkWaitsOn(card.id, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

/** What the frame is handed: the real read, exactly as the overlay and the item page ask it. */
async function read() {
  const gateRead = await approvalGatesService.getForWorkItem(
    { workItemId: card.id, kind: 'design_result' },
    fx.ctx,
  );
  expect(gateRead.gate?.state).toBe('awaiting');
  return { gateId: gateRead.gate!.id, stamp: gateRead.stamp! };
}

async function expectUntouched(gateId: string) {
  const row = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
  expect(row.decidedById).toBeNull();
  expect(row.decidedAt).toBeNull();
  expect(row.decidedByLabel).toBeNull();
  expect(row.decidedUnderAuthority).toBeNull();
  expect(row.decisionSource).toBeNull();
  expect(row.outcomeRef).toBeNull();
  // …and no retention pin was taken on the design it was about.
  const pinned = await adminDb.designEvidence.count({
    where: { workItemId: card.id, pinnedAt: { not: null } },
  });
  expect(pinned).toBe(0);
  return row;
}

describe('read → a REAL edit in another transaction → decide', () => {
  it('a REPUBLISH answers SUPERSEDED — the state refusal runs first — and writes nothing', async () => {
    await publish('v1');
    const shown = await read();
    await publish('v2');

    await expect(
      approvalGatesService.decide(
        { gateId: shown.gateId, decision: 'approve', source: 'ui', stamp: shown.stamp },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    const row = await expectUntouched(shown.gateId);
    expect(row.state).toBe('superseded');
  });

  it('an ACCEPTANCE-CRITERIA edit through the real door answers STALE naming `criteria` — no republish involved', async () => {
    await publish('v1');
    const shown = await read();
    await workItemsService.updateWorkItem(
      card.id,
      { descriptionMd: '## Acceptance criteria\n\n- the frame is drawn, and in zh' },
      fx.ctx,
    );

    const refusal = await approvalGatesService
      .decide(
        { gateId: shown.gateId, decision: 'approve', source: 'ui', stamp: shown.stamp },
        fx.ctx,
      )
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect((refusal as InstanceType<typeof ApprovalGateStaleSubjectError>).moved).toEqual([
      'criteria',
    ]);
    const row = await expectUntouched(shown.gateId);
    expect(row.state).toBe('awaiting');
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'in_review',
    );
  });

  it('the two refusals are DIFFERENT answers, side by side', async () => {
    await publish('v1');
    const criteria = await read();
    await workItemsService.updateWorkItem(card.id, { descriptionMd: 'edited' }, fx.ctx);
    const stale = await approvalGatesService
      .decide(
        { gateId: criteria.gateId, decision: 'approve', source: 'ui', stamp: criteria.stamp },
        fx.ctx,
      )
      .catch((err: { tag?: string }) => err.tag);

    await publish('v2');
    const withdrawn = await approvalGatesService
      .decide(
        { gateId: criteria.gateId, decision: 'approve', source: 'ui', stamp: criteria.stamp },
        fx.ctx,
      )
      .catch((err: { tag?: string }) => err.tag);

    expect([stale, withdrawn]).toEqual(['APPROVAL_GATE_STALE_SUBJECT', 'APPROVAL_GATE_SUPERSEDED']);
  });

  it('after the current version is re-read, the SAME door takes the fresh stamp and the decision lands with its effect', async () => {
    await publish('v1');
    const shown = await read();
    await workItemsService.updateWorkItem(card.id, { descriptionMd: 'edited' }, fx.ctx);
    await expect(
      approvalGatesService.decide(
        { gateId: shown.gateId, decision: 'approve', source: 'ui', stamp: shown.stamp },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateStaleSubjectError);

    const current = await read();
    expect(current.stamp).not.toBe(shown.stamp);
    const result = await approvalGatesService.decide(
      { gateId: current.gateId, decision: 'approve', source: 'ui', stamp: current.stamp },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
    // The design gate's effect: an approval with no pull request is terminal.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'done',
    );
  });
});

describe('what nobody was deciding about never moves the stamp', () => {
  it('assignee, a label, a watcher and the status — each through its own door where one exists — and the decision still lands', async () => {
    await publish('v1');
    const shown = await read();

    const other = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: other.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await workItemsService.updateWorkItem(card.id, { assigneeId: fx.ownerId }, fx.ctx);
    expect((await read()).stamp).toBe(shown.stamp);
    await labelsService.addLabel(card.id, 'frontend', fx.ctx);
    expect((await read()).stamp).toBe(shown.stamp);
    await watchersService.watch(card.id, fx.ctx);
    expect((await read()).stamp).toBe(shown.stamp);
    // The status is HELD by the awaiting gate on every interactive door (§6d), so it is
    // moved here directly: the question is whether the STAMP reads it, and it must not.
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'blocked' } });
    expect((await read()).stamp).toBe(shown.stamp);
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_review' } });

    // ONE definition: the stamp the read handed out before all of that is the one the door
    // recomputes under its lock after it — or this press would be refused.
    const result = await approvalGatesService.decide(
      { gateId: shown.gateId, decision: 'approve', source: 'ui', stamp: shown.stamp },
      fx.ctx,
    );
    expect(result.gate.state).toBe('approved');
  });
});
