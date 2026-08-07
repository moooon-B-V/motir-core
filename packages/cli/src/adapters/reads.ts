import type { SuccessBody } from '../transport.js';
import type { ProjectList, ProjectSummary, WhoamiResult } from '../mcpClient.js';

// The READ ADAPTERS — wire shapes in, the CLI's own view models out
// (Story 11.5 · Subtask 11.5.4 — MOTIR-2212).
//
// ⚠️ THIS MODULE AND `src/transport.ts` ARE THE ONLY FILES THAT MAY SEE A
// GENERATED WIRE TYPE. That is `docs/decisions/cli-v1-client.md` Q4, and
// `tests/cli/generated-api-freshness.test.ts` enforces it over the real import
// graph rather than by review.
//
// ── Why an adapter layer exists at all ──────────────────────────────────────
// The two surfaces genuinely disagree about shape. MCP handed back a nested
// aggregate with a `parent`, an `ancestors` array of full summaries and three
// separate edge arrays; v1 hands back a flat item, a list of ancestor KEYS and
// one grouped `links` object. Both are reasonable. Neither can be swapped for
// the other in place, so something must translate — and the whole safety
// property of this story is that the something is ONE named module instead of a
// hundred small accommodations spread through `render.ts`.
//
// `render.ts` does not change. A diff on it fails this card. Every disagreement
// between the surfaces therefore has to surface HERE, where a test can see it.
//
// ── The rule these functions follow ─────────────────────────────────────────
// A view-model field with no reader is DROPPED, never fabricated from a value
// the wire did not send. This slice drops a project's `id` and `slug`, each
// verified by grep across `packages/cli/src` to have no consumer. Inventing a
// plausible-looking value would have been the easy path and would have put a lie
// one layer below every renderer.
//
// ── It grows one SLICE at a time ────────────────────────────────────────────
// This module arrives with the IDENTITY mappers. `listReady` / `listSprints`
// (11.5.21) and the detail + activity reshapes (11.5.22) add theirs here rather
// than defining a second boundary — one module is the whole point.

/** `GET /api/v1/me`'s body. */
type MeBody = SuccessBody<'getMe'>;
/** `GET /api/v1/workspaces`'s body. */
type WorkspacesBody = SuccessBody<'listWorkspaces'>;
/** One page of `GET /api/v1/projects`. */
type ProjectsBody = SuccessBody<'listProjects'>;

/** One row of a paged body, with the envelope's optional `items` resolved. */
type RowOf<B extends { items?: unknown[] }> = NonNullable<B['items']>[number];

/**
 * The rows a paged body carries.
 *
 * The generated envelope types `items` as optional because the page envelope and
 * the item schema compose through `allOf`; the server always sends it.
 */
function rowsOf<B extends { items?: unknown[] }>(body: B): RowOf<B>[] {
  return (body.items ?? []) as RowOf<B>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `whoami` — the token's user, plus the ONE workspace it is bound to.
 *
 * Two reads rather than one, because v1 splits them: `/me` names the workspace
 * by id and `/workspaces` describes it. The workspace is found BY THAT ID and
 * not assumed to be the first row — a user belongs to as many workspaces as they
 * belong to, and the token is bound to exactly one of them.
 *
 * `null` when the bound workspace is not in the list, which is the answer the
 * MCP tool gave too: a client that cannot see the workspace renders no
 * workspace, rather than a wrong one.
 */
export function toWhoami(me: MeBody, workspaces: WorkspacesBody): WhoamiResult {
  const bound = rowsOf(workspaces).find((workspace) => workspace.id === me.workspaceId);
  return {
    user: { id: me.user.id, name: me.user.name, email: me.user.email },
    workspace: bound ? { id: bound.id, name: bound.name, slug: bound.slug } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One project row.
 *
 * `id` and `slug` are DROPPED, not sourced: no file in `packages/cli/src` reads
 * either, and both are deliberately absent from the v1 project resource — `id`
 * by ADR §7, `slug` because nothing addresses a project by it. Carrying a
 * made-up value forward would freeze two dead fields into the CLI's contract.
 */
export function toProjectSummary(project: RowOf<ProjectsBody>): ProjectSummary {
  return { key: project.key, name: project.name, accessLevel: project.accessLevel };
}

/** A whole project list, assembled from every page the caller walked. */
export function toProjectList(pages: readonly ProjectsBody[]): ProjectList {
  const projects: ProjectSummary[] = [];
  for (const page of pages) projects.push(...rowsOf(page).map(toProjectSummary));
  return { projects };
}
