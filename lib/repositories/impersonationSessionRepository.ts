import {
  type ImpersonationEndedBy,
  type ImpersonationMode,
  type ImpersonationSession,
  type PlatformRole,
  type Prisma,
} from '@/generated/prisma/client';

/**
 * Data access for `impersonation_session` — staff "View as" sessions (Story 10.3
 * · MOTIR-749). One Prisma operation per method, no business logic.
 *
 * Every method takes `tx`: the table is behind RLS with no tenant arm, so a read
 * is only visible inside a context that binds `app.platform_staff` (the console,
 * via `withPlatformRead`) or `app.system_admin` (the request-path gate, via
 * `withSystemContext`), and every write happens inside the audited platform
 * transaction that records it.
 */

/** What a new session row is made of. The service computes every field. */
export interface ImpersonationSessionCreateInput {
  tokenHash: string;
  operatorUserId: string;
  operatorRole: PlatformRole;
  operatorSessionId: string;
  targetUserId: string;
  organizationId: string;
  workspaceId: string;
  mode: ImpersonationMode;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
}

/** A session row with the names the bar and the audit rows print. */
export type ImpersonationSessionWithNames = Prisma.ImpersonationSessionGetPayload<{
  include: {
    operator: { select: { email: true } };
    target: { select: { id: true; name: true; email: true } };
    organization: { select: { id: true; name: true } };
  };
}>;

const WITH_NAMES = {
  operator: { select: { email: true } },
  target: { select: { id: true, name: true, email: true } },
  organization: { select: { id: true, name: true } },
} as const;

export const impersonationSessionRepository = {
  /** The session a cookie names, by the SHA-256 of its token — live or not. */
  async findByTokenHash(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSessionWithNames | null> {
    return tx.impersonationSession.findUnique({ where: { tokenHash }, include: WITH_NAMES });
  },

  /** One session by id, with names — the ended page. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSessionWithNames | null> {
    return tx.impersonationSession.findUnique({ where: { id }, include: WITH_NAMES });
  },

  /**
   * Lock one session row and return whether it is still open — the guard every
   * END runs inside its audited transaction, so two closers racing (the operator's
   * Exit and the sweep, say) produce one end and one refusal, never two end rows.
   */
  async lockOpenState(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ endedAt: Date | null } | null> {
    const rows = await tx.$queryRaw<{ ended_at: Date | null }[]>`
      SELECT "ended_at" FROM "impersonation_session" WHERE "id" = ${id} FOR UPDATE
    `;
    const row = rows[0];
    return row ? { endedAt: row.ended_at } : null;
  },

  /** The operator's sessions that have not been ended — at most one in practice. */
  async listOpenForOperator(
    operatorUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSessionWithNames[]> {
    return tx.impersonationSession.findMany({
      where: { operatorUserId, endedAt: null },
      include: WITH_NAMES,
      orderBy: { startedAt: 'asc' },
    });
  },

  /** Sessions past their time-box that nobody has closed — the sweep's worklist. */
  async listExpiredOpen(
    now: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSessionWithNames[]> {
    return tx.impersonationSession.findMany({
      where: { endedAt: null, expiresAt: { lte: now } },
      include: WITH_NAMES,
      orderBy: { expiresAt: 'asc' },
      take,
    });
  },

  async create(
    data: ImpersonationSessionCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSession> {
    return tx.impersonationSession.create({ data });
  },

  async markEnded(
    id: string,
    end: { endedAt: Date; endedBy: ImpersonationEndedBy },
    tx: Prisma.TransactionClient,
  ): Promise<ImpersonationSession> {
    return tx.impersonationSession.update({ where: { id }, data: end });
  },
};
