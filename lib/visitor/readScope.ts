import type { PermissionKey } from '@/lib/permissions/catalog';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { relabelPageTokens } from '@/lib/mentions/pageRefs';

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

/**
 * The text a Visitor reads in place of a work-item chip whose target is withheld
 * (MOTIR-6652, `epic-privacy.md` §3). Plain text rather than a link: a chip keeps
 * its label — usually the target's key or title — in the Markdown itself, so the
 * token has to leave the body, not only lose its resolution.
 */
export const WITHHELD_WORK_ITEM_LABEL = 'Unavailable item';

/** Matches one `[label](motir:<id>)` token, the id captured (cf. `WORKITEM_TOKEN_RE`). */
const WORK_ITEM_TOKEN = /\[[^\]\[]*\]\(motir:([A-Za-z0-9_-]+)\)/g;

/**
 * A Markdown body as a Visitor reads it: every work-item chip naming a withheld
 * item replaced by {@link WITHHELD_WORK_ITEM_LABEL}, so neither the target's
 * label, key nor id crosses the wire. Every other chip, and all other text, is
 * untouched. `null` stays `null`.
 */
export function redactWithheldWorkItemRefs<T extends string | null>(
  markdown: T,
  hidden: ReadonlySet<string>,
): T {
  if (markdown === null || hidden.size === 0) return markdown;
  return markdown.replace(WORK_ITEM_TOKEN, (token, id: string) =>
    hidden.has(id) ? WITHHELD_WORK_ITEM_LABEL : token,
  ) as T;
}

/**
 * The label every page chip carries in a Visitor's body (MOTIR-7697). A Visitor
 * route serves no page (`epic-privacy.md` §3), so a tagged page's title — kept
 * in the token's label at insert — must not cross the wire.
 */
export const REDACTED_PAGE_LABEL = 'page';

/**
 * A Markdown body as a Visitor reads it: every `[label](motir-page:<id>)` chip's
 * label replaced by {@link REDACTED_PAGE_LABEL}, the id kept so the chip still
 * renders its unavailable state. Every other token and all other text are
 * untouched. `null` stays `null`.
 */
export function redactPageRefLabels<T extends string | null>(markdown: T): T {
  if (markdown === null) return markdown;
  return relabelPageTokens(markdown, () => REDACTED_PAGE_LABEL) as T;
}
