'use client';

import { useEffect, type RefObject } from 'react';
import type { StatusHeldLine } from './StatusHeldNotice';
import type { ApprovalGatePendingPayloadDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';

// The ANCHORED held refusal — shared by the two surfaces that learn about a held
// move only by attempting it: the board drag and the `/items` row's inline status
// edit (Story MOTIR-4887 · Subtask MOTIR-5529; `design/boards/design-notes.md`
// § panel 2b and the status-control design's list-row panel). Neither may read the
// gate up front — a column and a list page hold many cards — so both render the
// refusal the server sent.

/** The one line a refusal draws, built from the door's payload and the target's
 *  own label. */
export function heldLineFromRefusal(
  statusKey: string,
  statusLabel: string,
  gate: ApprovalGatePendingPayloadDTO,
): StatusHeldLine {
  return {
    statusKey,
    statusLabel,
    waitingOn: gate.waitingOn,
    kind: gate.kind,
    gateRaised: gate.gateRaised,
    canDecide: gate.canDecide,
    routedToLabel: gate.routedToLabel,
  };
}

/**
 * A HELD refusal, tagged by the door's `code` (MOTIR-5529 · MOTIR-6268): an
 * approval or a merge holds ONE target status (`APPROVAL_GATE_PENDING`, with the
 * gate), or an undecided PLAN holds the whole item at Planning
 * (`PLAN_TARGET_HELD`, with the plan — AMENDMENT 21 §2).
 */
export type HeldRefusal =
  | { code: 'APPROVAL_GATE_PENDING'; gate: ApprovalGatePendingPayloadDTO }
  | { code: 'PLAN_TARGET_HELD'; plan: PlanHoldDTO };

/** Read a HELD refusal off a refused board move, or null for every other refusal
 *  — which keeps its toast, unchanged. It branches on `code` and nothing else:
 *  never the HTTP status alone, never the message text. */
export async function readHeldRefusal(res: Response): Promise<HeldRefusal | null> {
  if (res.status !== 409) return null;
  try {
    const body = (await res.clone().json()) as {
      code?: string;
      gate?: ApprovalGatePendingPayloadDTO;
      plan?: PlanHoldDTO;
    };
    if (body.code === 'APPROVAL_GATE_PENDING' && body.gate) {
      return { code: 'APPROVAL_GATE_PENDING', gate: body.gate };
    }
    if (body.code === 'PLAN_TARGET_HELD' && body.plan) {
      return { code: 'PLAN_TARGET_HELD', plan: body.plan };
    }
    return null;
  } catch {
    return null;
  }
}

/** Close an anchored refusal on `Esc` or a pointer-down outside `ref`. */
export function useDismissOnEscapeOrOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [ref, open, onClose]);
}
