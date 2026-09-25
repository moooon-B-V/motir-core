import type { ApprovalGate, ApprovalGateKind } from '@/generated/prisma/client';

// The REFUSAL SEED — which decided approval gates may open (seed) a planning
// session (story MOTIR-6068; `docs/decisions/approval-gates.md` §10f and
// `docs/decisions/agent-authored-plans.md` AMENDMENT 17 §9).
//
// ONE predicate, owned here, so the session stamp (MOTIR-6207's
// `planChangeSessionsService.startSeededWithFirstTurn`), the seed read
// (MOTIR-6208) and the record band's door can never disagree on what counts as a
// refusal worth re-planning. The seed read adds its per-kind composer registry
// beside it; MOTIR-6069, MOTIR-6070 and MOTIR-6071 each widen the predicate by
// one kind's case when their story ships a seed for it.

/** The fields the predicate reads — a whole `ApprovalGate` row satisfies it. */
export type RefusalSeedGateFacts = Pick<ApprovalGate, 'kind' | 'state'>;

/**
 * Is this gate a REFUSAL that may seed a re-plan?
 *
 *  - `decision_approval` / `decision_choice` in `changes_requested` — Request
 *    changes on a decision, None of these on a choice (MOTIR-6067's reason is
 *    required on both);
 *  - `decision_confirmation` in `overturned` — an Overturn.
 *
 * Every other kind answers `false` in every state until its own story adds a
 * case. The switch is EXHAUSTIVE over `ApprovalGateKind` (the `never` arm), so a
 * new gate kind fails the type-check here instead of silently answering
 * `undefined` — a lookup keyed off an enum must be total.
 */
export function isRefusalSeedGate(gate: RefusalSeedGateFacts): boolean {
  const kind: ApprovalGateKind = gate.kind;
  switch (kind) {
    case 'decision_approval':
    case 'decision_choice':
      return gate.state === 'changes_requested';
    case 'decision_confirmation':
      return gate.state === 'overturned';
    case 'design_result':
    case 'pull_request_approval':
    case 'pull_request_merge':
    case 'acceptance_result':
    case 'plan_approval':
      return false;
    default: {
      // A compile-time exhaustiveness check; at runtime an unknown value (a
      // kind newer than this build) is not a refusal seed.
      const unreachable: never = kind;
      void unreachable;
      return false;
    }
  }
}
