import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectVisitorRepository } from '@/lib/repositories/projectVisitorRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { VisitorConsentDTO } from '@/lib/dto/visitors';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { VisitorConsentNotApplicableError } from '@/lib/visitor/errors';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

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
};
