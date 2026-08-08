import { Prisma, type WorkItem } from '@/generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { headPrivateBlob, mintPrivateUploadToken, putPrivateAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedAcceptanceVideoType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import {
  AcceptanceEvidenceBlobMissingError,
  AcceptanceEvidenceNotAStoryError,
  AcceptanceEvidenceNotFoundError,
  AcceptanceEvidenceNotInReviewError,
  AcceptanceEvidencePathnameError,
} from '@/lib/acceptanceEvidence/errors';
import { toAcceptanceEvidenceDto } from '@/lib/mappers/acceptanceEvidenceMappers';
import type {
  AcceptanceEvidenceChapterDTO,
  AcceptanceEvidenceDTO,
  AcceptanceEvidenceStatusDTO,
  AcceptanceUploadTargetDTO,
  AcceptanceUploadTokensDTO,
} from '@/lib/dto/acceptanceEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { projectAccessService } from '@/lib/services/projectAccessService';

/**
 * The status a story must sit in to be approved (MOTIR-1625) — the canonical
 * default-workflow key, matching how `workItemsService` names the same constant
 * for the session tools. A project whose custom workflow renamed `in_review`
 * simply cannot use the acceptance gate, which is the same honest outcome the
 * session tools give: better a clear refusal than an approval out of a status
 * nobody calls review.
 */
const IN_REVIEW_STATUS_KEY = 'in_review';

/**
 * Story-acceptance evidence — business logic (Story MOTIR-1627 · Subtask
 * MOTIR-1629). Owns the create-from-upload flow (supersede the prior current +
 * store the new video receipt), the panel read, and the status update. Reuses
 * the shipped blob pipeline + the entitlements caps for the bytes; the
 * PLAN/toggle ELIGIBILITY gate lives in MOTIR-1630 and is applied by the publish
 * routes (MOTIR-1631/1681) in FRONT of these methods — this service enforces the
 * mechanical cost bounds (allowlist, per-file, storage cap) only.
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

/**
 * Register pre-uploaded acceptance artifacts by their blob PATHNAME (MOTIR-1681)
 * — the direct-to-Blob publish path, so a large video never streams through the
 * ~4.5MB serverless body cap.
 */
export interface RecordFromPathnamesInput {
  workItemId: string;
  /** The private-store key the CI client-uploaded the video to. */
  videoPathname: string;
  /** The trace's private-store key, when captured. */
  tracePathname?: string | null;
  chapters?: AcceptanceEvidenceChapterDTO[];
  commitSha?: string | null;
  ciRunUrl?: string | null;
  producedByKey?: string | null;
}

interface ArtifactMeta {
  pathname: string;
  contentType: string;
  size: number;
  filename: string;
}

/** The private-store key prefix that scopes a story's acceptance artifacts. */
function acceptancePrefix(workspaceId: string, storyId: string): string {
  return `acceptance/${workspaceId}/${storyId}/`;
}

/** The last path segment (the stored filename) of a blob pathname. */
function blobFilename(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** Resolve + validate the acceptance target is a visible STORY (RLS-scoped). */
async function resolveStory(workItemId: string, ctx: ServiceContext): Promise<WorkItem> {
  const story = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!story) throw new AcceptanceEvidenceNotFoundError(workItemId);
  if (story.kind !== 'story') throw new AcceptanceEvidenceNotAStoryError(story.kind);
  // `work_item:edit` (Story MOTIR-2291 · Subtask MOTIR-2365) — THE SHARPEST ITEM
  // IN THE BUCKET. Both acceptance-evidence rows were labelled `existing` while
  // the SAME row's `Gate today` column read "— none —", a contradiction inside one
  // line of a `done` document. The code agreed with the second half: this resolver
  // loaded the story, checked its kind, and asked nothing about the project — so
  // `createUploadTokens`, which MINTS a pre-signed upload token against the
  // workspace's blob store, was reachable with a session and a story id alone.
  //
  // Both callers go through here, so the gate goes here: attaching acceptance
  // evidence to a story is editing that story, and the project is resolved from
  // the STORY rather than the actor's active project.
  await projectAccessService.assertPermission(story.projectId, ctx, 'work_item:edit');
  return story;
}

