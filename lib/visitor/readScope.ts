import type { PermissionKey } from '@/lib/permissions/catalog';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { VisitorReadContext } from '@/lib/visitor/context';

// How a collection read serves a VISITOR (Story MOTIR-6170 · MOTIR-6644;
// `epic-privacy.md` §3–§5). A read that accepts a `VisitorReadContext` in place
// of a member's context calls {@link openVisitorRead} for its gate and threads
// the returned `excludeIds` into the repository's existing option; a member's
// call site passes nothing, so their read keeps "no clause" byte for byte.

/** Whether a read's context is a Visitor's rather than a member's. */
export function isVisitorContext(ctx: object): ctx is VisitorReadContext {
  return (ctx as { kind?: unknown }).kind === 'visitor';
}

/**
 * The Visitor's gate for one project read. The context was built for ONE public
 * project, so any other project id is the same not-found a stranger gets for a
 * private project; a key the Visitor set does not hold is a refusal. Returns the
 * project's workspace (a value the database handed `resolveVisitor`, safe to
 * bind) and the private-epic exclusion set.
 */
export function openVisitorRead(
  projectId: string,
  ctx: VisitorReadContext,
  key: PermissionKey = 'project:browse',
): { workspaceId: string; excludeIds: readonly string[] } {
  if (ctx.project.id !== projectId) throw new ProjectNotFoundError(projectId);
  if (!ctx.permissions.has(key)) throw new ProjectAccessDeniedError(projectId, 'browse');
  return { workspaceId: ctx.project.workspaceId, excludeIds: [...ctx.hiddenIds] };
}

/** The fields a private epic's row must not give away to a Visitor (§4). */
interface EpicTells {
  kind: string;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  hasChildren?: boolean;
}

/**
 * A private epic's row, as a Visitor sees it (`epic-privacy.md` §4): the row
 * stays, marked `childrenHidden: true`, with its child probe false and its
 * points and estimate — which on a container are the rollup of the withheld
 * subtree's sizing — nulled. Every other row passes through unchanged.
 */
export function stripPrivateEpicTells<T extends EpicTells>(
  dto: T,
  publicChildrenHidden: boolean | undefined,
): T & { childrenHidden?: true } {
  if (dto.kind !== 'epic' || !publicChildrenHidden) return dto;
  return {
    ...dto,
    ...('hasChildren' in dto ? { hasChildren: false } : {}),
    ...('storyPoints' in dto ? { storyPoints: null } : {}),
    ...('estimateMinutes' in dto ? { estimateMinutes: null } : {}),
    childrenHidden: true,
  };
}
