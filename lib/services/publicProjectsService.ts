import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { triageService, type TriageSubmissionKind } from '@/lib/services/triageService';
import { toPublicRequestMatchDto } from '@/lib/mappers/publicProjectsMappers';
import {
  MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH,
  PublicProjectIntakeUnavailableError,
  PublicRequestDescriptionTooLongError,
  PublicSubmissionRateLimitedError,
} from '@/lib/publicProjects/errors';
import type { PublicDuplicateMatchesDto, PublicRequestMatchDto } from '@/lib/dto/publicProjects';
import type { TriageSubmissionResultDto } from '@/lib/dto/triage';

// publicProjectsService — the WRITE/read entry points a PUBLIC project exposes
// to any signed-in account, cross-org included (Story 6.12). Subtask 6.12.5
// lands the first two: the cross-account "submit a request" path (reusing the
// 6.11.4 triage intake — no second submissions table) and the deterministic
// duplicate-detection pre-check (Canny's "upvote this instead"). The two
// remaining public writes — upvote + comment — land in 6.12.6 on top of the
// same gate.
//
// Addressing: a public project is reached by its GLOBAL project id (ADR §2.2 —
// the workspace-scoped "PROD" identifier collides across workspaces, so the
// public surface keys off the id), and the access gate is the dedicated
// public-read path (`projectAccessService.assertCanSubmitToTriage`), the SINGLE
// place the org/workspace boundary is crossed. Every method here REQUIRES a
// signed-in `actorUserId` (sign-in-to-act — the route gates the session); only
// the WRITES are restricted, READ of a public project is anonymous (6.12.4).
//
// Attribution (the 6.11.4 seam): a cross-org submitter is NOT a workspace
// member, but `createWorkItem` requires the reporter to be one
// (`assertReporterMember`). So the submission is attributed with the project's
// workspace OWNER as the `reporterId` (the deterministic "intake reporter") and
// the real cross-org account as `submittedByUserId` — exactly what
// `CreateTriageSubmissionInput.submittedByUserId` and `createWorkItem`'s triage
// branch were built to carry. (NOTE: docs/decisions/public-projects.md §6's
// table says `reporterId` = the cross-org account directly; that conflicts with
// the shipped `assertReporterMember` member gate, so the shipped code wins
// per the decision-authority ladder — see the PR body's ADR-discrepancy flag.)

// How many duplicate candidates the pre-check surfaces (bounded — never
// load-all; the UI shows the top matches as "upvote this instead").
const DUPLICATE_MATCH_LIMIT = 5;

// Per-account submission throttle (the ADR §6 abuse guard for an
// internet-facing write). In-memory sliding window keyed by the submitting
// account — same shape as `attachmentsService`'s upload throttle, and the same
// caveat: it is PER-PROCESS (pre-Epic-8), a first-line abuse guard, not a
// distributed rate limiter. A real edge/Redis limiter is a later hardening.
const SUBMISSION_RATE_LIMIT = 5;
const SUBMISSION_RATE_WINDOW_MS = 10 * 60_000; // 10 minutes
const submissionLog = new Map<string, number[]>();

/**
 * Throttle a submitting account: throw {@link PublicSubmissionRateLimitedError}
 * when it has already made {@link SUBMISSION_RATE_LIMIT} submissions inside the
 * window, otherwise record this attempt. Mirrors `attachmentsService`'s
 * `checkRateLimit`.
 */
function checkSubmissionRateLimit(userId: string): void {
  const now = Date.now();
  const recent = (submissionLog.get(userId) ?? []).filter(
    (t) => now - t < SUBMISSION_RATE_WINDOW_MS,
  );
  if (recent.length >= SUBMISSION_RATE_LIMIT) {
    const oldest = recent[0]!;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + SUBMISSION_RATE_WINDOW_MS - now) / 1000),
    );
    throw new PublicSubmissionRateLimitedError(retryAfterSeconds);
  }
  recent.push(now);
  submissionLog.set(userId, recent);
}

