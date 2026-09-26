import {
  type Prisma,
  type RoleMigrationReport,
  type User,
  type WorkspaceRoleDefinition,
} from '@/generated/prisma/client';

/** A report row with the person and the after custom role the notice names. */
export type RoleMigrationReportWithPeople = RoleMigrationReport & {
  user: Pick<User, 'id' | 'name' | 'email'>;
  afterRoleDefinition: Pick<WorkspaceRoleDefinition, 'id' | 'name'> | null;
};

// RoleMigrationReport repository — the `role_migration_report` table (Story
// MOTIR-6168 · Subtask MOTIR-6457). One row per person per reason the move to
// workspace roles chose their role by anything other than the plain mapping.
//
// The rows are WRITTEN by SQL migrations (the mapping, MOTIR-6458, and the
// never-wider check, MOTIR-6461), never by the application, so this repository
// has no create. What the application does with a row is read it (the workspace
// Members page's notice, MOTIR-6465) and dismiss it.
//
// RLS: its own `workspace_id` and a FOR ALL policy on `app.workspace_id`; every
// method REQUIRES `tx` for the reason `workspaceRoleDefinitionRepository` gives.

/** The default page size for the Members page's notice. */
const DEFAULT_LIMIT = 20;

export const roleMigrationReportRepository = {
  /**
   * The workspace's OPEN (not dismissed) report rows, newest first, one page at a
   * time. Keyset-paged on `(createdAt, id)` descending so a page boundary is
   * stable while rows are dismissed underneath it; `nextCursor` is the last
   * row's id, or null when this page is the last.
   */
  async listOpenByWorkspace(
    workspaceId: string,
    opts: { cursor?: string | null; limit?: number },
    tx: Prisma.TransactionClient,
  ): Promise<{ rows: RoleMigrationReportWithPeople[]; nextCursor: string | null }> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const rows = await tx.roleMigrationReport.findMany({
      where: { workspaceId, dismissedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        user: { select: { id: true, name: true, email: true } },
        afterRoleDefinition: { select: { id: true, name: true } },
      },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { rows: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
  },

  /** How many OPEN rows the workspace has — the notice's count pill. */
  async countOpenByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.roleMigrationReport.count({ where: { workspaceId, dismissedAt: null } });
  },

  /**
   * Mark one row dismissed. Idempotent: a second dismiss leaves the FIRST
   * timestamp in place (`dismissedAt: null` in the filter) and reports that it
   * changed nothing. Returns whether a row was dismissed by THIS call.
   */
  async dismiss(id: string, tx: Prisma.TransactionClient, workspaceId?: string): Promise<boolean> {
    const { count } = await tx.roleMigrationReport.updateMany({
      where: { id, dismissedAt: null, ...(workspaceId ? { workspaceId } : {}) },
      data: { dismissedAt: new Date() },
    });
    return count === 1;
  },
};
