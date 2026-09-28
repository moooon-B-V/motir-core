import { randomUUID } from 'node:crypto';
import type { Prisma, ProjectVisitor } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// The VISITOR RECORD's one door (Story MOTIR-6170 · MOTIR-6665;
// `docs/decisions/visitor-sign-in-and-records.md`). One row per (person, public
// project), written when a signed-in person who cannot enter the project consents
// on its consent screen; read by the project's Managers (name + email) and by the
// person's own data export. Single-op methods; every write takes a REQUIRED `tx`.
// The rows cascade with the person and with the project (both `@relation`s).

/** One (project, person) pair at a moment — the input of the two writes. */
export interface ProjectVisitorAt {
  projectId: string;
  userId: string;
  at: Date;
}

/** A row of the Managers' list: the record joined to the person's name and email. */
export interface ProjectVisitorListRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  consentedAt: Date;
  firstVisitAt: Date;
  lastVisitAt: Date;
}

/**
 * A row of the person's own export: the record with the project it is about. The
 * project's name and key are NULL when the project is no longer readable to the
 * person — it was public when they consented, and has since left `public` — so
 * the record is still theirs to see, without naming a project they cannot read.
 */
export interface ProjectVisitorOwnRow {
  projectId: string;
  projectName: string | null;
  projectIdentifier: string | null;
  consentedAt: Date;
  firstVisitAt: Date;
  lastVisitAt: Date;
}

/** The keyset position of the Managers' list: `(lastVisitAt desc, id desc)`. */
export interface ProjectVisitorCursor {
  lastVisitAt: Date;
  id: string;
}

export const projectVisitorRepository = {
  /** The person's record on the project, or null. */
  async findByProjectAndUser(
    projectId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectVisitor | null> {
    const client = tx ?? dbRead;
    return client.projectVisitor.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
  },

  /**
   * Record a CONSENT. The first creates the row with `consentedAt = firstVisitAt =
   * lastVisitAt = at`; a repeat (a double-click, a second tab) leaves the first
   * consent and first visit standing and only moves `lastVisitAt` forward. ONE
   * `INSERT … ON CONFLICT` statement, so two concurrent consents can neither make
   * two rows nor raise a unique violation.
   */
  async upsertConsent(input: ProjectVisitorAt, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "project_visitor"
        ("id", "project_id", "user_id", "consented_at", "first_visit_at", "last_visit_at")
      VALUES (${randomUUID()}, ${input.projectId}, ${input.userId}, ${input.at}, ${input.at}, ${input.at})
      ON CONFLICT ("project_id", "user_id") DO UPDATE
        SET "last_visit_at" = GREATEST("project_visitor"."last_visit_at", EXCLUDED."last_visit_at")`;
  },

  /**
   * Touch the latest visit — only FORWARD: a stored `lastVisitAt` newer than `at`
   * is left alone. Returns the number of rows moved (0 when there is no record,
   * or it was already newer).
   */
  async touchLastVisit(input: ProjectVisitorAt, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.projectVisitor.updateMany({
      where: { projectId: input.projectId, userId: input.userId, lastVisitAt: { lt: input.at } },
      data: { lastVisitAt: input.at },
    });
    return result.count;
  },

  /**
   * A page of the project's visitors for its Managers — newest `lastVisitAt`
   * first, `id` breaking a tie, keyset-paged, each joined to the person's name
   * and email.
   */
  async listByProject(
    args: { projectId: string; cursor?: ProjectVisitorCursor | null; limit: number },
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectVisitorListRow[]> {
    const client = tx ?? dbRead;
    const rows = await client.projectVisitor.findMany({
      where: {
        projectId: args.projectId,
        ...(args.cursor
          ? {
              OR: [
                { lastVisitAt: { lt: args.cursor.lastVisitAt } },
                { lastVisitAt: args.cursor.lastVisitAt, id: { lt: args.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastVisitAt: 'desc' }, { id: 'desc' }],
      take: args.limit,
      select: {
        id: true,
        userId: true,
        consentedAt: true,
        firstVisitAt: true,
        lastVisitAt: true,
        user: { select: { name: true, email: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.user.name,
      email: r.user.email,
      consentedAt: r.consentedAt,
      firstVisitAt: r.firstVisitAt,
      lastVisitAt: r.lastVisitAt,
    }));
  },

  /** How many people have a record on the project. */
  async countByProject(projectId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    return client.projectVisitor.count({ where: { projectId } });
  },

  /** The person's OWN records, with the project each is about — for their export. */
  async listByUser(userId: string, tx?: Prisma.TransactionClient): Promise<ProjectVisitorOwnRow[]> {
    const client = tx ?? dbRead;
    const rows = await client.projectVisitor.findMany({
      where: { userId },
      orderBy: [{ consentedAt: 'asc' }, { id: 'asc' }],
      select: {
        projectId: true,
        consentedAt: true,
        firstVisitAt: true,
        lastVisitAt: true,
        project: { select: { name: true, identifier: true } },
      },
    });
    return rows.map((r) => ({
      projectId: r.projectId,
      // `project` is typed required, but RLS hides a project that is no longer public.
      projectName: (r.project as { name: string } | null)?.name ?? null,
      projectIdentifier: (r.project as { identifier: string } | null)?.identifier ?? null,
      consentedAt: r.consentedAt,
      firstVisitAt: r.firstVisitAt,
      lastVisitAt: r.lastVisitAt,
    }));
  },
};
