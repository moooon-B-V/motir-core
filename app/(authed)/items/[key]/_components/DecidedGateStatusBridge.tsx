'use client';

import { useEffect, useRef } from 'react';
import { useDecidedGate } from '@/lib/approvals/decidedGates';
import { useOptimisticStatusWriter } from './OptimisticStatusProvider';

// A DECISION MADE IN THE OVERLAY MOVES THIS PAGE'S STATUS RAIL (Story MOTIR-5215 ·
// Subtask MOTIR-5570).
//
// The approval overlay is mounted in the authed SHELL, outside this page's
// `OptimisticStatusProvider`, so when it decides the page's gate it cannot call
// `applyOptimisticStatus` itself — and `router.refresh()` alone is the RSC apply
// Bug MOTIR-5118 measured being lost (the rail stale for twenty seconds). It
// announces the decision instead (`lib/approvals/decidedGates.ts`), and this
// island, rendered INSIDE the provider beside the Design result section, hears
// it and applies the status the decision wrote. A `null` `outcomeRef` (a request
// for changes moves nothing) applies nothing, which is the provider's contract.
// Reconcile needs nothing here: the provider drops its override the moment the
// server's status moves.

export function DecidedGateStatusBridge({ gateId }: { gateId: string }) {
  const entry = useDecidedGate(gateId);
  const { applyOptimisticStatus } = useOptimisticStatusWriter();

  // ⚠️ SEEDED WITH WHAT THE STORE HELD AT MOUNT, so only a decision that ARRIVES
  // while this page is open is applied. The store lives for the tab, and a gate
  // decided an hour ago on another visit to this card is already in the server's
  // status — or has been moved on since (reopened by hand), in which case
  // re-applying its old `outcomeRef` would draw a status the card is no longer in.
  const seen = useRef(entry);

  useEffect(() => {
    if (entry === null || entry === seen.current) return;
    seen.current = entry;
    applyOptimisticStatus(entry.gate.outcomeRef);
  }, [entry, applyOptimisticStatus]);

  return null;
}
