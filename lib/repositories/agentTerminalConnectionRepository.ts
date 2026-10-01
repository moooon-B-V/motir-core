import type {
  AgentTerminalChannel,
  AgentTerminalConnection,
  Prisma,
} from '@/generated/prisma/client';

// Single Prisma operations on `agent_terminal_connection` — one row per terminal
// connection through the relay (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q8): opened and closed, and nothing about
// what flowed. Every method takes `tx` (RLS, `agentInstanceRepository`'s reason);
// the relay binds each write to the instance's own workspace.
//
// LIVENESS (MOTIR-6959): each row names the relay process holding it
// (`relayMachineId`) and when that relay last vouched for it (`lastSeenAt`). The
// two cross-tenant READS (the sweep's stale rows, a booting relay's own leftovers)
// run under `withSystemContext` against the table's `FOR SELECT` system arm; every
// WRITE, the heartbeat included, runs bound to the row's own workspace — the
// table has no system write arm, so nothing is ever written untenanted.

export interface AgentTerminalConnectionOpenInput {
  workspaceId: string;
  instanceId: string;
  userId: string;
  /** The socket it carries (`agent-chat.md` Q4 · MOTIR-7013). */
  channel: AgentTerminalChannel;
  openedAt: Date;
  relayMachineId: string;
  lastSeenAt: Date;
}

export interface AgentTerminalConnectionClose {
  closedAt: Date;
  closeCode: number;
  closeReason: string;
}

/** An open row a relay no longer vouches for — what closing it as lost needs. */
export interface LostConnectionRef {
  id: string;
  workspaceId: string;
  lastSeenAt: Date;
}

export const agentTerminalConnectionRepository = {
  /** Record a connection that just opened. `tx` required — a write. */
  async open(
    data: AgentTerminalConnectionOpenInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentTerminalConnection> {
    return tx.agentTerminalConnection.create({ data });
  },

  /** Close an open row, once — a row already closed is left as it is (0). */
  async close(
    id: string,
    close: AgentTerminalConnectionClose,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentTerminalConnection.updateMany({
      where: { id, closedAt: null },
      data: close,
    });
    return count;
  },

  /**
   * THE HEARTBEAT (in the bound workspace): refresh `lastSeenAt` on these rows,
   * only while they are open and held by this relay. Returns how many moved.
   */
  async touchLastSeen(
    ids: string[],
    relayMachineId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentTerminalConnection.updateMany({
      where: { id: { in: ids }, relayMachineId, closedAt: null },
      data: { lastSeenAt: now },
    });
    return count;
  },

  /** The sweep's discovery: open rows last seen at or before `cutoff`, oldest first. */
  async listLost(
    cutoff: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<LostConnectionRef[]> {
    return tx.agentTerminalConnection.findMany({
      where: { closedAt: null, lastSeenAt: { lte: cutoff } },
      select: { id: true, workspaceId: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'asc' },
      take,
    });
  },

  /** A booting relay's discovery: the rows its machine left open. */
  async listOpenByRelayMachine(
    relayMachineId: string,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<LostConnectionRef[]> {
    return tx.agentTerminalConnection.findMany({
      where: { relayMachineId, closedAt: null },
      select: { id: true, workspaceId: true, lastSeenAt: true },
      orderBy: { lastSeenAt: 'asc' },
      take,
    });
  },

  /**
   * Close a row as LOST (in the bound workspace): `closedAt` = its last heartbeat,
   * no close code (no socket close was observed). Guarded on the `lastSeenAt` the
   * caller read, so a heartbeat that lands in between wins and the row stays
   * open. Returns 1 when closed, 0 otherwise.
   */
  async closeLost(
    row: { id: string; lastSeenAt: Date },
    closeReason: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.agentTerminalConnection.updateMany({
      where: { id: row.id, closedAt: null, lastSeenAt: row.lastSeenAt },
      data: { closedAt: row.lastSeenAt, closeCode: null, closeReason },
    });
    return count;
  },
};
