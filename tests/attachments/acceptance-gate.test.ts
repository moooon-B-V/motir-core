import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// acceptanceEvidenceService.decide — the acceptance GATE (Story MOTIR-1627 ·
// Subtask MOTIR-1634) against a REAL Postgres. Approve/Request-changes move BOTH
// the story (via the workflow) and the evidence; the workflow enforces the legal
// edge. Blob is the one mocked external.

vi.mock('@/lib/blob/uploader', () => {
  let seq = 0;
  return {
    putAttachment: vi.fn(async (p: string) => ({
      url: `https://store1.public.blob.vercel-storage.com/${p}-${++seq}`,
    })),
    deleteAttachmentBlob: vi.fn(async () => {}),
  };
});

const { acceptanceEvidenceService } = await import('@/lib/services/acceptanceEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const video = () => new File([new Uint8Array(1024)], 'run.webm', { type: 'video/webm' });

async function makeStory(fx: WorkItemFixture) {
  // The real create path so the story gets the project's initial workflow status
  // (todo), which the todo→in_progress→in_review edges then move.
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Gate story' },
    fx.ctx,
  );
}

async function storyWithEvidence(fx: WorkItemFixture, status: 'in_review' | 'in_progress') {
  const story = await makeStory(fx);
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  if (status === 'in_review') await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  await acceptanceEvidenceService.recordFromUpload(
    { workItemId: story.id, video: video() },
    fx.ctx,
  );
  return story;
}

const statusKeyOf = async (id: string): Promise<string> => {
  const row = await db.workItem.findUniqueOrThrow({ where: { id } });
  return row.status;
};

let fx: WorkItemFixture;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('acceptanceEvidenceService.decide', () => {
  it('approve → story in_review → done + evidence approved (stamped)', async () => {
    const story = await storyWithEvidence(fx, 'in_review');
    const { evidence, storyStatus } = await acceptanceEvidenceService.decide(
      { workItemId: story.id, decision: 'approve' },
      fx.ctx,
    );
    expect(storyStatus).toBe('done');
    expect(evidence.status).toBe('approved');
    expect(evidence.approvedById).toBe(fx.ownerId);
    expect(await statusKeyOf(story.id)).toBe('done');
  });

  it('request_changes → story in_review → in_progress + evidence changes_requested', async () => {
    const story = await storyWithEvidence(fx, 'in_review');
    const { evidence, storyStatus } = await acceptanceEvidenceService.decide(
      { workItemId: story.id, decision: 'request_changes' },
      fx.ctx,
    );
    expect(storyStatus).toBe('in_progress');
    expect(evidence.status).toBe('changes_requested');
    expect(evidence.approvedById).toBeNull();
    expect(await statusKeyOf(story.id)).toBe('in_progress');
  });

  it('approve when the story is NOT in_review is rejected by the workflow — no stamp', async () => {
    const story = await storyWithEvidence(fx, 'in_progress'); // in_progress has no → done edge
    await expect(
      acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx),
    ).rejects.toBeTruthy();
    // The evidence was NOT stamped and the story did NOT move.
    expect(await statusKeyOf(story.id)).toBe('in_progress');
    const current = await acceptanceEvidenceService.getCurrentForStory(story.id, fx.ctx);
    expect(current!.status).toBe('pending');
  });

  it('decide with no current evidence → not found', async () => {
    const story = await makeStory(fx);
    await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
    await expect(
      acceptanceEvidenceService.decide({ workItemId: story.id, decision: 'approve' }, fx.ctx),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_EVIDENCE_NOT_FOUND' });
  });
});
