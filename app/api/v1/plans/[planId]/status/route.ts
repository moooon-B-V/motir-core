import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentPlanOutcome } from '@/lib/api/v1/workLoop/schema';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';

// GET /api/v1/plans/{planId}/status (Story 11.7 · Subtask 11.7.5 — MOTIR-2239)
// — what became of a submitted planning job.
//
// ── A SUB-RESOURCE, not a field on the plan ─────────────────────────────────
// ADR Amendment 6 Q1: this is a different read against a different source.
// `getOutcome` reaches motir-ai for the JOB's liveness, which the plan row alone
// cannot report. Folding it into `GET /api/v1/plans/{planId}` would make every
// proposal read pay for a cross-service probe and couple a pure read's failure
// modes to motir-ai's availability.
//
// ── ALIVE vs DEAD is the whole point of this endpoint ───────────────────────
// A failed job leaves its plan at `generating` FOREVER — nothing writes a
// terminal plan state on failure — so a client polling `status` alone would wait
// on it indefinitely. `job` carries the distinction: `reachable: false` means
// motir-ai could not be asked (the plan read still succeeded, so the block
// degrades rather than failing the answer), and a non-null `failure` on a
// reachable job means it DIED and nothing more will arrive on this plan.
//
// ── Addressed by `planId` only ──────────────────────────────────────────────
// The MCP tool also accepts a `jobId`; v1 does not mirror that, because every v1
// operation that starts a job returns BOTH ids in its handle, so a client
// holding a job id holds a plan id. A narrower ADDRESS, not a narrower
// capability — adding the job address later is additive under §8.

export const GET = withV1Route<{ planId: string }>({ scope: 'read' }, async (ctx) => {
  const outcome = await aiPlanEditsService.getOutcome({ planId: ctx.params.planId }, ctx.service);
  return NextResponse.json(presentPlanOutcome(outcome));
});
