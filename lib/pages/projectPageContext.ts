import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext, type ProjectDTO } from '@/lib/projects';
import { getWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { visitorServiceContext, type VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

// WHICH project a read page shows, separated from HOW it renders it (Story
// MOTIR-6170 · MOTIR-6643).
//
// The eight read pages (items list/tree, a work item, the board, the roadmap,
// Plans, a plan, Approvals, Runs) each used to find their own project — the
// session, then the reader's ACTIVE project — inside the page body. A Visitor has
// neither, so no body could be reused for one. Each body now lives in a
// `_view.tsx` server component that is HANDED this context and never reaches for
// the session or the active project itself; the `(authed)` page is a wrapper that
// builds it with {@link memberPageContext}. The Visitor route tree builds the
// same shape from `resolveVisitor` and hands it to the same views.

/** What a read page's view is given — the project, the reader and their keys. */
export interface ProjectPageContext {
  /** The project the page shows. */
  readonly project: ProjectDTO;
  /**
   * The reader's permission SET on {@link project}, read ON DEMAND and at most
   * once. A function rather than a set because the item page's gate reads it only
   * AFTER the detail read has decided not-found — a missing item must 404 without
   * the permission read ever starting (`tests/components/item-detail-reads`).
   * Every capability boolean a view uses is derived from this set.
   */
  readonly permissions: () => Promise<ReadonlySet<PermissionKey>>;
  /** The signed-in reader, or `null` for an anonymous one. */
  readonly actorUserId: string | null;
  /** The signed-in reader's display name, or `null`. */
  readonly actorName: string | null;
  /**
   * The context the page's services are called with: the member's own project
   * context, or — on the Visitor route tree (MOTIR-6648) — the Visitor's read
   * context. A view never reads it directly; it goes through {@link pageScope},
   * which hands each service the shape it takes.
   */
  readonly reader: ProjectContext | VisitorReadContext;
}

/** What a plan-addressed page's view is given — no project: the plan names it. */
export interface ReaderPageContext {
  readonly actorUserId: string | null;
  /**
   * The context the page's services are called with: the member's workspace
   * context, or a Visitor's read context (MOTIR-6648), which confines the plan
   * read to its one public project.
   */
  readonly reader: WorkspaceContext | VisitorReadContext;
}

/**
 * A read page's reader, in the forms the page's services take (Story MOTIR-6170 ·
 * MOTIR-6648). One place decides them, so no view reasons about who is reading:
 *
 * - {@link read} is for a read that ACCEPTS a Visitor context (the collection
 *   reads, the item page, the rooms, the name-only component list) — given the
 *   Visitor's own context, it applies the private-epic hidden set and the
 *   name-only person shape;
 * - {@link service} is for every other read — the member's `{ userId,
 *   workspaceId }`, or the Visitor's NARROWED service context
 *   (`visitorServiceContext`: no membership, bound to this one project, granted
 *   the Visitor keys), which resolves exactly the Visitor's standing.
 */
export interface PageScope {
  readonly projectId: string;
  readonly workspaceId: string;
  /** The reader as a PERSON — "is this mine" tests and the saved-filter viewer. */
  readonly userId: string;
  readonly project: ProjectDTO;
  readonly service: ServiceContext;
  readonly read: ServiceContext | VisitorReadContext;
  /** The Visitor's context on the Visitor route tree, else null. */
  readonly visitor: VisitorReadContext | null;
}

/** {@link PageScope} for a page context — see there. */
export function pageScope(ctx: ProjectPageContext): PageScope {
  const reader = ctx.reader;
  if (isVisitorContext(reader)) {
    return {
      projectId: reader.project.id,
      workspaceId: reader.project.workspaceId,
      userId: reader.actorUserId,
      project: ctx.project,
      service: visitorServiceContext(reader),
      read: reader,
      visitor: reader,
    };
  }
  const member = { userId: reader.userId, workspaceId: reader.workspaceId };
  return {
    projectId: reader.projectId,
    workspaceId: reader.workspaceId,
    userId: reader.userId,
    project: reader.project,
    service: member,
    read: member,
    visitor: null,
  };
}

/**
 * The people a page labels rows with (assignee avatars, the filter facets). A
 * member reads the project's entering members with their emails, as before; a
 * Visitor reads the same people NAME ONLY (MOTIR-6646) — the email field empty,
 * never an address.
 */
export async function pageMembers(scope: PageScope): Promise<WorkspaceMemberDTO[]> {
  if (scope.visitor) {
    const labels = await assignableMembersService.listPersonLabels(scope.visitor);
    return labels.map((label) => ({
      userId: label.id,
      name: label.name,
      email: '',
      workspaceRole: 'viewer',
      customRole: null,
    }));
  }
  return assignableMembersService.list({
    projectId: scope.projectId,
    accessMode: scope.project.accessMode,
    ctx: scope.service,
  });
}

/**
 * A VISITOR's page context (MOTIR-6648), built from the `visitor` verdict the
 * Visitor layout's resolution produced: the public project, the Visitor key set
 * (never resolved again — it is the verdict's), and the Visitor's read context as
 * the reader.
 */
export function visitorPageContext(
  ctx: VisitorReadContext,
  actorName: string | null,
): ProjectPageContext {
  return {
    project: toProjectDTO(ctx.project),
    permissions: async () => ctx.permissions,
    actorUserId: ctx.actorUserId,
    actorName,
    reader: ctx,
  };
}

/** Memoise a read so every caller in one render shares the one round trip. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => (pending ??= read());
}

/**
 * A MEMBER's page context: the session and the active project, with exactly the
 * redirects the pages made before — no session → `/sign-in`; no project the
 * reader can enter → the no-project landing (MOTIR-6548), never `/sign-in`, which
 * would bounce a signed-in reader straight back.
 *
 * The two reads start together: `getActiveProject` resolves the same memoised
 * session internally and answers `null` without one, so the order of the checks
 * below is what decides the redirect, not the order of the reads.
 */
export async function memberPageContext(): Promise<ProjectPageContext> {
  const [session, active] = await Promise.all([getSession(), getActiveProject()]);
  if (!session) redirect('/sign-in');
  if (!active) redirect(NO_PROJECT_PATH);
  const reader = active;
  return {
    project: reader.project,
    permissions: once(() =>
      projectAccessService.getPermissions(reader.projectId, {
        userId: reader.userId,
        workspaceId: reader.workspaceId,
      }),
    ),
    actorUserId: reader.userId,
    actorName: session.user.name ?? null,
    reader,
  };
}

/**
 * A MEMBER's context for a PLAN-addressed page (`/plans/[id]`), which is not tied
 * to the active project: the plan names its own project, and the read checks the
 * reader may browse it. Exactly the page's old gate — no session → `/sign-in`, no
 * workspace → not-found.
 */
export async function memberReaderPageContext(): Promise<ReaderPageContext> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const reader = await getWorkspaceContext();
  if (!reader) notFound();
  return { actorUserId: reader.userId, reader };
}
