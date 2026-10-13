import 'server-only';

import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';
import type { Locale } from '@/lib/i18n/locales';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiError,
  MotirAiJobFailedError,
  MotirAiJobNotFoundError,
  MotirAiOutOfCreditsError,
  MotirAiUnauthorizedError,
  type JobView,
} from './errors';
import { getJob, submitJob, type RequestActor } from './motirAiClient';
import {
  InvalidTranslationsError,
  parseTranslations,
  type TranslateFailureReason,
  type TranslateJobInput,
  type TranslateResult,
} from './translate';
import type { Tenant } from './types';

// The motir-core end of motir-ai's `translate` job (Story MOTIR-7735 · Subtask
// MOTIR-8119): submit ONE job and wait for it inside one call, so the
// translation door branches on four typed outcomes and never on an HTTP status
// or an upstream error. It keeps nothing and bills nothing — motir-ai charges
// when the model turn runs, and a failed run leaves no charge.
//
// Polled, not streamed: a translation is a short one-shot job, as `author_bug`
// is, so `streamJob` would add a second transport for no gain.

/** How long the call waits for the job before answering `timeout`. */
export const TRANSLATE_DEADLINE_MS = 45_000;
/** The pause between two reads of the job. */
export const TRANSLATE_POLL_INTERVAL_MS = 750;

/** The seams a test replaces — every one defaults to the real thing. */
export interface TranslateClientDeps {
  submitJob: typeof submitJob;
  getJob: typeof getJob;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: TranslateClientDeps = {
  submitJob,
  getJob,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface RequestTranslationInput {
  /** Resolved by the caller (`resolveTenantOrg`) — the org that owns the project pays. */
  tenant: Tenant;
  actor: RequestActor;
  targetLanguage: Locale;
  fields: TranslateJobInput['fields'];
  deadlineMs?: number;
}

/** The short machine reason a typed boundary error fails a translation with. */
function reasonFor(err: MotirAiError): TranslateFailureReason {
  if (err instanceof MotirAiJobFailedError) return 'job_failed';
  if (err instanceof MotirAiBadRequestError || err instanceof MotirAiJobNotFoundError) {
    return 'rejected';
  }
  if (err instanceof MotirAiConfigError || err instanceof MotirAiUnauthorizedError) {
    return 'misconfigured';
  }
  // `MotirAiUnavailableError` (motir-ai's `ai_job_failed`, `rate_limited`, an
  // outage) and any newer class: retryable, never the reader's fault.
  return 'unavailable';
}

/**
 * THE ONE MAPPING from what the boundary produced to what the door sees. A
 * thrown error or a terminal job view goes in; a {@link TranslateResult} comes
 * out. The upstream detail is never copied — it can name private hosts.
 *
 * ⚠️ A flag-off org (`OrgFeatureDisabledError`, thrown by `submitJob` before
 * anything is sent) is `failed: disabled`, not a rethrow, so a switched-off
 * organisation sees the failed state rather than a server error. Anything else
 * that is not a `MotirAiError` is a programming error and is RETHROWN.
 */
export function toTranslateResult(
  outcome: { error: unknown } | { view: JobView },
  sent: TranslateJobInput['fields'],
): TranslateResult {
  if ('error' in outcome) {
    const err = outcome.error;
    if (err instanceof MotirAiOutOfCreditsError) return { status: 'no_credit' };
    if (err instanceof OrgFeatureDisabledError) return { status: 'failed', reason: 'disabled' };
    if (err instanceof MotirAiError) return { status: 'failed', reason: reasonFor(err) };
    throw err;
  }
  const { view } = outcome;
  if (view.error instanceof MotirAiOutOfCreditsError) return { status: 'no_credit' };
  if (view.status !== 'succeeded') return { status: 'failed', reason: 'job_failed' };
  try {
    return { status: 'ok', translations: parseTranslations(view.result?.translations, sent) };
  } catch (err) {
    if (err instanceof InvalidTranslationsError) {
      return { status: 'failed', reason: 'invalid_reply' };
    }
    throw err;
  }
}

/** `queued` and `running` are the only states worth waiting on; any other ends the call. */
function isTerminal(view: JobView): boolean {
  return view.status !== 'queued' && view.status !== 'running';
}

/** Read the job until it is terminal or the deadline passes; `null` means timed out. */
async function pollUntilTerminal(
  jobId: string,
  projectId: string,
  deadlineAt: number,
  deps: TranslateClientDeps,
): Promise<JobView | null> {
  for (;;) {
    const view = await deps.getJob(jobId, projectId);
    if (isTerminal(view)) return view;
    const remaining = deadlineAt - deps.now();
    if (remaining <= 0) return null;
    await deps.sleep(Math.min(TRANSLATE_POLL_INTERVAL_MS, remaining));
    // Never read again once the deadline has passed: the job is left to finish
    // on its own and its result is not read later.
    if (deps.now() >= deadlineAt) return null;
  }
}

/**
 * Ask motir-ai to translate `fields` into `targetLanguage` and wait for the
 * answer. Submits exactly ONE `translate` job; returns `ok` with one text per
 * field in the order sent, or `no_credit`, `failed` or `timeout`.
 */
export async function requestTranslation(
  input: RequestTranslationInput,
  deps: TranslateClientDeps = defaultDeps,
): Promise<TranslateResult> {
  const deadlineAt = deps.now() + (input.deadlineMs ?? TRANSLATE_DEADLINE_MS);
  const context = { translate: { targetLanguage: input.targetLanguage, fields: input.fields } };
  try {
    const { jobId } = await deps.submitJob('translate', input.tenant, context, input.actor);
    const view = await pollUntilTerminal(jobId, input.tenant.projectId, deadlineAt, deps);
    if (view === null) return { status: 'timeout' };
    return toTranslateResult({ view }, input.fields);
  } catch (error) {
    return toTranslateResult({ error }, input.fields);
  }
}
