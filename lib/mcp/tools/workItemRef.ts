import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Shared work-item-identifier plumbing for the write tools (Subtask 7.8.5).
// `transition_status` and `add_comment` both address a work item by its
// `PROD-<n>` identifier and must resolve it the SAME way the read tools do
// (`get_work_item`): derive the project key, normalize case. Kept in one place
// so the write tools can't drift from each other on what a key means.
//
// The sprint bulk-move tools (7.8.10) address items by key too, and reuse this
// resolution through `resolveWorkItemIdsByKeys` below.

/** The zod field every key-addressed write tool shares. */
export const workItemKeyField = z
  .string()
  .min(1)
  .describe('The work item identifier, e.g. "PROD-7" (case-insensitive).');

/** The session/integration branch field the 7.8.11 integration tools share —
 *  the git branch a run's work was merged onto (`mark_integrated`) / is being
 *  closed out from (`complete_session`). Trimmed, non-empty. */
export const sessionBranchField = z
  .string()
  .trim()
  .min(1)
  .describe('The session/integration branch name, e.g. "session/PROD-42-run".');

/** Normalize a user-supplied identifier to its canonical upper-case form. */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Derive the owning project key from a `PROD-7`-style identifier. */
export function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/**
 * Resolve a list of `PROD-<n>` work-item keys to their internal ids, the form
 * the bulk backlog/sprint services take (Subtask 7.8.10's `move_to_sprint` /
 * `move_to_backlog`). Each key is normalized, its project resolved by key
 * prefix (cached so a same-project batch makes ONE project lookup), then the
 * item resolved within that project — both through the same permission-scoped
 * services the other tools use, so the 404-not-403 cross-tenant contract holds
 * (an unknown / cross-tenant project or item is an indistinguishable not-found).
 * Order is preserved; duplicate keys are passed through verbatim (the bulk
 * services dedupe by id). A bad key aborts the whole resolution by throwing the
 * service's typed error, which the caller maps via `toToolError`.
 */
export async function resolveWorkItemIdsByKeys(
  keys: string[],
  ctx: ServiceContext,
): Promise<string[]> {
  const projectCache = new Map<string, string>(); // project key → project id
  const ids: string[] = [];
  for (const raw of keys) {
    ids.push(await resolveOneKey(raw, ctx, projectCache));
  }
  return ids;
}

/**
 * Resolve a PAIR of `PROD-<n>` keys to a fixed 2-tuple of ids — the shape the
 * link tools (Subtask 7.8.13) take (`fromKey`, `toKey`). Same per-item project
 * resolution + cache as {@link resolveWorkItemIdsByKeys}, but the tuple return
 * gives the caller two DEFINITE ids (no `noUncheckedIndexedAccess` guard on an
 * array index). The two items may live in different projects of the same
 * workspace — the link model allows a cross-project edge.
 */
export async function resolveWorkItemIdPair(
  fromKey: string,
  toKey: string,
  ctx: ServiceContext,
): Promise<[string, string]> {
  const projectCache = new Map<string, string>(); // project key → project id
  const fromId = await resolveOneKey(fromKey, ctx, projectCache);
  const toId = await resolveOneKey(toKey, ctx, projectCache);
  return [fromId, toId];
}

/** Resolve ONE key to its internal id, memoizing the project lookup in
 *  `projectCache`. A bad / cross-tenant key throws the service's typed
 *  not-found error (the 404-not-403 contract), which the caller maps. */
async function resolveOneKey(
  raw: string,
  ctx: ServiceContext,
  projectCache: Map<string, string>,
): Promise<string> {
  const identifier = normalizeIdentifier(raw);
  const projectKey = projectKeyOf(identifier);
  let projectId = projectCache.get(projectKey);
  if (projectId === undefined) {
    const project = await projectsService.getByKey(projectKey, ctx);
    projectId = project.id;
    projectCache.set(projectKey, projectId);
  }
  const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
  return item.id;
}
