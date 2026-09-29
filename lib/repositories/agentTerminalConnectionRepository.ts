import type { AgentTerminalConnection, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `agent_terminal_connection` — one row per terminal
// connection through the relay (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q8): opened and closed, and nothing about
// what flowed. Every method takes `tx` (RLS, `agentInstanceRepository`'s reason);
// the relay binds each write to the instance's own workspace.

export interface AgentTerminalConnectionOpenInput {
  workspaceId: string;
  instanceId: string;
  userId: string;
  openedAt: Date;
}

export interface AgentTerminalConnectionClose {
  closedAt: Date;
  closeCode: number;
  closeReason: string;
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
};
