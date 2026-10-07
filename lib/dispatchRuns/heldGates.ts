import type { ApprovalGateKind } from '@/generated/prisma/client';

/**
 * THE GATE KINDS THAT HOLD A RUN (Story MOTIR-7701 · MOTIR-7703;
 * `docs/decisions/dispatch-run-record.md` AMENDMENT 2026-10-07) — the gates a
 * parent run's stoppers raise: a design child's result, a decision child's
 * page or choice or confirmation, and a manual child's `manual_work` gate
 * (MOTIR-7458).
 *
 * `pull_request_approval`, `pull_request_merge`, `acceptance_result`,
 * `plan_approval` and `agent_review` never stop a parent run mid-story, so a
 * `gated` close never records them.
 */
export const RUN_HOLDING_GATE_KINDS: readonly ApprovalGateKind[] = [
  'design_result',
  'decision_approval',
  'decision_choice',
  'decision_confirmation',
  'manual_work',
];

export function isRunHoldingGateKind(kind: ApprovalGateKind): boolean {
  return RUN_HOLDING_GATE_KINDS.includes(kind);
}
