import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';

// ENTERING REVIEW ASKS AGAIN (Story MOTIR-4887 · Subtask MOTIR-5532; ADR
// `docs/decisions/approval-gates.md` §6d AMENDMENT, rule 7), against a REAL
// Postgres and the REAL publish path.
//
// It closes the hole the withdraw opens: once pulling the work back supersedes a
// gate, a card returning to review would carry no gate at all, and the guard
// would have nothing to hold it with. The end-to-end walk below is that exact
// sequence, finishing on the refusal it restores.
//
// ⚠️ ONE `vi.mock`, the same one every design-publish test takes:
// `@/lib/blob/uploader`, the one external. Nothing about the gate is stubbed.

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
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { ApprovalGatePendingError } = await import('@/lib/workItems/errors');

let fx: WorkItemFixture;
let card: WorkItem;

beforeEach(async () => {
  spyOnJobDispatch();
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Re-ask' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw it' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  // `design-result.md` AMENDMENT 4: a result is the mock plus ONE note file, and is
  // published only while an open work item is `blocked_by` the card.
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

const gatesOf = () =>
  adminDb.approvalGate.findMany({ where: { workItemId: card.id }, orderBy: { createdAt: 'asc' } });

describe('a card returning to review is asked again', () => {
  it('publish → review → pulled back → review again raises ONE new gate, and the hand move to Done is refused', async () => {
    // 1. publish → gate A awaiting.
    const evidence = await publish('v1');
    const [a] = await gatesOf();
    expect(a).toMatchObject({ state: 'awaiting', subjectId: evidence.id });

    // 2. → in_review: A is already awaiting on the current subject, so nothing new.
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
    expect(await gatesOf()).toHaveLength(1);

    // 3. → in_progress by hand: the question is withdrawn.
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
    expect((await gatesOf())[0]!.state).toBe('superseded');

    // 4. → in_review by hand: exactly one fresh awaiting gate B, same subject,
    //    routed assignee ?? reporter.
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
    const gates = await gatesOf();
    expect(gates).toHaveLength(2);
    const b = gates[1]!;
    expect(b.id).not.toBe(a!.id);
    expect(b).toMatchObject({
      state: 'awaiting',
      subjectId: a!.subjectId,
      kind: 'design_result',
      routedToId: card.assigneeId ?? card.reporterId,
    });

    // 5. → done by hand: refused, because the question is being asked again.
    await expect(workItemsService.updateStatus(card.id, 'done', fx.ctx)).rejects.toThrow(
      ApprovalGatePendingError,
    );
  });

  it('raises nothing when the current subject is already APPROVED', async () => {
    await publish('v1');
    const [a] = await gatesOf();
    await adminDb.approvalGate.update({ where: { id: a!.id }, data: { state: 'approved' } });

    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);

    expect(await gatesOf()).toHaveLength(1);
  });

  it('raises nothing when a gate is already awaiting, and no unique violation reaches the caller', async () => {
    await publish('v1');

    await expect(workItemsService.updateStatus(card.id, 'in_review', fx.ctx)).resolves.toBeTruthy();

    const gates = await gatesOf();
    expect(gates).toHaveLength(1);
    expect(gates[0]!.state).toBe('awaiting');
  });

  it('a concurrent double raise on the same subject is absorbed — one awaiting row, both calls succeed', async () => {
    const evidence = await publish('v1');
    const [a] = await gatesOf();
    await adminDb.approvalGate.update({ where: { id: a!.id }, data: { state: 'superseded' } });
    const fresh = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    const results = await Promise.allSettled([
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGatesService.raiseOnReviewEntry(fresh, fx.ctx, tx),
      ),
      withWorkspaceContext(fx.ctx, (tx) =>
        approvalGatesService.raiseOnReviewEntry(fresh, fx.ctx, tx),
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const awaiting = (await gatesOf()).filter((g) => g.state === 'awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.subjectId).toBe(evidence.id);
  });

  // ⚠️ REVERSED — MOTIR-5662 (AMENDMENT 6 Q1), reversing MOTIR-5534 (AMENDMENT 4
  // Q8). This test pinned the re-ask's half of the old suppression: an open pull
  // request meant no design gate, here as at the publish, so the two ends of the
  // rule agreed. They did agree — on a rule that left the card holding no question
  // at all. Both ends are corrected together, for the same reason they had to match.
  it('raises the design gate on a card WITH an open pull request — a link is not an answer (MOTIR-5662)', async () => {
    await publish('v1');
    const [a] = await gatesOf();
    await adminDb.approvalGate.update({ where: { id: a!.id }, data: { state: 'superseded' } });
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-${card.id}`,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: `repo-${card.id}`,
        owner: 'acme',
        name: 'web',
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 5,
        title: 'd',
        state: 'open',
        headRef: 'h',
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: card.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(card.id, 'in_review', fx.ctx, tx, { system: true }),
    );

    const awaiting = (await gatesOf()).filter((g) => g.state === 'awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.kind).toBe('design_result');
  });

  it('raises nothing on an item with no current design result', async () => {
    await workItemsService.updateStatus(card.id, 'in_review', fx.ctx);
    expect(await gatesOf()).toHaveLength(0);
  });

  it('a SYSTEM move into review raises one when the subject has no live gate', async () => {
    await publish('v1');
    const [a] = await gatesOf();
    await adminDb.approvalGate.update({ where: { id: a!.id }, data: { state: 'superseded' } });

    await withWorkspaceContext(fx.ctx, (tx) =>
      workItemsService.applyStatusTransition(card.id, 'in_review', fx.ctx, tx, { system: true }),
    );

    const awaiting = (await gatesOf()).filter((g) => g.state === 'awaiting');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.subjectId).toBe(a!.subjectId);
  });
});
