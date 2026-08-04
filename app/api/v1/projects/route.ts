import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import {
  paginateAtPosition,
  parseCollectionPageRequest,
  readRowIdPosition,
} from '@/lib/api/v1/pagination';
import { presentProject } from '@/lib/api/v1/projects/schema';
import { projectsService } from '@/lib/services/projectsService';

// GET /api/v1/projects (Story 11.3 · Subtask 11.3.3 — MOTIR-2060) — the entry
// point of the whole planning journey. A client holding a PAT knows its
// workspace and nothing about what is in it; every other path in 11.2 and 11.3
// is scoped by a `projectKey` this endpoint returns.
//
// ── The read already owns the access rules ──────────────────────────────────
// `listProjects` asserts membership, then applies the Story 6.4 browse gate: a
// `private` project the token owner is not a member of is filtered OUT, and
// archived rows never appear. So a project the caller cannot browse is simply
// absent — never shown-then-denied, and never a 403 that would confirm it
// exists.
//
// ── Paged IN MEMORY, deliberately ───────────────────────────────────────────
// This is a workspace's own project list — bounded by how many projects a team
// runs, the same shape as `GET /api/v1/workspaces`, not the 1800-row work-item
// collection that forced a database window in 11.2.3.
//
// ── …but NOT through `paginateKeyset` ───────────────────────────────────────
// That pager imposes its own `(createdAt, id)` sort, and `ProjectDTO.createdAt`
// is optional and deliberately NOT loaded on this path (`lib/dto/projects.ts`
// records why) — so it cannot even satisfy `Keyed`. This is the collection that
// forced ADR Amendment 3's generalized cursor, and 11.3.2 is the primitive.
//
// ── ORDERED BY KEY, and that is a correctness requirement ───────────────────
// The shipped read orders by `created_at ASC` with NO tiebreaker
// (`projectRepository.findByWorkspace`), which is fine for a switcher rendering
// the whole list at once and NOT fine to page over: two projects created in the
// same millisecond have an order Postgres does not promise to repeat, so a page
// boundary could land differently between two requests and a client walking the
// cursors would skip or duplicate a row — the exact defect §5's keyset rule
// exists to prevent. The v1 route therefore sorts the already-read, bounded list
// into a TOTAL order it owns: `key` ascending, which is unique by construction
// (a project's identifier is uniquely constrained) and is the value the client
// actually pages toward.
//
// This is Amendment 1's permitted "a different ORDER BY, where the ordering is
// the page addressing", applied to rows already in hand: no new predicate, no
// new gate, no new field, and the shipped read's own order is untouched for the
// web app that depends on it.
export const GET = withV1Route({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading: a bad cursor or limit is the caller's to fix, and
  // answering 422 without touching the database is both faster and honest.
  const page = parseCollectionPageRequest(ctx.req, 'projects', readRowIdPosition);

  const projects = await projectsService.listProjects(ctx.workspaceId, ctx.userId);
  const ordered = [...projects].sort((a, b) => a.identifier.localeCompare(b.identifier, 'en'));

  // The POSITION is the row id — internal, and it stays internal: it is signed
  // into an opaque cursor and never appears in a response body (ADR §7). The id
  // rather than the key because a key can be RETIRED and re-minted (Story 6.8),
  // and a cursor should name the row, not a name the row currently answers to.
  return NextResponse.json(
    paginateAtPosition(ordered, page, 'projects', (project) => project.id, presentProject),
  );
});
