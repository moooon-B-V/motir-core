import { NextResponse } from 'next/server';
import { platformHealthService } from '@/lib/services/platformHealthService';

// GET /api/health/queue (Subtask MOTIR-3764) — the job queue's DEPTH and its
// OLDEST-PENDING AGE, readable from outside the deployment.
//
// ⚠️ UNAUTHENTICATED, AND THAT IS THE DECISION RATHER THAN AN OMISSION. The
// consumer is an external monitor whose entire job is to reach this while the
// app is degraded, and every credential it would carry is one more thing that
// can be wrong at three in the morning. What makes that safe is the PAYLOAD: two
// integers about the deployment's own background queue, no workspace, no job id,
// no tenant row and no name. The platform-health BOARD stays staff-gated — this
// route is not a widening of it, and it deliberately exposes none of its six
// signals.
//
// ⚠️ AND THE HTTP STATUS CARRIES THE VERDICT, so a monitor that reads nothing
// but the status code still works: 200 healthy, 503 stalled, 503 unreadable. A
// check configured against a body it has to parse is a check that silently stops
// meaning anything when the shape moves; a status code cannot drift.
//
// The reason it exists at all: `system.daily-health-check` is a JOB, so a wedged
// worker takes the alarm down with the thing it is meant to alarm on. This read
// asks the database directly and depends on no run
// (`docs/decisions/job-queue-foundation.md` §15.7).
//
// Thin transport per CLAUDE.md: ONE service call, and the mapping to a status.

/** Never cached. A stale reading of a stalled queue is the failure this exists to prevent. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const queue = await platformHealthService.readQueueHealth();
    return NextResponse.json(queue, {
      status: queue.state === 'healthy' ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    // ⚠️ NOT A ZERO, AND NOT A HEALTHY-LOOKING BODY. An unreadable database is
    // the loudest thing this endpoint can report, and reporting it as a
    // depth-0 healthy queue is exactly the "unreachable probe reads as a zero"
    // failure `platformHealthService`'s own header exists to prevent. There is
    // no `?? 0` here and there must never be one.
    return NextResponse.json(
      { state: 'unreadable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
