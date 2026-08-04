import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  paginateAtPosition,
  parseCollectionPageRequest,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { presentSprint } from '@/lib/api/v1/sprints/schema';
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
