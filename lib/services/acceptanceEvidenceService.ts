import { Prisma } from '@prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { putAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedAcceptanceVideoType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import {
  AcceptanceEvidenceNotAStoryError,
  AcceptanceEvidenceNotFoundError,
} from '@/lib/acceptanceEvidence/errors';
import { toAcceptanceEvidenceDto } from '@/lib/mappers/acceptanceEvidenceMappers';
import type {
  AcceptanceEvidenceChapterDTO,
  AcceptanceEvidenceDTO,
  AcceptanceEvidenceStatusDTO,
} from '@/lib/dto/acceptanceEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * Story-acceptance evidence — business logic (Story MOTIR-1627 · Subtask
 * MOTIR-1629). Owns the create-from-upload flow (supersede the prior current +
 * store the new video receipt), the panel read, and the status update. Reuses
 * the shipped blob pipeline (`putAttachment`) + the entitlements caps for the
 * bytes; the PLAN/toggle ELIGIBILITY gate lives in MOTIR-1630 and is applied by
 * the publish route (MOTIR-1631) in FRONT of `recordFromUpload` — this service
 * enforces the mechanical cost bounds (allowlist, per-file, storage cap) only.
 */
export interface RecordAcceptanceVideoInput {
  /** The STORY this evidence accepts. */
  workItemId: string;
  /** The recorded acceptance video (webm/mp4 — the acceptance-scoped allowlist). */
  video: File;
  /** Chapter markers `[{ label, tSeconds }]`; omitted → no markers. */
  chapters?: AcceptanceEvidenceChapterDTO[];
  /** The Playwright trace blob (dev diagnostic), when captured. */
  trace?: File | null;
  commitSha?: string | null;
  ciRunUrl?: string | null;
  /** The E2E subtask key that produced the video (e.g. "MOTIR-1638"). */
  producedByKey?: string | null;
}

