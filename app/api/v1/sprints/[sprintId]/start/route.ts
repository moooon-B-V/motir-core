import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentSprint, startSprintBodySchema } from '@/lib/api/v1/sprints/schema';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { sprintsService } from '@/lib/services/sprintsService';

// POST /api/v1/sprints/{sprintId}/start (Story 11.3 · Subtask 11.3.6 —
// MOTIR-2063) — activate a planned sprint.
//
// An ACTION as a sub-path of the resource, matching
// `POST /api/v1/work-items/{key}/archive` (11.2.10) rather than inventing a new
// verb convention for the second story that needs one.
//
// ── ⚠️ The concurrency guard is SHIPPED. This route must not rebuild it ─────
// `startSprint` closes the TOCTOU window itself: a friendly
// `findActiveByProject` pre-check 409s early (before a board is provisioned, so
// the common already-running case leaves no orphan), and the AUTHORITATIVE guard
// is `findActiveByProjectForUpdate` — a `SELECT … FOR UPDATE` on the project's
// active sprint INSIDE the activation transaction — with the
// `sprint_one_active_per_project` partial-unique index as the DB backstop.
//
// So this route parses, calls ONE service method, and returns. A check-then-write
// guard here would be BOTH redundant and racy: it would read outside the
// transaction that does the writing, which is the exact shape
// `motir-core/CLAUDE.md`'s concurrency rule forbids. What this card owes is the
// PROOF at the HTTP boundary — two simultaneous starts, one 200 and one typed
// 409 — and that proof is a test, not code.
//
// ── Two shipped side effects the API INHERITS ───────────────────────────────
//   • A scrum board is provisioned idempotently when the project has none,
//     deliberately outside the activation transaction. v1 does not add, move or
//     suppress it.
//   • The IMMUTABLE baseline (`committedIssueCount` / `committedPoints`) is
//     stamped from the sprint's issues at activation. After this call those
//     fields stop being null — the observable difference between a planned and a
//     started sprint on every read in this story.
//
// `sprints:write` AND sprint-admin gated, exactly as the write pair: a token
// carrying the scope is still refused `NOT_SPRINT_ADMIN` when its owner is an
// ordinary member (ADR §3).
export const POST = withV1Route<{ sprintId: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, startSprintBodySchema);
  const started = await sprintsService.startSprint(
    ctx.params.sprintId,
    pickSupplied(body, ['name', 'goal', 'startDate', 'endDate']),
    ctx.service,
  );
  return NextResponse.json(presentSprint(started));
});

/** Copy only the keys a caller actually supplied — the absent/null tri-state. */
function pickSupplied<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
