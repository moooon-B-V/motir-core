import { type Prisma, type Project } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectKeyAliasRepository } from '@/lib/repositories/projectKeyAliasRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';

/** A project resolved from a key, plus whether the key was a RETIRED alias. */
export interface ResolvedProjectByKey {
  project: Project;
  /**
   * `true` when `key` matched a retired `project_key_alias` row rather than the
   * project's live `identifier`. Callers branch on it: the REST routes SERVE
   * either way (old keys just work — the DTO carries the canonical identifier),
   * while the issue pages 308-REDIRECT to the canonical URL when it's an alias.
   */
  viaAlias: boolean;
}

/**
 * THE single alias-aware project-by-key resolver (Story 6.8 · Subtask 6.8.2) —
 * the READ counterpart to projectsService's live-only `resolveProjectByKeyInTx`
 * (which the admin WRITE path deliberately keeps alias-blind: you change a key
 * on the live project, never via an old one). Every key-addressed READ funnels
 * through here, so alias resolution lives in exactly ONE place — no per-route
 * alias queries (the 6.8.2 contract).
 *
 * Resolution order, inside the caller's transaction:
 *
 *   1. **Live identifier** — the hot path: a single project-row point read on
 *      the `@@unique([workspaceId, identifier])` key, with NO alias query when
 *      the key is current. The agent-dispatch / `getByKey` perf contract from
 *      6.8.1 ("a single project-row fetch with no alias join") is preserved —
 *      the alias table is touched only on a live miss.
 *   2. **Alias fallback** — only when the live lookup misses: one extra point
 *      read on the SAME workspace-scoped key space (`project_key_alias` shares
 *      the `@@unique([workspaceId, identifier])` namespace `project.identifier`
 *      is unique within). Each alias row maps DIRECTLY to its project, so
 *      chained renames (PROD→NIF→ZAP) resolve every retired key FLAT in one
 *      hop — no chain-walking.
 *
 * No existence leak (PRODECT_FINDINGS #26): a key naming a project in ANOTHER
 * workspace, a never-existed key, and a RELEASED alias (its row is gone) are
 * all indistinguishable from a missing project — each throws
 * `ProjectNotFoundError`, which the route maps to 404. The access gate
 * (assertCanBrowse) is the CALLER's job, applied after resolution, so this
 * function stays a pure id-resolution leaf.
 *
 * The `key` is upper-cased before lookup: identifiers are canonical uppercase,
 * so `prod` resolves the same row as `PROD` (and can't be ambiguous — two
 * identifiers can't differ only by case under the unique constraint).
 */
export async function resolveProjectByKeyWithAliasInTx(
  key: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<ResolvedProjectByKey> {
  const identifier = key.trim().toUpperCase();

  const live = await projectRepository.findByIdentifier(workspaceId, identifier, tx);
  if (live) return { project: live, viaAlias: false };

  const alias = await projectKeyAliasRepository.findByWorkspaceAndIdentifier(
    workspaceId,
    identifier,
    tx,
  );
  if (alias) {
    const project = await projectRepository.findById(alias.projectId, tx);
    if (project) return { project, viaAlias: true };
  }

  throw new ProjectNotFoundError(key);
}
