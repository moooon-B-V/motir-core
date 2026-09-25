'use client';

import { useCallback, useMemo, useState } from 'react';
import type { StatusHeldLine } from './StatusHeldNotice';
import type { ApprovalGatePendingPayloadDTO, HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';

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
 *
 * And a PLAN HOLD (Story MOTIR-6017 · MOTIR-6267; `agent-authored-plans.md`
 * AMENDMENT 21; `design/work-items/design-notes.md` § _The status control says a
 * PLAN holds it_) — seeded from `planTargetLockService.readPlanHold`, folded by a
 * `PLAN_TARGET_HELD` refusal. A gate holds ONE status; a plan holds EVERY move, so
 * while it holds, every option but the current one is locked.
 */
const EMPTY: HeldTransitionDTO[] = [];

/** One locked picker target, and WHY it is locked — the `StatusPicker`'s `held`. */
export interface HeldTarget {
  statusKey: string;
  waitingOn: 'decision' | 'merge' | 'plan';
}

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

function planSignature(plan: PlanHoldDTO | null): string {
  return plan
    ? [plan.planId, plan.planStatus, plan.sessionId ?? '', plan.anchorKey ?? ''].join('\u0000')
    : '';
}

function seedSignature(held: HeldTransitionDTO[], plan: PlanHoldDTO | null): string {
  const gates = held
    .map((h) =>
      [h.statusKey, h.waitingOn, h.kind, h.gateId ?? '', h.canDecide, h.routedToLabel ?? ''].join(
        '\u0000',
      ),
    )
    .join('\u0001');
  return `${gates}\u0002${planSignature(plan)}`;
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
  /**
   * The undecided plan holding the card at Planning, from the same server read
   * (`planTargetLockService.readPlanHold`) — `null` / absent when none does.
   */
  initialPlan?: PlanHoldDTO | null,
) {
  const seed = initial ?? EMPTY;
  const planSeed = initialPlan ?? null;
  const [lines, setLines] = useState<StatusHeldLine[]>(() => toLines(seed));
  // `at` — the status the card was SHOWING when a refusal said a plan holds it.
  // The refusal is the server's word that the card is at Planning even when this
  // page still shows an older status (a plan took it after render), so the line
  // stands at that status too, until the card shows anything else. `null` for the
  // server read, which is only ever non-null at Planning.
  const [plan, setPlan] = useState<{ hold: PlanHoldDTO; at: string | null } | null>(() =>
    planSeed ? { hold: planSeed, at: null } : null,
  );
  // A NEW server read — the quick view moving to another item, or the page
  // re-rendering with fresh props — replaces the folded state rather than being
  // ignored by a `useState` initializer that only ran once (the client-island
  // rule in CLAUDE.md § Page state after a mutation). Adjusted during render,
  // the React-sanctioned way to derive state from a changed prop.
  //
  // ⚠️ Keyed on the read's CONTENT, never its identity: a caller passing a fresh
  // array each render (an inline `[]`, a default parameter) would otherwise reset
  // on every render and loop.
  const signature = seedSignature(seed, planSeed);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setLines(toLines(seed));
    setPlan(planSeed ? { hold: planSeed, at: null } : null);
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

  /** A `PLAN_TARGET_HELD` refusal — a plan that took the card after render. The
   *  surface reverts and this draws the plan line, instead of a toast. */
  const onPlanHeldRefused = useCallback(
    (next: PlanHoldDTO) => {
      setPlan({ hold: next, at: currentStatus ?? null });
    },
    [currentStatus],
  );

  const onMoved = useCallback((toStatusKey: string) => {
    setLines((prev) => prev.filter((l) => l.statusKey !== toStatusKey));
    // A move that went through means nothing holds the card any more.
    if (toStatusKey !== PLANNING_STATUS_KEY) setPlan(null);
  }, []);

  // ⚠️ Filtered at READ time, not only on this control's own moves: an approval
  // decided in the overlay repaints the status in place with no call through here,
  // and a line left for the status the card now has reads as a held move it has
  // already made (`approval-gate-repaint.spec.ts`).
  const visible = useMemo(
    () => (currentStatus ? lines.filter((l) => l.statusKey !== currentStatus) : lines),
    [lines, currentStatus],
  );
  // ⚠️ The same READ-TIME rule for the plan: a plan holds a card only AT Planning
  // (AMENDMENT 21 §1), so once the card shows any other status — whatever moved
  // it — the line and the locks drop. (Or, for a refusal, once it shows anything
  // but the status it showed when refused.)
  const visiblePlan =
    plan &&
    (currentStatus === undefined ||
      currentStatus === PLANNING_STATUS_KEY ||
      currentStatus === plan.at)
      ? plan.hold
      : null;
  const held = useMemo<HeldTarget[]>(
    () =>
      visiblePlan
        ? // A plan holds EVERY move: every option but the current one is locked.
          statuses
            .filter((s) => s.key !== currentStatus)
            .map((s) => ({ statusKey: s.key, waitingOn: 'plan' as const }))
        : visible.map((l) => ({ statusKey: l.statusKey, waitingOn: l.waitingOn })),
    [visible, visiblePlan, statuses, currentStatus],
  );

  return { lines: visible, plan: visiblePlan, held, onRefused, onPlanHeldRefused, onMoved };
}
