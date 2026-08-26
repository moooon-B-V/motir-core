import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  paginateAtPosition,
  parseCollectionPageRequest,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { presentProjectRepository } from '@/lib/api/v1/projects/repositories';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';

// GET /api/v1/projects/{projectKey}/repositories (Story MOTIR-3584 · Subtask
// MOTIR-3586) — the project's repository SET, published so a PAT-authenticated
// client can learn which repositories a project has BEFORE a work item has been
// picked.
//
// The only repository-set read the product had was
// `app/api/projects/[key]/repositories/route.ts`: session-cookie authenticated,
// returning `ProjectRepoEstablishViewDto` — the establish STEP's whole read
// model, including the actor's GitHub login and every repository the workspace
// installation grants. That shape answers a different question and is not
// reachable with a token. This route does not touch it.
//
// ── The permission is `project:browse`, and that is the load-bearing choice ──
// `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`) is
// `['project:browse', 'lesson:view', 'lesson:reinforce', 'work_item:edit',
// 'comment:add', 'ai:plan']`, and `docs/decisions/token-permissions.md` §3 holds
// that set FIXED unless a card argues explicitly for widening it.
// `repository:manage` / `repository:manage_access` exist and are NOT in it —
// gating this read on one of them would ship an endpoint the single caller it is
// built for cannot call, which is the failure that constant's own comment
// records happening twice already. This card does not widen the grant; it gates
// on a key already in it, and `projectRepoSetService.listByProject` asserts
// exactly that (`inProject(…, 'browse', …)`), so the declaration and the gate
// are the same fact.
//
// ── 404, never 403 ──────────────────────────────────────────────────────────
// Both refusals arrive as the service's own `ProjectNotFoundError` → 404: a key
// in ANOTHER workspace (the read is workspace-scoped, so it finds nothing) and a
// key in THIS workspace the caller may not browse (`assertCanBrowse` raises
// `ProjectAccessDeniedError` → also 404). The same recorded rule as the sibling
// project route, for the same reason: otherwise the endpoint becomes an oracle
// for which project keys are real.
//
// ── Bounded, so paged over the SERVICE'S order ──────────────────────────────
// A project's repository set is bounded by its ARCHITECTURE — a web app plus an
// API plus a shared package is three — so the whole list is read and paged in
// memory, the same shape as `GET /api/v1/workspaces` and `.../sprints`.
//
// It pages with `paginateAtPosition`, NOT `paginateKeyset`, because the set's
// order is MEANINGFUL: `project_repository` is ordered by `position` and its
// first row is the project's PRIMARY repository (`docs/decisions/project-repository-set.md`
// §1.3). `paginateKeyset` imposes its own `(createdAt, id)` sort, which would
// silently re-order the set on the wire and make "primary first" false.
//
// ── The tie-break is the row id, over rows already in hand ──────────────────
// `projectRepoRepository.listByProject` is `ORDER BY position ASC`, and
// `position` is a FRACTIONAL INDEX with no unique constraint — `moveRow` can
// legitimately land two rows on one key, and ties under a bare `position` come
// back in an order Postgres does not promise to repeat. A cursor cannot page
// soundly over an order that can shuffle, so the route breaks the tie with the
// id — Amendment 1's permitted "ORDER BY as page addressing", over rows already
// read. The shipped read's own order is untouched.
//
// 4-layer: resolve the project, ONE service call, shape the envelope. No `db.*`,
// no `$transaction`. Rows are `presentProjectRepository`'s output — shaped field
// by field, never spread (ADR Amendment 5 §4).
export const GET = withV1Route<{ projectKey: string }>(
  { permission: 'project:browse' },
  async (ctx) => {
    const page = parseCollectionPageRequest(ctx.req, 'projectRepositories', readRowIdPosition);

    const project = await projectsService.getByKey(ctx.params.projectKey, ctx.service);
    const rows = await projectRepoSetService.listByProject(project.id, ctx.service);
    const ordered = [...rows].sort((a, b) =>
      a.position !== b.position ? a.position.localeCompare(b.position) : a.id.localeCompare(b.id),
    );

    return NextResponse.json(
      paginateAtPosition(
        ordered,
        page,
        'projectRepositories',
        (row) => row.id,
        presentProjectRepository,
      ),
    );
  },
);
