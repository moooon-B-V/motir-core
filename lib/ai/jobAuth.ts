import { verifyJobToken } from './jobToken';
import { verifyServiceBearer } from './serviceBearer';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Authenticates an incoming ai→core read-back request (the /api/internal/ai/*
// surface). Per the boundary contract §4, a read-back needs BOTH:
//   (§4a) the SERVICE bearer — `Authorization: Bearer <CORE_CALLBACK_SECRET>` —
//         proving the caller is motir-ai; and
//   (§4b) the job-scoped token — `X-Motir-Job-Token` — proving WHICH user the
//         read-back acts as, for WHICH project, for how long.
// The first answers "is this motir-ai?"; the second "acting as whom?". A
// read-back needs both to succeed. These routes are service-to-service only and
// never read a cookie session.

export const JOB_TOKEN_HEADER = 'x-motir-job-token';

export type JobAuthFailureCode = 'service_unauthorized' | 'token_invalid';

export class JobAuthError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: JobAuthFailureCode,
    detail: string,
  ) {
    super(detail);
    this.name = 'JobAuthError';
    // Both §4a and §4b failures are 401 here: a bad service bearer or a
    // missing/expired/tampered job token are all "not authenticated to call".
    // (Project-scope denial — a valid token whose project the user can't see —
    // is a 404 raised downstream by the service gate, not here.)
    this.httpStatus = 401;
  }
}

/**
 * The service-to-service caller is over the shared AI budget (Subtask 8.5.9 /
 * MOTIR-1165). Distinct from {@link JobAuthError} because it is a 429 with a
 * `Retry-After`, not a 401 — the credential was fine, the spend was not.
 *
 * Carried through the same throw path as the auth failure so the ~15
 * `/api/internal/ai/*` routes gain the limit without each growing its own
 * enforcement block; `mapJobRequestError` renders both.
 */
export class JobRateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  readonly httpStatus = 429;
  constructor(readonly response: Response) {
    super('Too many requests.');
    this.name = 'JobRateLimitedError';
  }
}

export interface JobRequestAuth {
  ctx: ServiceContext;
  projectId: string;
}

// Verify both credentials and return the acting ServiceContext + the token's
// project. Throws JobAuthError (401) on any failure. Fails CLOSED: an unset
// CORE_CALLBACK_SECRET rejects every request (the shared `verifyServiceBearer`).
export function authenticateJobRequest(req: Request): JobRequestAuth {
  if (!verifyServiceBearer(req)) {
    throw new JobAuthError('service_unauthorized', 'A valid service bearer is required.');
  }

  const token = req.headers.get(JOB_TOKEN_HEADER) ?? '';
  if (!token) {
    throw new JobAuthError('token_invalid', 'The X-Motir-Job-Token header is required.');
  }
  const claims = verifyJobToken(token);
  if (!claims) {
    throw new JobAuthError('token_invalid', 'The job token is invalid or expired.');
  }

  return {
    ctx: { userId: claims.sub, workspaceId: claims.workspaceId },
    projectId: claims.projectId,
  };
}

/**
 * `authenticateJobRequest`, then the shared AI rate limit (Subtask 8.5.9 /
 * MOTIR-1165) — what every `/api/internal/ai/*` route calls.
 *
 * Order is a contract, not a detail: AUTH runs first, so an unauthenticated
 * caller cannot spend a real workspace's budget. That mirrors the ordering
 * `/api/v1`'s wrapper pins for the same reason — otherwise anyone who learned a
 * workspace id could exhaust its ceiling without holding a credential.
 *
 * The limit keys on the token's `(workspaceId, userId)` claims rather than the
 * caller's IP: `motir-ai` calls from a handful of machines, so an IP key would
 * merge every tenant's read-backs into one bucket, and the cost these calls drive
 * belongs to a workspace anyway.
 */
export async function authenticateAndLimitJobRequest(req: Request): Promise<JobRequestAuth> {
  const auth = authenticateJobRequest(req);
  const limited = await enforceAiRateLimit(auth.ctx, 'ai:internal');
  if (limited) throw new JobRateLimitedError(limited);
  return auth;
}
