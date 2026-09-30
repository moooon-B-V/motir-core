import { MotirAiError } from '@/lib/ai/errors';
import { getConvention } from '@/lib/ai/motirAiClient';
import type { ReviewConventionForPrompt } from '@/lib/dispatch/reviewPromptTemplate';

// THE REVIEW PROMPT's CODING CONVENTIONS (Story MOTIR-1626 · MOTIR-6904; ADR
// `docs/decisions/hosted-agent-run.md` §8.5) — for each distinct delivery-set repository,
// the derived convention Motir holds for it, when there is one.
//
// ⚠️ READ OVER THE SERVICE CREDENTIAL, NEVER THROUGH `aiConventionService`. That is the
// `/code` page's door and it asserts `ai:configure` — a review run's attributed user is not
// a project admin and need not be one (§8.5). This reaches motir-ai's `getConvention`
// directly, keyed `owner/name` exactly as `/code` keys it (`codeContextService.ts`).
//
// ⚠️ THE CONVENTION IS OPTIONAL INPUT. Three absent cases, each `{ state: 'absent' }` and
// none of them an error: no convention recorded (`convention: null`); motir-ai not
// configured (`MotirAiConfigError`); motir-ai erroring or timing out (any other
// `MotirAiError` — `aiFetch` maps its own deadline to `MotirAiUnavailableError` — or this
// file's shorter deadline below). Anything that is NOT a `MotirAiError` propagates, so a bug
// is not hidden as "no convention" — the same containment as `readRepoConvention`
// (`app/(authed)/code/_health.ts`).
//
// It only READS: no audit, no refresh, no proposal.

/**
 * How long one repository's convention read may take before that repository is reviewed
 * without it. Shorter than `aiFetch`'s 30 s deadline because the review run is waiting on
 * this prompt; a slow motir-ai must not stall the review. The abandoned read settles on its
 * own and its result is ignored.
 */
export const REVIEW_CONVENTION_TIMEOUT_MS = 10_000;

/** motir-ai rejects `versionsLimit: 0`; only the latest convention is used, so ask for one. */
const VERSIONS_LIMIT = 1;

const TIMED_OUT = Symbol('timed-out');

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readOne(
  scope: { workspaceId: string; projectId: string },
  repoKey: string,
  timeoutMs: number,
): Promise<ReviewConventionForPrompt> {
  try {
    const surface = await withDeadline(
      getConvention({
        coreWorkspaceId: scope.workspaceId,
        coreProjectId: scope.projectId,
        repoKey,
        versionsLimit: VERSIONS_LIMIT,
      }),
      timeoutMs,
    );
    if (surface === TIMED_OUT || !surface.convention) return { repoKey, state: 'absent' };
    return {
      repoKey,
      state: 'present',
      version: surface.convention.version,
      contentMd: surface.convention.contentMd,
    };
  } catch (err) {
    if (err instanceof MotirAiError) return { repoKey, state: 'absent' };
    throw err;
  }
}

export const reviewConventionsService = {
  /**
   * One convention per DISTINCT repository in `repoKeys` (`owner/name`), in first-seen
   * order, read concurrently. Never throws a `MotirAiError`; every other error propagates.
   * `timeoutMs` exists for tests; callers take the default.
   */
  async resolveReviewConventions(
    scope: { workspaceId: string; projectId: string },
    repoKeys: readonly string[],
    timeoutMs: number = REVIEW_CONVENTION_TIMEOUT_MS,
  ): Promise<ReviewConventionForPrompt[]> {
    const distinct = [...new Set(repoKeys)];
    return Promise.all(distinct.map((repoKey) => readOne(scope, repoKey, timeoutMs)));
  },
};
