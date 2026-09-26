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

// ── THE COMPOSER REGISTRY (MOTIR-6208; `approval-gates.md` §10f) ──────────────
//
// The seed read (`planningSeedService.getRefusalSeed`, behind `GET
// /api/approval-gates/[id]/planning-seed`) composes the planning surface's
// pre-filled first turn ON THE SERVER, from the decided gate row — the link
// carries the gate id only, never the reason's text. One composer per gate kind.

/** What a composer reads: the gate's work item, the decided gate, and — on an
 *  overturn only — the keys its decision's `## Supersedes` names
 *  (`replanOwedOf`), else `[]`. */
export interface SeedComposerInput {
  card: { key: string; title: string };
  gate: Pick<ApprovalGate, 'kind' | 'state' | 'noteMd'>;
  supersedesKeys: readonly string[];
}

/**
 * A translator bound to the `planningWorkspace.refusalSeed` catalogue namespace
 * (`messages/en.json` / `messages/zh.json`). EVERY word of a first turn comes
 * from there — the templates live in the catalogues, not in code — so the
 * wording can move with the design card (MOTIR-6206) without touching a composer.
 */
export type SeedTranslator = (key: string, values?: Record<string, string>) => string;

/** A composer is PURE: the same row and catalogue always write the same turn. */
export type SeedComposer = (input: SeedComposerInput, t: SeedTranslator) => string;

/** The catalogue namespace the composers' `t` is bound to. */
export const REFUSAL_SEED_NAMESPACE = 'planningWorkspace.refusalSeed';

/**
 * The shared shape of a refusal's first turn, in the design contract's order:
 *
 *  1. the work item's key and title;
 *  2. the verb, in plain words (`<verbKey>`);
 *  3. the reason, QUOTED VERBATIM — `noteMd` is interpolated as a value, so its
 *     line breaks and any `{`/`'` it holds are kept exactly (a legacy refusal
 *     recorded before MOTIR-6067 made the reason required has none, and the
 *     line is omitted rather than quoting nothing);
 *  4. on an overturn only, the supersedes keys — NO keys ⇒ no line, never an
 *     empty one;
 *  5. one sentence asking the planner to re-plan from the reason.
 *
 * The parts are separated by a blank line.
 */
function composeRefusalTurn(
  verbKey: string,
  input: SeedComposerInput,
  t: SeedTranslator,
  withSupersedes: boolean,
): string {
  const parts = [t('heading', { key: input.card.key, title: input.card.title }), t(verbKey)];
  const reason = input.gate.noteMd;
  if (reason && reason.trim() !== '') parts.push(t('reason', { reason }));
  if (withSupersedes && input.supersedesKeys.length > 0) {
    parts.push(t('supersedes', { keys: input.supersedesKeys.join(t('keySeparator')) }));
  }
  parts.push(t('ask'));
  return parts.join('\n\n');
}

/**
 * THE REGISTRY — one composer per gate kind whose refusal seeds a re-plan.
 *
 * `Partial` ON PURPOSE: a kind with no entry has no seed, and the read answers
 * it exactly as it answers an absent gate. This story (MOTIR-6068) ships the
 * three refusals `isRefusalSeedGate` accepts; the next three stories each ADD
 * ONE entry here (and widen the predicate above by the same case) rather than
 * building a read of their own:
 *
 *  - MOTIR-6069 — a PICKED option on a `decision_choice` is planned;
 *  - MOTIR-6070 — a `design_result` sent back is re-planned;
 *  - MOTIR-6071 — an `acceptance_result` sent back is re-planned.
 */
export const REFUSAL_SEED_COMPOSERS: Partial<Record<ApprovalGateKind, SeedComposer>> = {
  /** Request changes on a decision (`changes_requested`). */
  decision_approval: (input, t) => composeRefusalTurn('verb.decisionApproval', input, t, false),
  /** An Overturn of a confirmed decision (`overturned`) — the one composer that
   *  names the supersedes keys. */
  decision_confirmation: (input, t) =>
    composeRefusalTurn('verb.decisionConfirmation', input, t, true),
  /** None of these on a choice (`changes_requested`). */
  decision_choice: (input, t) => composeRefusalTurn('verb.decisionChoice', input, t, false),
};

/** The composer for a gate's kind, or `null` when that kind has none yet. */
export function refusalSeedComposerFor(kind: ApprovalGateKind): SeedComposer | null {
  return Object.prototype.hasOwnProperty.call(REFUSAL_SEED_COMPOSERS, kind)
    ? (REFUSAL_SEED_COMPOSERS[kind] ?? null)
    : null;
}
