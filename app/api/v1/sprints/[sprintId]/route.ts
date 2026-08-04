import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentSprint, updateSprintBodySchema } from '@/lib/api/v1/sprints/schema';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { sprintsService } from '@/lib/services/sprintsService';

// GET /api/v1/sprints/{sprintId} (Story 11.3 · Subtask 11.3.4 — MOTIR-2061) —
// one sprint, addressed by the id the sprint list hands out.
//
// ── The service read this rides was ADDED by this card ──────────────────────
// `sprintsService` shipped with no by-id DTO read at all, and the nearest method
// is a trap: `getActiveSprint` returns `toSprintDto(row, 0)`, so an endpoint
// built on it would report `issueCount: 0` for every sprint — present,
// well-typed and wrong. `sprintsService.getById` computes the count the way
// `listByProject` does, so this endpoint and the list agree about the same
// sprint. Added under the by-id re-presentation carve-out ADR Amendment 3 (Q3)
// records.
//
// ── 404, never 403 ──────────────────────────────────────────────────────────
// `getById` is `workspaceId`-gated, so a sprint in another tenant raises the
// same `SprintNotFoundError` as one that never existed. A 403 would confirm the
// sprint exists — the existence oracle ADR §4 forbids.
export const GET = withV1Route<{ sprintId: string }>({ scope: 'read' }, async (ctx) => {
  const sprint = await sprintsService.getById(ctx.params.sprintId, ctx.service);
  return NextResponse.json(presentSprint(sprint));
});

// PATCH /api/v1/sprints/{sprintId} (Story 11.3 · Subtask 11.3.5 — MOTIR-2062) —
// rename a sprint, edit its goal, adjust its planned window.
//
// ── On the RESOURCE path, not the collection ────────────────────────────────
// The edit addresses ONE sprint, so it lives at `/sprints/{sprintId}` rather
// than as a `PATCH` on the project's sprint collection: §7's rule is that an
// identifier in a path names the resource, and 11.2 placed
// `PATCH /api/v1/work-items/{key}` beside its collection `POST` for the same
// reason. Create stays on the collection, where the project scopes it.
//
// ── The tri-state is the contract ───────────────────────────────────────────
// `updateSprint` reads `patch.goal !== undefined` to decide whether to touch the
// column, so an ABSENT key leaves the field alone, an explicit `null` CLEARS it,
// and a value sets it. `pickSupplied` preserves that: spreading the parsed body
// would turn every omitted field into an explicit `undefined` and blur exactly
// the distinction the schema drew.
//
// Two gates, as on create: `sprints:write` AND `assertSprintAdmin`
// (`NOT_SPRINT_ADMIN` → 403, a code distinct from a missing scope). A sprint in
// another workspace raises `SprintNotFoundError` → 404, never 403.
export const PATCH = withV1Route<{ sprintId: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, updateSprintBodySchema);
  const updated = await sprintsService.updateSprint(
    ctx.params.sprintId,
    pickSupplied(body, ['name', 'goal', 'startDate', 'endDate']),
    ctx.service,
  );
  return NextResponse.json(presentSprint(updated));
});

/**
 * Copy only the keys a caller actually SUPPLIED.
 *
 * `exactOptionalPropertyTypes` makes `{ goal: undefined }` and `{}` different
 * types, and the service distinguishes absent (leave alone) from null (clear).
 */
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
