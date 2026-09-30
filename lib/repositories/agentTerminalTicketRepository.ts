import type { AgentTerminalTicket, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `agent_terminal_ticket` — the one-shot ticket the
// owner's browser hands the terminal relay (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3).
//
// EVERY METHOD TAKES `tx`, for `agentInstanceRepository`'s reason: the table is
// RLS-gated on `app.workspace_id`, and a read through the bare client returns
// nothing rather than failing. The two cross-tenant READS (the relay's lookup by
// hash, the sweep's discovery) run under `withSystemContext` against the table's
// `FOR SELECT` system arm; every WRITE runs bound to the row's own workspace.
//
// The ticket itself never reaches this file — only its hash.

export type AgentTerminalTicketCreateInput = Prisma.AgentTerminalTicketUncheckedCreateInput;

/** An expired ticket, as the sweep needs it: which workspace to delete it in. */
export interface ExpiredTicketRef {
  id: string;
  workspaceId: string;
}

export const agentTerminalTicketRepository = {
  /** Insert a minted ticket (its hash). `tx` required — a write. */
  async create(
    data: AgentTerminalTicketCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentTerminalTicket> {
    return tx.agentTerminalTicket.create({ data });
  },

  /** A ticket by its hash, consumed or not, expired or not. */
  async findByHash(
    tokenHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentTerminalTicket | null> {
    return tx.agentTerminalTicket.findUnique({ where: { tokenHash } });
  },

  /**
   * THE SINGLE-USE CONSUME — one guarded update, `consumed_at IS NULL AND
   * expires_at > now`. Returns 1 for the one caller that redeemed it and 0 for
   * everyone else (a second use, a second relay, an expired ticket).
   */
  async consume(id: string, now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.agentTerminalTicket.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count;
  },

  /** The sweep's discovery: tickets whose life ended before `now`, oldest first. */
  async listExpired(
    now: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<ExpiredTicketRef[]> {
    return tx.agentTerminalTicket.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, workspaceId: true },
      orderBy: { expiresAt: 'asc' },
      take,
    });
  },

  /** Delete expired tickets by id (in the bound workspace). Re-checks the expiry. */
  async deleteExpired(ids: string[], now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.agentTerminalTicket.deleteMany({
      where: { id: { in: ids }, expiresAt: { lte: now } },
    });
    return count;
  },
};
