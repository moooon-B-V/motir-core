import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  paginateAtPosition,
  parseCollectionPageRequest,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { createSprintBodySchema, presentSprint } from '@/lib/api/v1/sprints/schema';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';

// GET /api/v1/projects/{projectKey}/sprints (Story 11.3 · Subtask 11.3.4 —
// MOTIR-2061) — a project's whole cadence: every sprint with its state, window,
// goal, live issue count and activation baseline.
//
// This is also the endpoint that answers "what is the ACTIVE sprint?". No
// separate `/sprints/active` path is added: the row already carries `state`, and
// a second endpoint returning a subset of this one is a second thing to keep
// correct — and the one that would be wrong after a lifecycle move.
//
// ── A read, not an admin operation ──────────────────────────────────────────
// `listByProject` is open to any project member; the sprint-admin gate guards
// sprint MANAGEMENT writes (11.3.5 / 11.3.6), not reads. The route declares
// `read` accordingly.
//
// ── Bounded, so paged in memory ─────────────────────────────────────────────
// A project's sprints are a CADENCE — a team runs tens of them, not thousands —
// and `listByProject` already fans out one bounded count per sprint. Same shape
// as `GET /api/v1/workspaces` and `GET /api/v1/projects`.
//
// ── The order is `(sequence, id)`, not `sequence` alone ─────────────────────
// `sprintRepository.listByProject` orders by `sequence ASC`, and `sequence` has
// NO unique constraint — `createSprint`'s `maxSequence + 1` is a read that
// guards a write, so two concurrent creates on one project can land the same
// ordinal (the service records this). Ties under a bare `sequence` ORDER BY come
// back in an order Postgres does not promise to repeat, and a cursor cannot page
// soundly over an order that can shuffle: a page boundary would move between two
// requests and a client walking the cursors would skip or duplicate a row. The
// route therefore breaks the tie with the row id, over rows already in hand —
// Amendment 1's permitted "ORDER BY as page addressing". The shipped read's own
// order is untouched.
export const GET = withV1Route<{ projectKey: string }>({ scope: 'read' }, async (ctx) => {
  const page = parseCollectionPageRequest(ctx.req, 'sprints', readRowIdPosition);

  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
  const sprints = await sprintsService.listByProject(project.id, ctx.service);
  const ordered = [...sprints].sort((a, b) =>
    a.sequence !== b.sequence ? a.sequence - b.sequence : a.id.localeCompare(b.id),
  );

  return NextResponse.json(
    paginateAtPosition(ordered, page, 'sprints', (sprint) => sprint.id, presentSprint),
  );
});

// POST /api/v1/projects/{projectKey}/sprints (Story 11.3 · Subtask 11.3.5 —
// MOTIR-2062) — create a PLANNED sprint. The first `sprints:write` operation.
//
// A SECOND export in this module, reusing the GET's project resolution rather
// than re-deriving it, and declaring its OWN scope — the ADR's §3 map is per
// OPERATION, not per resource, and the shipped guard catches a POST that
// bypasses the wrapper even when a sibling GET does not.
//
// ── TWO gates, and the second is the surprising one ─────────────────────────
// `sprints:write` is the SCOPE. `createSprint` additionally calls
// `assertSprintAdmin` and raises `NotSprintAdminError` → 403 with the DISTINCT
// `NOT_SPRINT_ADMIN` code, because a token carrying the scope is still refused
// when its OWNER is an ordinary project member: a scope narrows the owner's role
// and never widens it (ADR §3). Sharing `INSUFFICIENT_SCOPE` would leave an
// integrator re-issuing tokens forever against a problem no token can fix.
//
// ── The service owns date validation ────────────────────────────────────────
// `parseNullableDate` + `assertWindow` decide whether a date parses and whether
// `endDate` ≥ `startDate`. The route forwards the strings. Re-checking here
// would be a second implementation of one rule — the first place the API and the
// product start disagreeing about what a valid sprint window is.
export const POST = withV1Route<{ projectKey: string }>({ scope: 'sprints:write' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, createSprintBodySchema);
  const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);

  const created = await sprintsService.createSprint(
    project.id,
    // Only the keys the caller actually SUPPLIED: `exactOptionalPropertyTypes`
    // makes `{ goal: undefined }` and `{}` different types, and the service
    // distinguishes absent from null, so a wholesale spread would turn every
    // omitted field into an explicit `undefined`.
    pickSupplied(body, ['name', 'goal', 'startDate', 'endDate']),
    ctx.service,
  );

  ctx.responseHeaders.set('Location', `/api/v1/sprints/${created.id}`);
  return NextResponse.json(presentSprint(created), { status: 201 });
});

/** Copy only the keys a caller actually supplied — see the POST's note. */
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
