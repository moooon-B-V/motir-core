import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// The story-acceptance INTEGRATION SEAM (Story MOTIR-1627 · Subtask MOTIR-1637)
// against a REAL Postgres — the assembled flow across the subtasks, not each
// method in isolation: CI publishes via the token-authed ROUTE (MOTIR-1631) →
// the panel reads the evidence back through its DTO (MOTIR-1629) → the board's
// awaiting flag (MOTIR-1636) → the gate moves the story + stamps the evidence
// (MOTIR-1634) → retention supersedes. Off-cloud (ungated) is the faithful
// integration path; the blob adapter is the one mocked external.

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { POST } = await import('@/app/api/work-items/[id]/acceptance-evidence/route');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const video = (name = 'run.webm') => new File([new Uint8Array(2048)], name, { type: 'video/webm' });

async function inReviewStory(fx: WorkItemFixture) {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Gate story' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  return story;
}

async function publishVia(
  token: string,
  identifier: string,
  parts: { video: File; chapters?: unknown; commitSha?: string; producedByKey?: string },
) {
  const form = new FormData();
  form.set('video', parts.video);
  if (parts.chapters) form.set('chapters', JSON.stringify(parts.chapters));
  if (parts.commitSha) form.set('commitSha', parts.commitSha);
  if (parts.producedByKey) form.set('producedByKey', parts.producedByKey);
  const req = new Request(`http://localhost/api/work-items/${identifier}/acceptance-evidence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return POST(req, { params: Promise.resolve({ id: identifier }) });
}

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  token = (
    await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'ci',
      scopes: ['integration'],
    })
  ).token;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('story-acceptance flow (publish → read → board flag → gate → retention)', () => {
  it('CI publish → the panel reads the same evidence back through its DTO', async () => {
    const story = await inReviewStory(fx);
    const res = await publishVia(token, story.identifier, {
      video: video(),
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
    expect(panel!.videoUrl).toContain('vercel-storage.com');
    expect(panel!.chapters).toEqual([{ label: 'Open the story', tSeconds: 2 }]);
    expect(panel!.commitSha).toBe('deadbeefcafe');
    expect(panel!.producedByKey).toBe('MOTIR-1638');

    // The board flag sees it awaiting.
    const awaiting = await acceptanceEvidenceService.findAwaitingIds([story.id], fx.ctx);
    expect(awaiting.has(story.id)).toBe(true);
  });

  it('Approve moves the story to done + stamps the evidence + clears the board flag', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story.identifier, { video: video() });

    const { storyStatus, evidence } = await acceptanceEvidenceService.decide(
      { workItemId: story.id, decision: 'approve' },
      fx.ctx,
    );
    expect(storyStatus).toBe('done');
    expect(evidence.status).toBe('approved');

    const persisted = await db.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(persisted.status).toBe('done');
    expect(
      (await acceptanceEvidenceService.findAwaitingIds([story.id], fx.ctx)).has(story.id),
    ).toBe(false);
  });

  it('a second publish SUPERSEDES — one current, the old video unlinked (retention)', async () => {
    const story = await inReviewStory(fx);
    await publishVia(token, story.identifier, { video: video('first.webm'), commitSha: 'aaa' });
    await publishVia(token, story.identifier, { video: video('second.webm'), commitSha: 'bbb' });

    const currents = await db.acceptanceEvidence.count({
      where: { workItemId: story.id, isCurrent: true },
    });
    expect(currents).toBe(1);
    expect(await db.acceptanceEvidence.count({ where: { workItemId: story.id } })).toBe(2);

    // The current points at the newest commit; the superseded video is unlinked
    // (workItemId → null) so the orphan-GC reclaims it.
    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current!.commitSha).toBe('bbb');
    const unlinked = await db.attachment.count({
      where: { source: 'acceptance_video', workItemId: null },
    });
    expect(unlinked).toBe(1);
  });

  it('a token WITHOUT the integration scope cannot publish (403)', async () => {
    const story = await inReviewStory(fx);
    const readOnly = (
      await apiTokensService.create(fx.ownerId, fx.workspaceId, { label: 'ro', scopes: ['read'] })
    ).token;
    const res = await publishVia(readOnly, story.identifier, { video: video() });
    expect(res.status).toBe(403);
    expect(await db.acceptanceEvidence.count()).toBe(0);
  });
});
