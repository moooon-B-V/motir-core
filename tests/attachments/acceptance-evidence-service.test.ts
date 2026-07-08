import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// acceptanceEvidenceService (Story MOTIR-1627 · Subtask MOTIR-1629) against a
// REAL Postgres. The Blob adapter is the ONE mocked external (no network); every
// gate + the supersede/RLS write go through the real path. Under test the `db`
// role bypasses RLS, so direct reads assert committed state.

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (pathname: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${pathname}-${++seq}`,
    })),
    putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname: `${pathname}-${++seq}` })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { attachmentRepository } = await import('@/lib/repositories/attachmentRepository');

const videoOf = (name = 'run.webm', type = 'video/webm', bytes = 1024) =>
  new File([new Uint8Array(bytes)], name, { type });

async function makeStory(fx: WorkItemFixture) {
  return createTestWorkItem(fx, { kind: 'story', title: 'Acceptance story' });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('acceptanceEvidenceService.recordFromUpload', () => {
  it('records a video → pending evidence + linked acceptance_video attachment + provenance', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);

    const dto = await acceptanceEvidenceService.recordFromUpload(
      {
        workItemId: story.id,
        video: videoOf(),
        chapters: [{ label: 'Open the story', tSeconds: 2 }],
        commitSha: 'abc1234',
        ciRunUrl: 'https://ci.example/run/1',
        producedByKey: 'MOTIR-1638',
      },
      fx.ctx,
    );

    expect(dto.status).toBe('pending');
    expect(dto.workItemId).toBe(story.id);
    expect(dto.videoUrl).toContain('/api/attachments/');
    expect(dto.mimeType).toBe('video/webm');
    expect(dto.sizeBytes).toBe(1024);
    expect(dto.chapters).toEqual([{ label: 'Open the story', tSeconds: 2 }]);
    expect(dto.commitSha).toBe('abc1234');
    expect(dto.ciRunUrl).toBe('https://ci.example/run/1');
    expect(dto.producedByKey).toBe('MOTIR-1638');
    expect(dto.approvedById).toBeNull();

    // The Attachment is source acceptance_video, LINKED to the story (so the
    // orphan-GC leaves the current video alone).
    const att = await db.attachment.findFirstOrThrow({ where: { workItemId: story.id } });
    expect(att.source).toBe('acceptance_video');
    expect(att.workItemId).toBe(story.id);

    // Exactly one current evidence row.
    const current = await db.acceptanceEvidence.count({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(current).toBe(1);
  });

  it('a second upload SUPERSEDES the prior — one current, old video unlinked (GC-eligible)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);

    const first = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: videoOf('first.webm') },
      fx.ctx,
    );
    const second = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: videoOf('second.webm') },
      fx.ctx,
    );

    expect(second.id).not.toBe(first.id);

    // Invariant: exactly one current, and it's the newest.
    const currents = await db.acceptanceEvidence.findMany({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(currents).toHaveLength(1);
    expect(currents[0]!.id).toBe(second.id);

    // History retained (two rows total).
    expect(await db.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(2);

    // The superseded video Attachment is UNLINKED (workItemId → null) so the
    // orphan-GC reclaims its blob; the new one stays linked.
    const firstEvidence = await db.acceptanceEvidence.findUniqueOrThrow({
      where: { id: first.id },
    });
    const firstAtt = await db.attachment.findUniqueOrThrow({
      where: { id: firstEvidence.attachmentId! },
    });
    expect(firstAtt.workItemId).toBeNull();
    expect(second.videoUrl).not.toBe(first.videoUrl);
  });

  it('a non-video MIME → UnsupportedFileTypeError (415), no evidence written', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    await expect(
      acceptanceEvidenceService.recordFromUpload(
        { workItemId: story.id, video: videoOf('shot.png', 'image/png') },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE', status: 415 });
    expect(await db.acceptanceEvidence.count()).toBe(0);
    expect(await db.attachment.count()).toBe(0);
  });

  it('an oversized video → FileTooLargeError (413), no evidence written', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const big = videoOf('big.webm', 'video/webm', 11 * 1024 * 1024); // > 10 MB baseline
    await expect(
      acceptanceEvidenceService.recordFromUpload({ workItemId: story.id, video: big }, fx.ctx),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });

  it('recording against a NON-story → AcceptanceEvidenceNotAStoryError (422)', async () => {
    const fx = await makeWorkItemFixture();
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'A bug' });
    await expect(
      acceptanceEvidenceService.recordFromUpload({ workItemId: bug.id, video: videoOf() }, fx.ctx),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_EVIDENCE_NOT_A_STORY', status: 422 });
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });

  it('the acceptance video is EXCLUDED from the generic attachments panel listing', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: videoOf() },
      fx.ctx,
    );

    // The panel read (and its count) never surface the acceptance video.
    const listed = await attachmentRepository.listByWorkItem(story.id);
    expect(listed).toHaveLength(0);
    expect(await attachmentRepository.countByWorkItem(story.id)).toBe(0);
  });
});

describe('acceptanceEvidenceService.getCurrentForStory / setStatus', () => {
  it('getCurrentForStory returns null before any video, then the current DTO', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);

    expect(await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx)).toBeNull();

    await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: videoOf() },
      fx.ctx,
    );
    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current).not.toBeNull();
    expect(current!.videoUrl).toContain('/api/attachments/');
  });

  it('setStatus approved stamps approver + timestamp; changes_requested clears them', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeStory(fx);
    const evidence = await acceptanceEvidenceService.recordFromUpload(
      { workItemId: story.id, video: videoOf() },
      fx.ctx,
    );

    const approved = await acceptanceEvidenceService.setStatus(evidence.id, 'approved', fx.ctx);
    expect(approved.status).toBe('approved');
    expect(approved.approvedById).toBe(fx.ownerId);
    expect(approved.approvedAt).not.toBeNull();

    const reopened = await acceptanceEvidenceService.setStatus(
      evidence.id,
      'changes_requested',
      fx.ctx,
    );
    expect(reopened.status).toBe('changes_requested');
    expect(reopened.approvedById).toBeNull();
    expect(reopened.approvedAt).toBeNull();
  });

  it('setStatus on a missing evidence id → AcceptanceEvidenceNotFoundError (404)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      acceptanceEvidenceService.setStatus('cmnonexistent00000000000', 'approved', fx.ctx),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_EVIDENCE_NOT_FOUND', status: 404 });
  });
});

describe('generic upload allowlist stays unchanged', () => {
  it('a video via the generic editor/panel upload is STILL rejected (415)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      attachmentsService.uploadAttachment(videoOf(), {
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE', status: 415 });
  });
});