/** The org's per-file byte cap + org id (10 MB baseline off-cloud/unresolved). */
async function resolveCostContext(
  workspaceId: string,
): Promise<{ organizationId: string | null; perFileLimit: number }> {
  const organizationId = (await workspaceRepository.findById(workspaceId))?.organizationId ?? null;
  const perFileLimit = organizationId
    ? await entitlementsService.resolvePerFileLimitBytes(organizationId)
    : MAX_UPLOAD_BYTES;
  return { organizationId, perFileLimit };
}

/**
 * Idempotency: a CI redelivery of the SAME commit+producer is a no-op — the
 * current evidence already records it, so return it (no re-upload, no duplicate
 * history row). Null when there is no matching current evidence.
 */
async function findIdempotentExisting(
  storyId: string,
  commitSha: string | null | undefined,
  producedByKey: string | null | undefined,
  ctx: ServiceContext,
): Promise<AcceptanceEvidenceDTO | null> {
  if (!commitSha) return null;
  const existing = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(storyId, tx),
  );
  return existing &&
    existing.commitSha === commitSha &&
    existing.producedByKey === (producedByKey ?? null)
    ? toAcceptanceEvidenceDto(existing)
    : null;
}

/**
 * Supersede the prior current evidence + write the new video (+ trace)
 * Attachment rows and the evidence row, atomically in ONE withWorkspaceContext
 * transaction (binds the RLS GUC for the publish path, which has no
 * request-middleware context). Shared by both publish paths.
 */
async function persistEvidence(
  args: {
    story: WorkItem;
    video: ArtifactMeta;
    trace: ArtifactMeta | null;
    chapters: AcceptanceEvidenceChapterDTO[];
    commitSha: string | null;
    ciRunUrl: string | null;
    producedByKey: string | null;
  },
  ctx: ServiceContext,
) {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    const prior = await acceptanceEvidenceRepository.findCurrentByWorkItem(args.story.id, tx);
    if (prior) {
      await acceptanceEvidenceRepository.markSupersededByWorkItem(args.story.id, tx);
      // Unlink the superseded video + trace so the orphan-GC reclaims their
      // blobs after the safety window (one current receipt per story).
      const priorAttachmentIds = [prior.attachmentId, prior.traceAttachmentId].filter(
        (id): id is string => id !== null,
      );
      if (priorAttachmentIds.length > 0) {
        await attachmentRepository.unlinkFromWorkItem(priorAttachmentIds, tx);
      }
    }
    const attachment = await attachmentRepository.create(
      {
        workspaceId: ctx.workspaceId,
        uploaderUserId: ctx.userId,
        workItemId: args.story.id,
        source: 'acceptance_video',
        blobPathname: args.video.pathname,
        mimeType: args.video.contentType,
        sizeBytes: args.video.size,
        originalFilename: args.video.filename,
      },
      tx,
    );
    let traceAttachmentId: string | null = null;
    if (args.trace) {
      const traceAttachment = await attachmentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          uploaderUserId: ctx.userId,
          workItemId: args.story.id,
          source: 'acceptance_trace',
          blobPathname: args.trace.pathname,
          mimeType: args.trace.contentType,
          sizeBytes: args.trace.size,
          originalFilename: args.trace.filename,
        },
        tx,
      );
      traceAttachmentId = traceAttachment.id;
    }
    return acceptanceEvidenceRepository.create(
      {
        workspaceId: ctx.workspaceId,
        workItemId: args.story.id,
        attachmentId: attachment.id,
        traceAttachmentId,
        chapters: (args.chapters ?? []) as unknown as Prisma.InputJsonValue,
        status: 'pending',
        commitSha: args.commitSha,
        ciRunUrl: args.ciRunUrl,
        producedByKey: args.producedByKey,
        isCurrent: true,
      },
      tx,
    );
  });
}

