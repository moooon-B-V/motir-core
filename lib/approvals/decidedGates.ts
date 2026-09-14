'use client';

import { useSyncExternalStore } from 'react';
import type { ApprovalGateStateDTO } from '@/lib/dto/approvalGate';

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
// It carries the decided STATE and nothing else: a settled row's Decide cell
// renders a state pill and reads nothing more from the gate.

const listeners = new Set<() => void>();
let decided: ReadonlyMap<string, ApprovalGateStateDTO> = new Map();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record that `gateId` was decided to `state`, and wake every row watching it. */
export function announceGateDecided(gateId: string, state: ApprovalGateStateDTO): void {
  // `awaiting` is not a decision; a repeat is not a change.
  if (state === 'awaiting' || decided.get(gateId) === state) return;
  decided = new Map(decided).set(gateId, state);
  for (const listener of listeners) listener();
}

/** The state `gateId` was decided to on this page, or `null` while it has not been. */
export function useDecidedGateState(gateId: string): ApprovalGateStateDTO | null {
  return useSyncExternalStore(
    subscribe,
    () => decided.get(gateId) ?? null,
    // The server render has seen no decision, and the page hydrates from it.
    () => null,
  );
}
