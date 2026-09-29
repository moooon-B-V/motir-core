import type { AgentInstance } from '@/generated/prisma/client';
import { AgentInstancesUnavailableError } from '@/lib/agentInstances/errors';
import { terminalMasterKey } from '@/lib/agentInstances/terminal';
import {
  TERMINAL_CLOSE,
  type AgentTerminalCloseReason,
  type TerminalRefusalCode,
} from '@/lib/agentTerminal/protocol';
import { relayAuthorization } from '@/lib/agentTerminal/relayToken';
import { hashTerminalTicket } from '@/lib/agentTerminal/ticket';
import { persistentTerminalEndpoint, selectedOrchestratorProvider } from '@/lib/orchestrator';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentTerminalConnectionRepository } from '@/lib/repositories/agentTerminalConnectionRepository';
import { agentTerminalTicketRepository } from '@/lib/repositories/agentTerminalTicketRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE TERMINAL RELAY'S MOTIR SIDE (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3, Q8) — every database question the relay
// asks, so the relay stays a thin transport:
//
//   * `authorizeConnection` — redeem the ticket (single use: ONE guarded update,
//     bound to the ticket's own workspace), RE-READ the instance (still that
//     user's, not deleted, serving a terminal, running) and answer Q3's close
//     code, or where to dial with the one-shot relay token already signed.
//   * `openConnection` / `closeConnection` — the one row per connection (Q8).
//   * `sweepExpiredTickets` — `system.agent-instance-sweep`'s ticket step.
//
// ⚠️ THIS FILE'S IMPORT GRAPH IS THE RELAY APP'S. `motir-relay` holds only
// `DATABASE_URL`, the master key, `MOTIR_BASE_URL` and `SENTRY_DSN` (Q1), so
// nothing here may reach `projectsService` / `lib/auth` (which refuse to load
// without the web app's secrets). The ticket's MINTING, which needs the project
// and its permissions, is `agentTerminalService`, in the web app.

/** The clock, as a seam so a test can move time without sleeping. */
export const agentTerminalClock = {
  now: (): Date => new Date(),
};

/** How many expired tickets one sweep pass reads; the next pass continues. */
const SWEEP_BATCH = 500;

function requireMasterKey(): string {
  const key = terminalMasterKey();
  if (!key) throw new AgentInstancesUnavailableError('the agent terminal is not configured');
  return key;
}

/** Where the relay dials, and as whom — everything it needs for one connection. */
export interface AgentTerminalConnectionTarget {
  instanceId: string;
  userId: string;
  workspaceId: string;
  /** The agent's terminal server: its address and the headers the dial carries. */
  dial: { url: string; headers: Record<string, string> };
}

export type AgentTerminalAuthorization =
  | { ok: true; target: AgentTerminalConnectionTarget }
  | { ok: false; closeCode: TerminalRefusalCode };

function refuse(closeCode: TerminalRefusalCode): AgentTerminalAuthorization {
  return { ok: false, closeCode };
}

/** Q3's re-read, in the table's order: why this instance cannot be dialled now — or null. */
function connectionRefusal(row: AgentInstance, userId: string): TerminalRefusalCode | null {
  if (row.deletedAt || row.ownerId !== userId) return TERMINAL_CLOSE.notOwner;
  if (row.terminalServer === 'absent') return TERMINAL_CLOSE.noTerminalServer;
  if (row.state !== 'running' || !row.flyApp || !row.machineId || !row.volumeId) {
    return TERMINAL_CLOSE.notRunning;
  }
  return null;
}

export const agentTerminalRelayService = {
  /**
   * THE RELAY'S ONE QUESTION: may this ticket's holder have a terminal, and
   * where? Redeems the ticket (4401 if it is unknown, expired or already used),
   * re-reads the instance (4403 not the ticket's user's or deleted, 4410 no
   * terminal server, 4409 not running), and answers the dial with a freshly
   * signed relay token. Never throws for a refusal.
   */
  async authorizeConnection(ticket: string): Promise<AgentTerminalAuthorization> {
    if (ticket.length === 0 || ticket.length > 256) return refuse(TERMINAL_CLOSE.badTicket);
    const now = agentTerminalClock.now();
    const found = await withSystemContext((tx) =>
      agentTerminalTicketRepository.findByHash(hashTerminalTicket(ticket), tx),
    );
    if (!found) return refuse(TERMINAL_CLOSE.badTicket);
    // The consume is bound to the ticket's own workspace: nothing is written
    // untenanted. Two relays racing on one ticket get 1 and 0.
    const consumed = await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      agentTerminalTicketRepository.consume(found.id, now, tx),
    );
    if (consumed !== 1) return refuse(TERMINAL_CLOSE.badTicket);

    const row = await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      agentInstanceRepository.findById(found.instanceId, tx),
    );
    /* v8 ignore next -- the ticket's FK cascades: a ticket never outlives its instance row. */
    if (!row) return refuse(TERMINAL_CLOSE.notOwner);
    const refusal = connectionRefusal(row, found.userId);
    if (refusal !== null) return refuse(refusal);

    const handle = {
      provider: selectedOrchestratorProvider(),
      app: row.flyApp!,
      machineId: row.machineId!,
      volumeId: row.volumeId!,
      region: row.region,
      createdAt: row.createdAt,
    };
    const endpoint = persistentTerminalEndpoint(handle);
    const authorization = relayAuthorization({
      masterKey: requireMasterKey(),
      instanceId: row.id,
      machineId: handle.machineId,
      nowMs: now.getTime(),
    });
    return {
      ok: true,
      target: {
        instanceId: row.id,
        userId: found.userId,
        workspaceId: row.workspaceId,
        dial: { url: endpoint.url, headers: { ...endpoint.headers, authorization } },
      },
    };
  },

  /** Record a connection the relay just opened (Q8). Returns the row's id. */
  async openConnection(input: {
    workspaceId: string;
    instanceId: string;
    userId: string;
  }): Promise<string> {
    const row = await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      agentTerminalConnectionRepository.open({ ...input, openedAt: agentTerminalClock.now() }, tx),
    );
    return row.id;
  },

  /** Close a connection's row with the browser's close code and the relay's reason. Once. */
  async closeConnection(input: {
    id: string;
    workspaceId: string;
    closeCode: number;
    closeReason: AgentTerminalCloseReason;
  }): Promise<void> {
    await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      agentTerminalConnectionRepository.close(
        input.id,
        {
          closedAt: agentTerminalClock.now(),
          closeCode: input.closeCode,
          closeReason: input.closeReason,
        },
        tx,
      ),
    );
  },

  /**
   * Delete every ticket past its life (Q3: "swept"), in each ticket's own
   * workspace. Bounded per pass; returns how many were deleted.
   */
  async sweepExpiredTickets(): Promise<{ deleted: number }> {
    const now = agentTerminalClock.now();
    const expired = await withSystemContext((tx) =>
      agentTerminalTicketRepository.listExpired(now, SWEEP_BATCH, tx),
    );
    const byWorkspace = new Map<string, string[]>();
    for (const t of expired) {
      const ids = byWorkspace.get(t.workspaceId) ?? [];
      ids.push(t.id);
      byWorkspace.set(t.workspaceId, ids);
    }
    let deleted = 0;
    for (const [workspaceId, ids] of byWorkspace) {
      deleted += await withWorkspaceServiceContext(workspaceId, (tx) =>
        agentTerminalTicketRepository.deleteExpired(ids, now, tx),
      );
    }
    return { deleted };
  },
};
