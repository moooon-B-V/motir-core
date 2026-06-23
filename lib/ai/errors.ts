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
  constructor(detail: string) {
    super(`motir-ai is unavailable: ${detail}`);
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
      return new MotirAiBadRequestError(p.detail ?? p.title);
    case 'not_found':
      return new MotirAiJobNotFoundError(p.jobId ?? '(unknown)');
    case 'out_of_credits':
      return new MotirAiOutOfCreditsError(p.detail ?? p.title);
    case 'rate_limited':
    case 'ai_job_failed':
    case 'internal_error':
      return new MotirAiUnavailableError(p.detail ?? p.title);
    default:
      return p.status >= 500
        ? new MotirAiUnavailableError(p.detail ?? p.title)
        : new MotirAiBadRequestError(p.detail ?? p.title);
  }
}
