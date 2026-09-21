'use client';

import { useSyncExternalStore } from 'react';
import type { ApprovalGateDTO, ApprovalGateStateDTO } from '@/lib/dto/approvalGate';

// A GATE DECIDED ELSEWHERE ON THIS PAGE (Story MOTIR-5214 · Subtask MOTIR-5225) —
// the signal the To-approve row's CLIENT island watches, so a decision made in the
// approval overlay settles the row underneath it in the same reconcile
// (`design/workbench/design-notes.md` § 22, planning flag 2).
//
// ⚠️ WHY `router.refresh()` IS NOT ENOUGH. The list is a client island (case 3 of
// CLAUDE.md § *Page state after a mutation*). The overlay is mounted in the authed
// SHELL and the list in the Workbench PAGE, so neither is the other's caller: the
// decision has to travel through something both of them can reach.
//
// ⚠️ WHY A KEYED STORE AND NOT A PROVIDER TICK. A tick says *something changed,
// refetch* — and this island has nothing to refetch with. Its rows are the
// server's, and the server's read returns only `awaiting` gates, so a refetch
// REMOVES the row instead of settling it. What the row needs is the state its
// gate reached, keyed by gate. Holding that for the life of the tab is safe
// because a decided gate is immutable (ADR §6a), so an entry never goes stale.
//
// ⚠️ IT CARRIES THE WHOLE DECISION, NOT ONLY ITS STATE (Story MOTIR-5215 ·
// Subtask MOTIR-5570). The item page is the second listener, and it needs more
// than a row does: the status the decision WROTE (`gate.outcomeRef`), so its
// status rail moves without waiting for a server render (Bug MOTIR-5212's
// channel), and whether the approved files were KEPT, so its record says so
// (Bug MOTIR-5265). Both used to arrive from the section's own decide call,
// which that story removes — the decision is now made in the overlay, outside
// the page's optimistic status provider, and this store is the only thing both
// can reach. The row still reads only the state (`useDecidedGateState`).

/** What the overlay announces: the decided row, and the kind's files-kept answer. */
export interface DecidedGate {
  gate: ApprovalGateDTO;
  filesKept: boolean | null;
  /**
   * The status the decision WROTE, when the announcer knows it (MOTIR-5896). Absent,
   * a reader falls back to `gate.outcomeRef` — true for every kind but a choice,
   * whose `outcomeRef` is the option it picked.
   */
  statusWritten?: string | null;
}

const listeners = new Set<() => void>();
let decided: ReadonlyMap<string, DecidedGate> = new Map();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record a decision, and wake every surface watching its gate. */
export function announceGateDecided(decision: DecidedGate): void {
  const { gate } = decision;
  // `awaiting` is not a decision; a repeat is not a change.
  if (gate.state === 'awaiting' || decided.get(gate.id)?.gate.state === gate.state) return;
  decided = new Map(decided).set(gate.id, decision);
  for (const listener of listeners) listener();
}

/** The state `gateId` was decided to on this page, or `null` while it has not been. */
export function useDecidedGateState(gateId: string): ApprovalGateStateDTO | null {
  return useSyncExternalStore(
    subscribe,
    () => decided.get(gateId)?.gate.state ?? null,
    // The server render has seen no decision, and the page hydrates from it.
    () => null,
  );
}

/**
 * The whole decision announced for `gateId` on this page, or `null` while there
 * has been none. The entry object is stable until the gate is announced again,
 * so it is safe as an effect dependency.
 */
export function useDecidedGate(gateId: string): DecidedGate | null {
  return useSyncExternalStore(
    subscribe,
    () => decided.get(gateId) ?? null,
    () => null,
  );
}