export const acceptanceEvidenceService = {
  /**
   * Mint scoped CLIENT upload tokens (MOTIR-1681) so a trusted CI job uploads the
   * acceptance video (+ trace) DIRECTLY to the private store, bypassing the
   * ~4.5MB serverless body cap. Each token is bound to one exact pathname (under
   * the story's `acceptance/<ws>/<storyId>/` prefix), one contentType, and the
   * org's per-file cap. CI then registers the pathnames via `recordFromPathnames`.
   */
  async createUploadTokens(
    input: { workItemId: string; hasTrace: boolean },
    ctx: ServiceContext,
  ): Promise<AcceptanceUploadTokensDTO> {
    const story = await resolveStory(input.workItemId, ctx);
    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    const nonce = randomUUID();

    const videoPathname = `${prefix}${nonce}-acceptance.webm`;
    const video: AcceptanceUploadTargetDTO = {
      pathname: videoPathname,
      token: await mintPrivateUploadToken(videoPathname, {
        contentType: 'video/webm',
        maxBytes: perFileLimit,
      }),
      contentType: 'video/webm',
      // Tell the caller the cap it is bound by (MOTIR-1911) — otherwise the only
      // way to learn it is to exceed it and read @vercel/blob's opaque error.
      maxBytes: perFileLimit,
    };

    let trace: AcceptanceUploadTargetDTO | null = null;
    if (input.hasTrace) {
      const tracePathname = `${prefix}${nonce}-trace.zip`;
      trace = {
        pathname: tracePathname,
        token: await mintPrivateUploadToken(tracePathname, {
          contentType: 'application/zip',
          maxBytes: perFileLimit,
        }),
        contentType: 'application/zip',
        maxBytes: perFileLimit,
      };
    }
    return { video, trace };
  },

  /**
   * Register acceptance artifacts already CLIENT-uploaded to the private store
   * (MOTIR-1681), superseding the prior current evidence. The caller reports only
   * pathnames; the server (a) rejects any pathname OUTSIDE the story's acceptance
   * prefix and (b) `head`s each blob for its AUTHORITATIVE size + contentType —
   * so a lying/cross-tenant/absent pathname can never be recorded.
   */
  async recordFromPathnames(
    input: RecordFromPathnamesInput,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const story = await resolveStory(input.workItemId, ctx);

    const idempotent = await findIdempotentExisting(
      story.id,
      input.commitSha,
      input.producedByKey,
      ctx,
    );
    if (idempotent) return idempotent;

    // SECURITY: every reported pathname MUST live under this story's acceptance
    // prefix (reject an arbitrary or cross-tenant blob before any DB write).
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    if (!input.videoPathname.startsWith(prefix)) {
      throw new AcceptanceEvidencePathnameError(input.videoPathname);
    }
    if (input.tracePathname && !input.tracePathname.startsWith(prefix)) {
      throw new AcceptanceEvidencePathnameError(input.tracePathname);
    }

    // head() → the blob must EXIST (the client upload completed) and its size +
    // contentType are read from the store, never trusted from the caller.
    const videoHead = await headPrivateBlob(input.videoPathname);
    if (!videoHead) throw new AcceptanceEvidenceBlobMissingError(input.videoPathname);
    if (!isAllowedAcceptanceVideoType(videoHead.contentType)) {
      throw new UnsupportedFileTypeError(videoHead.contentType);
    }

    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);
    if (videoHead.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
    if (organizationId) {
      await entitlementsService.assertWithinStorageCap(organizationId, videoHead.size);
    }

    let trace: ArtifactMeta | null = null;
    if (input.tracePathname) {
      const traceHead = await headPrivateBlob(input.tracePathname);
      if (!traceHead) throw new AcceptanceEvidenceBlobMissingError(input.tracePathname);
      trace = {
        pathname: input.tracePathname,
        contentType: traceHead.contentType,
        size: traceHead.size,
        filename: blobFilename(input.tracePathname),
      };
    }

    const row = await persistEvidence(
      {
        story,
        video: {
          pathname: input.videoPathname,
          contentType: videoHead.contentType,
          size: videoHead.size,
          filename: blobFilename(input.videoPathname),
        },
        trace,
        chapters: input.chapters ?? [],
        commitSha: input.commitSha ?? null,
        ciRunUrl: input.ciRunUrl ?? null,
        producedByKey: input.producedByKey ?? null,
      },
      ctx,
    );
    return toAcceptanceEvidenceDto(row);
  },

  /**
   * Record a new acceptance video for a story from an in-memory File (the
   * server-proxied path — used by tests/seeds and any small-file caller),
   * superseding any prior current evidence. Blob puts happen OUTSIDE the
   * transaction (the side-effects rule); the supersede + rows commit atomically.
   */
  async recordFromUpload(
    input: RecordAcceptanceVideoInput,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const story = await resolveStory(input.workItemId, ctx);

    const idempotent = await findIdempotentExisting(
      story.id,
      input.commitSha,
      input.producedByKey,
      ctx,
    );
    if (idempotent) return idempotent;

    // MIME gate — the acceptance-scoped allowlist (video is 415 elsewhere).
    if (!isAllowedAcceptanceVideoType(input.video.type)) {
      throw new UnsupportedFileTypeError(input.video.type);
    }

    // Cost bounds — per-file + total-storage caps (both no-op off-cloud).
    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);
    if (input.video.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
    if (organizationId) {
      await entitlementsService.assertWithinStorageCap(organizationId, input.video.size);
    }

    // Blob puts OUTSIDE the transaction — PRIVATE store (MOTIR-1667).
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    const { pathname: videoPathname } = await putPrivateAttachment(
      `${prefix}${input.video.name}`,
      input.video,
      input.video.type,
    );
    let trace: ArtifactMeta | null = null;
    if (input.trace) {
      const { pathname } = await putPrivateAttachment(
        `${prefix}trace-${input.trace.name}`,
        input.trace,
        input.trace.type,
      );
      trace = {
        pathname,
        contentType: input.trace.type,
        size: input.trace.size,
        filename: input.trace.name,
      };
    }

    const row = await persistEvidence(
      {
        story,
        video: {
          pathname: videoPathname,
          contentType: input.video.type,
          size: input.video.size,
          filename: input.video.name,
        },
        trace,
        chapters: input.chapters ?? [],
        commitSha: input.commitSha ?? null,
        ciRunUrl: input.ciRunUrl ?? null,
        producedByKey: input.producedByKey ?? null,
      },
      ctx,
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
   * `changes_requested`. The evidence is stamped only once the transition
   * succeeds.
   *
   * **The in-review gate is enforced HERE, explicitly** (MOTIR-1625). It used to
   * be an accident of the transition graph — the default workflow had no
   * `in_progress → done` edge, so `updateStatus` threw for us. MOTIR-1625 adds
   * that edge (review is optional for ordinary work), so the rule now lives in the
   * service that means it: acceptance is the IN-REVIEW gate (Principle #18), and a
   * story is approved out of review, never out of `todo` or mid-implementation.
   * `request_changes` needs no such check — sending work back is only reachable
   * from review anyway, and the workflow still gates the move.
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

    if (input.decision === 'approve') {
      const story = await workItemsService.getWorkItem(input.workItemId, ctx);
      if (story.status !== IN_REVIEW_STATUS_KEY) {
        throw new AcceptanceEvidenceNotInReviewError(story.status);
      }
    }

    const storyStatus = input.decision === 'approve' ? 'done' : 'in_progress';
    await workItemsService.updateStatus(input.workItemId, storyStatus, ctx);

    const evidence = await this.setStatus(
      current.id,
      input.decision === 'approve' ? 'approved' : 'changes_requested',
      ctx,
    );
    return { evidence, storyStatus };
  },
};
