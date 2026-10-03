// Typed errors for the motir-ai client boundary. Services catch these and the
// route layer maps the stable `code` to an HTTP status (per CLAUDE.md). They
// translate the contract's problem+json taxonomy (§5) — and the transport
// failures that sit underneath it — into motir-core typed errors, so no caller
// ever branches on a raw HTTP status or an upstream JSON shape.

import type { Problem, JobStatus, ResultEnvelope } from './types';

export abstract class MotirAiError extends Error {
  abstract readonly code: string;
}

// motir-ai is unreachable / 5xx / a transport failure — retryable, not the
// caller's fault.
export class MotirAiUnavailableError extends MotirAiError {
  readonly code = 'MOTIR_AI_UNAVAILABLE' as const;
  // `options.cause` carries the underlying transport error. It rides the
  // standard `Error.cause` — which the error monitor records as a linked
  // exception — and NOT the message, because the v1 API returns the message to
  // the caller and the cause's text names private hosts and addresses.
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`motir-ai is unavailable: ${detail}`, options);
    this.name = 'MotirAiUnavailableError';
  }
}

// Missing/invalid config (URL or service token) — a deploy misconfiguration.
export class MotirAiConfigError extends MotirAiError {
  readonly code = 'MOTIR_AI_CONFIG' as const;
  constructor(detail: string) {
    super(`motir-ai client is misconfigured: ${detail}`);
    this.name = 'MotirAiConfigError';
  }
}

// The service credential was rejected (401/403) — a misconfigured shared secret,
// never a browser-reachable condition.
export class MotirAiUnauthorizedError extends MotirAiError {
  readonly code = 'MOTIR_AI_UNAUTHORIZED' as const;
  constructor(detail: string) {
    super(`motir-ai rejected the service credential: ${detail}`);
    this.name = 'MotirAiUnauthorizedError';
  }
}

// motir-ai rejected the request envelope (400) — a bug on the core side.
export class MotirAiBadRequestError extends MotirAiError {
  readonly code = 'MOTIR_AI_BAD_REQUEST' as const;
  constructor(detail: string) {
    super(`motir-ai rejected the request: ${detail}`);
    this.name = 'MotirAiBadRequestError';
  }
}

// No such job (404).
export class MotirAiJobNotFoundError extends MotirAiError {
  readonly code = 'MOTIR_AI_JOB_NOT_FOUND' as const;
  constructor(jobId: string) {
    super(`motir-ai has no job ${jobId}`);
    this.name = 'MotirAiJobNotFoundError';
  }
}

// The org is OUT OF CREDITS (402 `out_of_credits`, motir-ai's `OutOfCreditsError`,
// src/problem.ts) — the credit gate refused a planning/generation job at balance
// ≤ 0 (its pre-flight or per-turn check; Subtask 7.2.8). This is a distinct,
// browser-reachable, NON-retryable condition: the remedy is to buy/top-up credits,
// not to retry. It carries a stable `code` so the AI-boundary paywall (Subtask
// 8.1.8) can branch the SSE terminal `error` frame to the upgrade prompt instead
// of a generic "AI unavailable" error. Kept distinct from MotirAiUnavailableError
// (which a default-mapped 402 would otherwise collapse into a bad-request).
export class MotirAiOutOfCreditsError extends MotirAiError {
  readonly code = 'MOTIR_AI_OUT_OF_CREDITS' as const;
  constructor(detail: string) {
    super(`motir-ai refused the job — out of credits: ${detail}`);
    this.name = 'MotirAiOutOfCreditsError';
  }
}

// A planning job itself failed (its terminal `error`). Carries the upstream
// problem for diagnostics.
export class MotirAiJobFailedError extends MotirAiError {
  readonly code = 'MOTIR_AI_JOB_FAILED' as const;
  constructor(
    detail: string,
    readonly problem: Problem,
  ) {
    super(`motir-ai job failed: ${detail}`);
    this.name = 'MotirAiJobFailedError';
  }
}

// ⚠️ THE TWO DEADLINES DISAGREED (Bug MOTIR-4923). A run credential motir-ai
// minted for LESS time than the container it authorizes is allowed to run is a
// contract mismatch, not a transport failure and not a scope refusal — and the
// only moment it is cheaply visible is at the mint, before a machine is billed.
// Left undetected it is invisible for the whole run and then arrives as the
// container's exit `50`, which reads as `credential_refused` and cannot be told
// apart from a genuine scope refusal without a forensic dig: on 2026-09-08 a
// container built `moooon-B-V/motir-core`'s graph for 20 min 41 s against a
// 15-minute credential and was refused at the upload, twice, for a total of
// 2 388 billable seconds that produced nothing.
//
// It is a CONFIG-class failure — the two numbers are set in two repositories and
// nothing but this check makes them one decision — so it fails LOUDLY rather
// than degrading: there is no shorter run to fall back to, and booting anyway is
// exactly what produced the fixture above.
export class CodeGraphRunCredentialTooShortError extends MotirAiError {
  readonly code = 'CODE_GRAPH_CREDENTIAL_TOO_SHORT' as const;
  constructor(
    readonly credentialExpiresAt: string,
    readonly requiredUntil: string,
  ) {
    super(
      `motir-ai minted a code-graph run credential expiring at ${credentialExpiresAt}, ` +
        `which is BEFORE this run's container deadline of ${requiredUntil} — the container ` +
        'would build its graph and then be refused at the upload. Check that motir-ai honours ' +
        "the requested `ttlSeconds` and that its ceiling covers motir-core's index timeout.",
    );
    this.name = 'CodeGraphRunCredentialTooShortError';
  }
}

