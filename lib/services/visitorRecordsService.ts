import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ProjectVisitorsPageDTO, VisitorConsentDTO } from '@/lib/dto/visitors';
import { toProjectVisitorDTO } from '@/lib/mappers/visitorMappers';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { resolveProjectByKeyWithAliasInTx } from '@/lib/projects/resolveByKey';
import type { ProjectVisitorCursor } from '@/lib/repositories/projectVisitorRepository';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { VisitorConsentNotApplicableError } from '@/lib/visitor/errors';
import {
  withWorkspaceContext,
  withWorkspaceServiceContext,
  type WorkspaceContext,
} from '@/lib/workspaces/context';

// The VISITOR RECORD's writes (Story MOTIR-6170 · MOTIR-6666;
// `docs/decisions/visitor-sign-in-and-records.md`): the consent a signed-in
// non-entrant gives on a public project's consent screen, and the latest visit a
// Visitor read touches. The table and its one door are MOTIR-6665's.

/**
 * How stale `lastVisitAt` must be before a read touches it again. A Visitor pages
 * through many views a minute; the Managers' list needs "when did they last come
 * back", not every click, so a read writes at most once per window.
 */
export const VISITOR_TOUCH_INTERVAL_MS = 10 * 60_000;

/**
 * How many visitors one page of the Managers' list shows — the approved design's
 * page (MOTIR-6641 panel 10: "20 a page, Show more").
 */
export const VISITORS_PAGE_SIZE = 20;

/** The Managers' list's keyset position, opaque on the wire. */
function encodeVisitorsCursor(cursor: ProjectVisitorCursor): string {
  return Buffer.from(`${cursor.lastVisitAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** A cursor this list minted, or null for anything else (read as "the first page"). */
function decodeVisitorsCursor(raw: string | null | undefined): ProjectVisitorCursor | null {
  if (!raw) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const bar = text.indexOf('|');
  if (bar <= 0) return null;
  const lastVisitAt = new Date(text.slice(0, bar));
  const id = text.slice(bar + 1);
  if (!id || Number.isNaN(lastVisitAt.getTime())) return null;
  return { lastVisitAt, id };
}

export const visitorRecordsService = {
  /**
   * Record a CONSENT — the Continue on a public project's consent screen.
   *
   * The project is RE-RESOLVED through `resolveVisitor`, the one resolution, so a
   * project made private or removed since the screen was drawn answers the same
   * {@link ProjectNotFoundError} as one that never existed, and a person who can
   * ENTER it is refused ({@link VisitorConsentNotApplicableError}) with nothing
   * written. A repeat press is idempotent: the first consent and first visit
   * stand, and the same record comes back.
   */
  async recordConsent(input: {
    identifier: string;
    userId: string;
    now?: Date;
  }): Promise<VisitorConsentDTO> {
    const verdict = await projectAccessService.resolveVisitor(input.identifier, {
      user: { id: input.userId },
    });
    if (verdict.kind === 'enter') throw new VisitorConsentNotApplicableError(input.identifier);
    if (verdict.kind !== 'consent' && verdict.kind !== 'visitor') {
      throw new ProjectNotFoundError(input.identifier);
    }
    // The same resolver `resolveVisitor` read the project through.
    const project = await projectRepository.findPublicByIdentifier(input.identifier);
    if (!project) throw new ProjectNotFoundError(input.identifier);
    const at = input.now ?? new Date();
    const row = await withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      await projectVisitorRepository.upsertConsent(
        { projectId: project.id, userId: input.userId, at },
        tx,
      );
      return projectVisitorRepository.findByProjectAndUser(project.id, input.userId, tx);
    });
    /* istanbul ignore next -- defensive: the upsert above guarantees the row */
    if (!row) throw new ProjectNotFoundError(input.identifier);
    return {
      projectIdentifier: project.identifier,
      consentedAt: row.consentedAt.toISOString(),
      firstVisitAt: row.firstVisitAt.toISOString(),
      lastVisitAt: row.lastVisitAt.toISOString(),
    };
  },

  /**
   * Touch the Visitor's latest visit — called from `resolveVisitor`'s `visitor`
   * branch on every Visitor read. Writes only when the stored value is at least
   * {@link VISITOR_TOUCH_INTERVAL_MS} old (the COMPARE is on the stored row, so
   * every instance agrees). It NEVER fails a read: an error is logged and
   * swallowed, and the Visitor's page renders as if the touch had happened.
   */
  async touchVisit(
    ctx: Pick<VisitorReadContext, 'project' | 'actorUserId'>,
    lastVisitAt: Date,
    now: Date = new Date(),
  ): Promise<void> {
    if (now.getTime() - lastVisitAt.getTime() < VISITOR_TOUCH_INTERVAL_MS) return;
    try {
      await withWorkspaceServiceContext(ctx.project.workspaceId, (tx) =>
        projectVisitorRepository.touchLastVisit(
          { projectId: ctx.project.id, userId: ctx.actorUserId, at: now },
          tx,
        ),
      );
    } catch (err) {
      console.warn('[visitorRecords] could not touch a Visitor’s latest visit; the read goes on', {
        projectId: ctx.project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * A page of a PUBLIC project's visitors, for its Managers (MOTIR-6667;
   * `visitor-sign-in-and-records.md` Decision 4) — the one read that hands out a
   * Visitor's email. Newest latest visit first, {@link VISITORS_PAGE_SIZE} a page,
   * with the whole list's size.
   *
   * REFUSED server-side, never hidden client-side: the reader must hold
   * `project:manage_access` ({@link PermissionDeniedError} otherwise), and the
   * project must be Public NOW. A project that was public and is not any more
   * answers the SAME refusal a reader without the key gets: its records stay in
   * the table and come back if it is made public again — that is the decision,
   * not a leak or a bug.
   *
   * Every read runs in the reader's workspace transaction, because the person
   * rows the list joins to are RLS-gated on it.
   */
  async listForManagers(input: {
    key: string;
    ctx: WorkspaceContext;
    cursor?: string | null;
  }): Promise<ProjectVisitorsPageDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const { project } = await resolveProjectByKeyWithAliasInTx(
        input.key,
        input.ctx.workspaceId,
        tx,
      );
      await projectAccessService.assertPermission(
        project.id,
        input.ctx,
        'project:manage_access',
        tx,
      );
      if (project.accessMode !== 'public') {
        throw new PermissionDeniedError(project.id, 'project:manage_access');
      }
      // In sequence: both reads share the one transaction's connection.
      const rows = await projectVisitorRepository.listByProject(
        {
          projectId: project.id,
          cursor: decodeVisitorsCursor(input.cursor),
          limit: VISITORS_PAGE_SIZE + 1,
        },
        tx,
      );
      const total = await projectVisitorRepository.countByProject(project.id, tx);
      const page = rows.slice(0, VISITORS_PAGE_SIZE);
      const last = page[page.length - 1];
      return {
        visitors: page.map(toProjectVisitorDTO),
        total,
        nextCursor:
          rows.length > VISITORS_PAGE_SIZE && last
            ? encodeVisitorsCursor({ lastVisitAt: last.lastVisitAt, id: last.id })
            : null,
      };
    });
  },
};
