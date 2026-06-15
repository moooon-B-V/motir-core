import { timingSafeEqual } from 'node:crypto';
import { verifyJobToken } from './jobToken.js';
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

export interface JobRequestAuth {
  ctx: ServiceContext;
  projectId: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Verify both credentials and return the acting ServiceContext + the token's
// project. Throws JobAuthError (401) on any failure. Fails CLOSED: an unset
// CORE_CALLBACK_SECRET rejects every request.
export function authenticateJobRequest(req: Request): JobRequestAuth {
  const expected = process.env['CORE_CALLBACK_SECRET'];
  const header = req.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!expected || !bearer || !safeEqual(bearer, expected)) {
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
