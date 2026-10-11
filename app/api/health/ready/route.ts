import { NextResponse } from 'next/server';
import { readinessService } from '@/lib/services/readinessService';

// GET /api/health/ready (Bug MOTIR-8231) — is this process warm enough to be sent
// traffic? `fly.toml`'s `[[http_service.checks]]` polls it, and Fly's proxy
// routes nothing to an `app` machine until it answers 200.
//
// ⚠️ UNAUTHENTICATED, like the other `/api/health/*` routes and for a plainer
// reason still: the caller is Fly's health checker on the private network, and it
// carries no credential. The payload is a state word and two counts about this
// process's own connection pool — no tenant, no workspace, no person.
//
// ⚠️ THE STATUS CARRIES THE VERDICT: 200 ready, 503 still warming. Fly reads
// nothing but the status code. The warm-up it triggers reads `SELECT 1` and
// writes nothing.
//
// Thin transport per CLAUDE.md: ONE service call, and the mapping to a status.

/** Never cached: a cached "ready" from another process would admit a cold one. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const readiness = readinessService.check();
  return NextResponse.json(readiness, {
    status: readiness.state === 'ready' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
