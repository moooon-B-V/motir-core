import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentSprint } from '@/lib/api/v1/sprints/schema';
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