export const publicProjectsService = {
  /**
   * Duplicate-detection pre-check (Subtask 6.12.5) — given a draft title, return
   * the matching EXISTING active public requests so the UI can offer "upvote
   * this instead" before a dupe is created (Canny's core behaviour). Gated by
   * `canSubmitToTriage` (a signed-in actor on a PUBLIC project; a non-public
   * project reads as 404, no existence leak). Deterministic (a tokenised title
   * match over the project's public requests — NOT an AI call; AI dedupe is an
   * Epic-7 enhancement) and bounded. A blank draft short-circuits to no
   * candidates.
   */
  async findDuplicateRequests(
    projectId: string,
    actorUserId: string,
    draftTitle: string,
  ): Promise<PublicDuplicateMatchesDto> {
    const title = draftTitle.trim();
    if (title.length === 0) return { candidates: [] };

    // The gate: a non-public project is 404 (no existence leak); the grant is
    // true for any signed-in account on a public project. The route has already
    // ensured a session, so `actorUserId` is a real account.
    await projectAccessService.assertCanSubmitToTriage(projectId, actorUserId);

    const rows = await workItemRepository.findPublicRequestMatches(
      projectId,
      title,
      DUPLICATE_MATCH_LIMIT,
    );
    const candidates: PublicRequestMatchDto[] = rows.map(toPublicRequestMatchDto);
    return { candidates };
  },

  /**
   * Submit a request into a PUBLIC project's triage (Subtask 6.12.5) — the
   * cross-account "report a bug / request a feature" path. Reuses the 6.11.4
   * intake authority (`triageService.createSubmission` → `workItemsService`):
   * the submission is born a triage `work_item` (kind `bug`/`task`), EXCLUDED
   * from every normal read until an admin promotes it, attributed to the
   * submitting cross-org account via `submittedByUserId` while the project's
   * workspace owner stands in as the (member) `reporterId`. Gated by
   * `canSubmitToTriage` (NOT `canEdit`); rate-limited + size-capped (an
   * internet-facing write). Returns the thin submission confirmation.
   */
  async submitPublicRequest(
    projectId: string,
    submitterUserId: string,
    input: { kind: TriageSubmissionKind; title: string; descriptionMd?: string | null },
  ): Promise<TriageSubmissionResultDto> {
    // Size cap (the abuse guard; the title bound + the kind are validated by
    // `createSubmission` downstream).
    if (
      typeof input.descriptionMd === 'string' &&
      input.descriptionMd.length > MAX_PUBLIC_REQUEST_DESCRIPTION_LENGTH
    ) {
      throw new PublicRequestDescriptionTooLongError();
    }

    // Gate FIRST (a non-public project / denied grant rejects before any quota
    // is consumed), then throttle the legit public submitter.
    await projectAccessService.assertCanSubmitToTriage(projectId, submitterUserId);
    checkSubmissionRateLimit(submitterUserId);

    // Resolve the project row for its workspace + identifier (the gate proved it
    // exists and is public). The intake reporter is the workspace OWNER — a
    // guaranteed member who passes `createWorkItem`'s `assertReporterMember`.
    const project = await projectRepository.findById(projectId);
    if (!project) throw new PublicProjectIntakeUnavailableError(projectId);
    const owner = await workspaceMembershipRepository.findOwnerByWorkspace(project.workspaceId);
    if (!owner) throw new PublicProjectIntakeUnavailableError(projectId);

    // Reuse the shared triage-create authority. `ctx` carries the intake
    // reporter (owner — a member); `submittedByUserId` carries the real
    // cross-org submitter (the 6.11.4 seam).
    return triageService.createSubmission(
      {
        projectKey: project.identifier,
        kind: input.kind,
        title: input.title,
        descriptionMd: input.descriptionMd ?? null,
        submittedByUserId: submitterUserId,
      },
      { userId: owner.userId, workspaceId: project.workspaceId },
    );
  },
};