export const acceptanceEvidenceService = {
  /**
   * Record a new acceptance video for a story, superseding any prior current
   * evidence. Blob puts happen OUTSIDE the transaction (the side-effects rule);
   * the supersede + Attachment row + evidence row commit atomically inside one
   * withWorkspaceContext transaction (binds the RLS GUC for the publish path,
   * which has no request-middleware context).
   */
  async recordFromUpload(
    input: RecordAcceptanceVideoInput,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    // 1. Resolve + validate the story (RLS-scoped read).
    const story = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(input.workItemId, tx),
    );
    if (!story) throw new AcceptanceEvidenceNotFoundError(input.workItemId);
    if (story.kind !== 'story') throw new AcceptanceEvidenceNotAStoryError(story.kind);

    // 1b. Idempotency — a CI redelivery of the SAME commit+producer is a no-op:
    //     the current evidence already records it, so return it without a second
    //     blob upload or a duplicate history row.
    if (input.commitSha) {
      const existing = await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(story.id, tx),
      );
      if (
        existing &&
        existing.commitSha === input.commitSha &&
        existing.producedByKey === (input.producedByKey ?? null)
      ) {
        return toAcceptanceEvidenceDto(existing);
      }
    }

    // 2. MIME gate — the acceptance-scoped allowlist (video is 415 elsewhere).
    if (!isAllowedAcceptanceVideoType(input.video.type)) {
      throw new UnsupportedFileTypeError(input.video.type);
    }

    // 3. Cost bounds — per-file + total-storage caps (org resolved up from the
    //    workspace; both no-op off-cloud, 10 MB baseline when unresolved).
    const organizationId =
      (await workspaceRepository.findById(ctx.workspaceId))?.organizationId ?? null;
    const perFileLimit = organizationId
      ? await entitlementsService.resolvePerFileLimitBytes(organizationId)
      : MAX_UPLOAD_BYTES;
    if (input.video.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
    if (organizationId) {
      await entitlementsService.assertWithinStorageCap(organizationId, input.video.size);
    }

    // 4. Blob puts OUTSIDE the transaction.
    const { url: videoUrl } = await putAttachment(
      `acceptance/${ctx.workspaceId}/${story.id}/${input.video.name}`,
      input.video,
      input.video.type,
    );
    let traceUrl: string | null = null;
    if (input.trace) {
      traceUrl = (
        await putAttachment(
          `acceptance/${ctx.workspaceId}/${story.id}/trace-${input.trace.name}`,
          input.trace,
          input.trace.type,
        )
      ).url;
    }

    // 5. Supersede + insert, atomically.
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const prior = await acceptanceEvidenceRepository.findCurrentByWorkItem(story.id, tx);
        if (prior) {
          await acceptanceEvidenceRepository.markSupersededByWorkItem(story.id, tx);
          // Unlink the superseded video so the orphan-GC reclaims its blob after
          // the safety window (retention: one current video per story).
          if (prior.attachmentId) {
            await attachmentRepository.unlinkFromWorkItem([prior.attachmentId], tx);
          }
        }
        const attachment = await attachmentRepository.create(
          {
            workspaceId: ctx.workspaceId,
            uploaderUserId: ctx.userId,
            workItemId: story.id,
            source: 'acceptance_video',
            blobUrl: videoUrl,
            mimeType: input.video.type,
            sizeBytes: input.video.size,
            originalFilename: input.video.name,
          },
          tx,
        );
        return acceptanceEvidenceRepository.create(
          {
            workspaceId: ctx.workspaceId,
            workItemId: story.id,
            attachmentId: attachment.id,
            traceUrl,
            chapters: (input.chapters ?? []) as unknown as Prisma.InputJsonValue,
            status: 'pending',
            commitSha: input.commitSha ?? null,
            ciRunUrl: input.ciRunUrl ?? null,
            producedByKey: input.producedByKey ?? null,
            isCurrent: true,
          },
          tx,
        );
      },
    );

    return toAcceptanceEvidenceDto(row);
  },

  /**
   * The subset of `workItemIds` awaiting acceptance — a current `pending`
   * evidence (Story MOTIR-1627 · Subtask MOTIR-1636). Batched (one query) for the
   * board projection; empty input short-circuits.
   */
  async findAwaitingIds(workItemIds: string[], ctx: ServiceContext): Promise<Set<string>> {
    if (workItemIds.length === 0) return new Set();
    const ids = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => acceptanceEvidenceRepository.findPendingWorkItemIds(workItemIds, tx),
    );
    return new Set(ids);
  },

  /** The current acceptance evidence for a story, as a DTO (null if none yet). */
  async getCurrentForStory(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    );
    return row ? toAcceptanceEvidenceDto(row) : null;
  },

  /**
   * Set the acceptance status of one evidence row. `approved` stamps the actor
   * + timestamp (the audit trail behind the `in_review → done` gate the panel /
   * gate-transition card drives); any other status clears the stamp.
   */
  async setStatus(
    evidenceId: string,
    status: AcceptanceEvidenceStatusDTO,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const existing = await acceptanceEvidenceRepository.findById(evidenceId, tx);
        if (!existing) throw new AcceptanceEvidenceNotFoundError(evidenceId);
        const approved = status === 'approved';
        return acceptanceEvidenceRepository.updateStatus(
          evidenceId,
          {
            status,
            approvedById: approved ? ctx.userId : null,
            approvedAt: approved ? new Date() : null,
          },
          tx,
        );
      },
    );
    return toAcceptanceEvidenceDto(row);
  },

  /**
   * The acceptance GATE (Story MOTIR-1627 · Subtask MOTIR-1634). A reviewer's
   * decision on the current evidence moves BOTH the story and the evidence:
   * **approve** → story `in_review → done` + evidence `approved` (stamped);
   * **request_changes** → story `in_review → in_progress` + evidence
   * `changes_requested`. The story transition runs FIRST through
   * `workItemsService.updateStatus`, so the workflow enforces the legal edge (a
   * story that is not `in_review` has no `→ done` edge and is rejected there);
   * the evidence is stamped only once the transition succeeds.
   */
  async decide(
    input: { workItemId: string; decision: 'approve' | 'request_changes' },
    ctx: ServiceContext,
  ): Promise<{ evidence: AcceptanceEvidenceDTO; storyStatus: 'done' | 'in_progress' }> {
    const current = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(input.workItemId, tx),
    );
    if (!current) throw new AcceptanceEvidenceNotFoundError(input.workItemId);

    const storyStatus = input.decision === 'approve' ? 'done' : 'in_progress';
    // The gate: the workflow rejects an illegal edge (e.g. approve when the story
    // is not in_review — there is no in_progress/todo → done edge).
    await workItemsService.updateStatus(input.workItemId, storyStatus, ctx);

    const evidence = await this.setStatus(
      current.id,
      input.decision === 'approve' ? 'approved' : 'changes_requested',
      ctx,
    );
    return { evidence, storyStatus };
  },
};
