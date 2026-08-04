import { InvalidRequestError } from '@/lib/api/v1/errors';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Resolving a `MOTIR-<n>` path segment for `/api/v1` (Story 11.2 · Subtask
// 11.2.2 — MOTIR-2040).
//
// ⚠️ RE-IMPLEMENTED, NOT IMPORTED. `lib/mcp/tools/workItemRef.ts` does the same
// job (`normalizeIdentifier` / `projectKeyOf` / `resolveWorkItemByKey`) and was
// READ while writing this — but a public route importing the MCP tool layer
// couples a STABLE contract to a deliberately fluid one, and it is the direction
// the epic explicitly rejects: MCP tools are not re-pointed at HTTP, and HTTP
// does not reach into MCP. The two surfaces are aligned through SCHEMAS (11.6),
// never through imports, and `tests/api/v1/story-gate.test.ts` asserts that no
// v1 route reaches into `lib/mcp/tools/**`.
//
// The behavioural contract is identical on purpose, and that identity is what
// 11.6 later pins: same normalization, same key→project derivation, and the same
// 404-not-403 cross-tenant answer, which falls out of calling the same
// permission-scoped service rather than from a check written here.

/** A `MOTIR-<n>` key: a project key, a hyphen, a positive integer. */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Normalize a caller-supplied identifier to its canonical upper-case form. */
export function normalizeWorkItemKey(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Derive the owning project key from a `MOTIR-7`-style identifier. */
export function projectKeyOfWorkItemKey(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** A work-item key resolved to what the services address it by. */
export interface ResolvedWorkItemKey {
  projectId: string;
  /** The canonical upper-case `MOTIR-<n>` form. */
  identifier: string;
}

/**
 * Resolve a path key to `{ projectId, identifier }`.
 *
 * A MALFORMED key (no hyphen, no numeric suffix, empty) is a **422 before any
 * read** — it is a request the caller can fix, and answering 404 would spend a
 * database round-trip telling them nothing. A well-formed key naming a project
 * that does not exist, or one outside the token's workspace, is the service's
 * `ProjectNotFoundError` → 404, indistinguishable from a key that never existed
 * (ADR §4's existence-oracle rule).
 */
export async function resolveWorkItemKey(
  raw: string | undefined,
  ctx: ServiceContext,
): Promise<ResolvedWorkItemKey> {
  // A missing segment is a malformed request, not a server fault. Next.js will
  // not route here without one, but the handler is also called directly (by the
  // route-tree sweep, and by any future composition), and a bare `500` would
  // hide a caller's mistake behind "something went wrong".
  const identifier = typeof raw === 'string' ? normalizeWorkItemKey(raw) : '';
  if (!KEY_PATTERN.test(identifier)) {
    throw new InvalidRequestError(
      'INVALID_WORK_ITEM_KEY',
      'The work-item key must look like `MOTIR-123`.',
    );
  }
  const project = await projectsService.getByKey(projectKeyOfWorkItemKey(identifier), ctx);
  return { projectId: project.id, identifier };
}
