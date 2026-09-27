import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext, type ProjectDTO } from '@/lib/projects';
import { getWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

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
  /** The context the page's services are called with — the member's own here. */
  readonly reader: ProjectContext;
}

/** What a plan-addressed page's view is given — no project: the plan names it. */
export interface ReaderPageContext {
  readonly actorUserId: string | null;
  /** The context the page's services are called with — the member's own here. */
  readonly reader: WorkspaceContext;
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
