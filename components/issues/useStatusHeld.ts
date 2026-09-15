'use client';

import { useCallback, useMemo, useState } from 'react';
import type { StatusHeldLine } from './StatusHeldNotice';
import type { ApprovalGatePendingPayloadDTO, HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

/**
 * The status control's HELD state for one work item (Story MOTIR-4887 · Subtask
 * MOTIR-5528) — shared by the item page, the quick view and the edit page, so the
 * three draw one thing.
 *
 * Seeded from the server read (`approvalGatesService.listHeldTransitions`), and
 * folded forward by the two events a surface sees after render:
 *
 *   · a REFUSAL that arrives anyway — a gate raised, or a pull request linked,
 *     after the page rendered. The action returns `code: 'APPROVAL_GATE_PENDING'`
 *     with the payload; the surface reverts and this adds (or replaces) that
 *     status's line, instead of a toast;
 *   · a status the card MOVED to — nothing is held about a status the card
 *     already has, so that line drops. (The rest refresh on the next server read;
 *     an inline edit does not re-read — the page-state rule.)
 */
const EMPTY: HeldTransitionDTO[] = [];

function toLines(held: HeldTransitionDTO[]): StatusHeldLine[] {
  return held.map((h) => ({
    statusKey: h.statusKey,
    statusLabel: h.statusLabel,
    waitingOn: h.waitingOn,
    kind: h.kind,
    gateRaised: h.gateId !== null,
    canDecide: h.canDecide,
    routedToLabel: h.routedToLabel,
  }));
}

function seedSignature(held: HeldTransitionDTO[]): string {
  return held
    .map((h) =>
      [h.statusKey, h.waitingOn, h.kind, h.gateId ?? '', h.canDecide, h.routedToLabel ?? ''].join(
        '\u0000',
      ),
    )
    .join('\u0001');
}

export function useStatusHeld(
  initial: HeldTransitionDTO[] | undefined,
  statuses: WorkflowStatusDto[],
  /**
   * The status the card has NOW, whatever moved it — this control, an approval
   * repainting the page in place, a server refresh. Nothing is held about a status
   * the card already has, so its line never renders.
   */
  currentStatus?: string,
) {
  const seed = initial ?? EMPTY;
  const [lines, setLines] = useState<StatusHeldLine[]>(() => toLines(seed));
  // A NEW server read — the quick view moving to another item, or the page
  // re-rendering with fresh props — replaces the folded state rather than being
  // ignored by a `useState` initializer that only ran once (the client-island
  // rule in CLAUDE.md § Page state after a mutation). Adjusted during render,
  // the React-sanctioned way to derive state from a changed prop.
  //
  // ⚠️ Keyed on the read's CONTENT, never its identity: a caller passing a fresh
  // array each render (an inline `[]`, a default parameter) would otherwise reset
  // on every render and loop.
  const signature = seedSignature(seed);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setLines(toLines(seed));
  }

  const onRefused = useCallback(
    (toStatusKey: string, gate: ApprovalGatePendingPayloadDTO) => {
      const statusLabel = statuses.find((s) => s.key === toStatusKey)?.label ?? toStatusKey;
      setLines((prev) => [
        ...prev.filter((l) => l.statusKey !== toStatusKey),
        {
          statusKey: toStatusKey,
          statusLabel,
          waitingOn: gate.waitingOn,
          kind: gate.kind,
          gateRaised: gate.gateRaised,
          canDecide: gate.canDecide,
          routedToLabel: gate.routedToLabel,
        },
      ]);
    },
    [statuses],
  );

  const onMoved = useCallback((toStatusKey: string) => {
    setLines((prev) => prev.filter((l) => l.statusKey !== toStatusKey));
  }, []);

  // ⚠️ Filtered at READ time, not only on this control's own moves: an approval
  // decided in the overlay repaints the status in place with no call through here,
  // and a line left for the status the card now has reads as a held move it has
  // already made (`approval-gate-repaint.spec.ts`).
  const visible = useMemo(
    () => (currentStatus ? lines.filter((l) => l.statusKey !== currentStatus) : lines),
    [lines, currentStatus],
  );
  const held = useMemo(
    () => visible.map((l) => ({ statusKey: l.statusKey, waitingOn: l.waitingOn })),
    [visible],
  );

  return { lines: visible, held, onRefused, onMoved };
}