// A planner-model write named a model motir-ai does not OFFER for planning
// (`PUT /v1/planner-model-settings` → `validation_error`; MOTIR-7227). Offered
// means a servable catalogue row plus a `planning`-lane rate in force, read by
// motir-ai at request time — so a model that was offered when the console page
// loaded can stop being offered before its save lands.
export class PlannerModelNotOfferedError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_NOT_OFFERED' as const;
  constructor(
    readonly model: string,
    detail?: string,
  ) {
    super(`"${model}" is not offered for planning${detail ? `: ${detail}` : ''}`);
    this.name = 'PlannerModelNotOfferedError';
  }
}

// A planner-model write whose one-token PROBE failed (`model_unreachable`, 422;
// motir-ai MOTIR-7236). Nothing was written. `reason` is the probe's own words
// (the provider key was refused, no enabled channel serves the model, a timeout).
export class PlannerModelUnreachableError extends MotirAiError {
  readonly code = 'PLANNER_MODEL_UNREACHABLE' as const;
  constructor(
    readonly model: string,
    readonly reason: string,
  ) {
    super(`"${model}" is not reachable for the planner: ${reason}`);
    this.name = 'PlannerModelUnreachableError';
  }
}

// A PLATFORM lesson read or curate named a lesson motir-ai does not have
// (`/v1/admin/lessons/:id` → `not_found`; MOTIR-1411). Its own class rather than
// the generic `not_found` mapping, which names a JOB: the console turns this one
// into the app 404 on a detail read and into "this lesson no longer exists" on
// a write.
export class PlatformLessonNotFoundError extends MotirAiError {
  readonly code = 'PLATFORM_LESSON_NOT_FOUND' as const;
  constructor(readonly lessonId: string) {
    super(`no lesson "${lessonId}"`);
    this.name = 'PlatformLessonNotFoundError';
  }
}

// A staff credit ADJUSTMENT would take the org's balance below zero
// (`POST /v1/admin/credits` → 409 `conflict` with a detail starting
// `insufficient_balance:`; MOTIR-747). A detail PREFIX, not a code — the §5 union
// is closed — so `adminWriteCredits` recognises it before the generic switch.
// Nothing was written.
export class MotirAiInsufficientBalanceError extends MotirAiError {
  readonly code = 'MOTIR_AI_INSUFFICIENT_BALANCE' as const;
  constructor(readonly detail: string) {
    super(`motir-ai refused the adjustment — it would overdraw the balance: ${detail}`);
    this.name = 'MotirAiInsufficientBalanceError';
  }
}

// Any other 409 `conflict` from a staff credit op (MOTIR-747): a `requestId`
// reused for a different amount / tier / org / kind, or an offboarded org
// (`org_erased: …`). Nothing was written. Kept distinct from
// `MotirAiBadRequestError` because it is a STATE refusal, not a malformed body.
export class MotirAiConflictError extends MotirAiError {
  readonly code = 'MOTIR_AI_CONFLICT' as const;
  constructor(readonly detail: string) {
    super(`motir-ai refused the write as a conflict: ${detail}`);
    this.name = 'MotirAiConflictError';
  }
}

// The GET /v1/jobs/:id result as the client returns it: status + result, with a
// failed job's `error` already mapped to a motir-core typed error.
export interface JobView {
  jobId: string;
  status: JobStatus;
  result: ResultEnvelope | null;
  error: MotirAiError | null;
}

// Map a problem+json (from a non-2xx response or a failed job's error) onto the
// right typed error, keyed by the contract §5 `code` (falling back to HTTP
// status class for an unrecognized code).
export function errorFromProblem(p: Problem): MotirAiError {
  switch (p.code) {
    case 'service_unauthorized':
    case 'token_expired':
    case 'token_invalid':
    case 'permission_denied':
      return new MotirAiUnauthorizedError(p.detail ?? p.title);
    case 'validation_error':
    case 'unsupported_version':
    // `model_unreachable` (422; motir-ai MOTIR-7236) — a planner-model save whose
    // probe failed. Named so a reader sees it is NOT retryable: the remedy is a
    // different model or a gateway fix. `setPlannerModel` maps it to its own
    // typed error before this generic switch is reached.
    case 'model_unreachable':
      return new MotirAiBadRequestError(p.detail ?? p.title);
    case 'not_found':
      return new MotirAiJobNotFoundError(p.jobId ?? '(unknown)');
    case 'out_of_credits':
      return new MotirAiOutOfCreditsError(p.detail ?? p.title);
    case 'rate_limited':
    case 'ai_job_failed':
    // `ai_job_abandoned` (MOTIR-3222) — the machine holding the job stopped
    // renewing its lease and motir-ai's reaper failed it. Named EXPLICITLY rather
    // than left to the 5xx fallback below, which would produce the same class by
    // accident: the point of the distinct code is that a reader of this switch
    // can see the case exists and that a resubmit is the right response to it,
    // where `ai_job_failed` means the handler ran and rejected something.
    case 'ai_job_abandoned':
    case 'internal_error':
      return new MotirAiUnavailableError(p.detail ?? p.title);
    default:
      return p.status >= 500
        ? new MotirAiUnavailableError(p.detail ?? p.title)
        : new MotirAiBadRequestError(p.detail ?? p.title);
  }
}
