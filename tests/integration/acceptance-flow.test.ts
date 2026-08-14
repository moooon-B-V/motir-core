import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { AcceptanceEvidenceAlreadyApprovedError } from '@/lib/acceptanceEvidence/errors';

// The story-acceptance INTEGRATION SEAM (Story MOTIR-1627 · Subtask MOTIR-1637)
// against a REAL Postgres — the assembled flow across the subtasks, not each
// method in isolation: CI publishes via the token-authed ROUTE (MOTIR-1631) →
// the panel reads the evidence back through its DTO (MOTIR-1629) → the board's
// awaiting flag (MOTIR-1636) → the gate moves the story + stamps the evidence
// (MOTIR-1634) → retention supersedes. Off-cloud (ungated) is the faithful
// integration path; the blob adapter is the one mocked external.

// The direct-to-Blob publish (MOTIR-1681): the video is already client-uploaded,
// so the register route takes pathnames + `headPrivateBlob` supplies the
// authoritative size/contentType. No bytes flow through the route.
vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    putPrivateAttachment: vi.fn(async (p: string) => ({ pathname: `${p}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
    mintPrivateUploadToken: vi.fn(async () => 'client-token'),
    headPrivateBlob: vi.fn(async () => ({ size: 2048, contentType: 'video/webm' })),
  };
});

const { POST } = await import('@/app/api/work-items/[id]/acceptance-evidence/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

async function inReviewStory(fx: WorkItemFixture) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Gate story' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

/** Register a (mock-uploaded) video by a pathname within the story's prefix. */
async function publishVia(
  token: string,
  story: { id: string; identifier: string },
  parts: {
    videoName?: string;
    chapters?: unknown;
    commitSha?: string;
    producedByKey?: string;
  } = {},
) {
  const body = {
    videoPathname: `acceptance/${fx.workspaceId}/${story.id}/${parts.videoName ?? 'run.webm'}`,
    chapters: parts.chapters,
    commitSha: parts.commitSha,
    producedByKey: parts.producedByKey,
  };
  const req = new Request(
    `http://localhost/api/work-items/${story.identifier}/acceptance-evidence`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return POST(req, { params: Promise.resolve({ id: story.identifier }) });
}

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = (
    await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'ci',
      fixedGrant: grantForLegacyScopes(['integration']),
    })
  ).token;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('story-acceptance flow (publish → read → board flag → gate → retention)', () => {
  it('CI publish → the panel reads the same evidence back through its DTO', async () => {
    const story = await inReviewStory(fx);
    const res = await publishVia(token, story, {
      chapters: [{ label: 'Open the story', tSeconds: 2 }],
      commitSha: 'deadbeefcafe',
      producedByKey: 'MOTIR-1638',
    });
    expect(res.status).toBe(201);

    // The panel's own read path — the writer output round-trips through the
    // consumer DTO unchanged (integration-seam rule).
    const panel = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(panel).not.toBeNull();
    expect(panel!.status).toBe('pending');
    expect(panel!.videoUrl).toMatch(/^\/api\/attachments\/.+\/content$/);
    expect(panel!.chapters).toEqual([{ label: 'Open the story', tSeconds: 2 }]);
    expect(panel!.commitSha).toBe('deadbeefcafe');
    expect(panel!.producedByKey).toBe('MOTIR-1638');

    // The board flag sees it awaiting.
    const awaiting = await acceptanceEvidenceService.findAwaitingIds([story.id], fx.ctx);
    expect(awaiting.has(story.id)).toBe(true);
  });

  it('Approve moves the story to done + stamps the evidence + clears the board flag', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story, {});

    const { storyStatus, evidence } = await acceptanceEvidenceService.decide(
      { workItemId: story.id, decision: 'approve' },
      fx.ctx,
    );
    expect(storyStatus).toBe('done');
    expect(evidence.status).toBe('approved');

    const persisted = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(persisted.status).toBe('done');
    expect(
      (await acceptanceEvidenceService.findAwaitingIds([story.id], fx.ctx)).has(story.id),
    ).toBe(false);
  });

  it('a second publish SUPERSEDES — one current, the old video unlinked (retention)', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story, { videoName: 'first.webm', commitSha: 'aaa' });
    await publishVia(token, story, { videoName: 'second.webm', commitSha: 'bbb' });

    const currents = await adminDb.acceptanceEvidence.count({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(currents).toBe(1);
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count({
      where: { workItemId: story.id },
    });
    expect(acceptanceEvidenceCount).toBe(2);

    // The current points at the newest commit; the superseded video is unlinked
    // (workItemId → null) so the orphan-GC reclaims it.
    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current!.commitSha).toBe('bbb');
    const unlinked = await adminDb.attachment.count({
      where: { source: 'acceptance_video', workItemId: null },
    });
    expect(unlinked).toBe(1);
  });

  // ── THE FREEZE (MOTIR-2764) ────────────────────────────────────────────────
  //
  // The regression these four hold: `markSupersededByWorkItem` carries no status
  // predicate, so before the service gate ANY publish flipped an APPROVED row
  // `isCurrent: false` and unlinked its attachments, handing the approved video's
  // bytes to the orphan-GC. The trigger was as small as a one-line fix to an
  // `acceptance*.spec.ts` — a test-only change destroying a production record.
  // Policy: docs/decisions/acceptance-receipt-lifecycle.md §2.

  it('an APPROVED receipt is FROZEN — a republish is refused and writes NOTHING', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story, { videoName: 'signed.webm', commitSha: 'aaa' });
    await acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx);
    const approved = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });

    const res = await publishVia(token, story, { videoName: 'later.webm', commitSha: 'bbb' });

    // Refused at the service boundary, by CODE — the uploader branches on this
    // rather than on the status number (MOTIR-2768).
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ACCEPTANCE_EVIDENCE_ALREADY_APPROVED');

    // The approved row is untouched: still current, still approved, same row.
    const stillCurrent = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(stillCurrent.id).toBe(approved.id);
    expect(stillCurrent.status).toBe('approved');

    // No pending replacement was inserted — the whole row set is still just the one.
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(1);

    // And its bytes are safe: the attachment is still linked, so the orphan-GC
    // (blob-first, 7-day window) never sees it. THIS is the data loss.
    expect(
      await adminDb.attachment.count({ where: { source: 'acceptance_video', workItemId: null } }),
    ).toBe(0);
    const attachment = await adminDb.attachment.findUniqueOrThrow({
      where: { id: approved.attachmentId! },
    });
    expect(attachment.workItemId).toBe(story.id);
  });

  it('a `changes_requested` receipt stays REPLACEABLE — the rule narrows, it does not stop supersede', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story, { videoName: 'first.webm', commitSha: 'aaa' });
    await acceptanceEvidenceService.decide(
      { workItemId: story.id, decision: 'request_changes' },
      fx.ctx,
    );

    // The whole point of requesting changes is that the next run should differ.
    const res = await publishVia(token, story, { videoName: 'second.webm', commitSha: 'bbb' });
    expect(res.status).toBe(201);

    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current!.commitSha).toBe('bbb');
    expect(current!.status).toBe('pending');
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(2);
  });

  it('an IDEMPOTENT redelivery of the approved commit is NOT an error — it returns the receipt', async () => {
    // The idempotency short-circuit runs BEFORE the freeze gate, and must keep
    // doing so: a CI redelivery of the same commit+producer is a no-op, not a
    // conflict. Getting this order wrong would fail a retry that changed nothing.
    const story = await inReviewStory(fx);
    await publishVia(token, story, { commitSha: 'aaa', producedByKey: 'MOTIR-1638' });
    await acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx);

    // 201, like every other success on this route — the idempotent path returns
    // the EXISTING receipt rather than a conflict. What proves it short-circuited
    // is the row set below, not the status code.
    const res = await publishVia(token, story, { commitSha: 'aaa', producedByKey: 'MOTIR-1638' });
    expect(res.status).toBe(201);

    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current!.status).toBe('approved');
    expect(await adminDb.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(1);
  });

  it('the refusal is a property of the SERVICE, so it holds for a non-CI caller too', async () => {
    // The gate is at the service boundary rather than in the uploader precisely
    // so that a future manual republish or a backfill inherits it. Drive the
    // service directly — no route, no token — and it still refuses.
    const story = await inReviewStory(fx);
    await publishVia(token, story, { videoName: 'signed.webm', commitSha: 'aaa' });
    await acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx);

    await expect(
      acceptanceEvidenceService.recordFromPathnames(
        {
          workItemId: story.id,
          videoPathname: `acceptance/${fx.workspaceId}/${story.id}/backfill.webm`,
          chapters: [],
          commitSha: 'ccc',
        },
        fx.ctx,
      ),
    ).rejects.toThrow(AcceptanceEvidenceAlreadyApprovedError);
  });

  it('a token WITHOUT the integration scope cannot publish (403)', async () => {
    const story = await inReviewStory(fx);
    const readOnly = (
      await apiTokensService.create(fx.ownerId, fx.workspaceId, {
        label: 'ro',
        fixedGrant: grantForLegacyScopes(['read']),
      })
    ).token;
    const res = await publishVia(readOnly, story, {});
    expect(res.status).toBe(403);
    const acceptanceEvidenceCount = await adminDb.acceptanceEvidence.count();
    expect(acceptanceEvidenceCount).toBe(0);
  });
});
