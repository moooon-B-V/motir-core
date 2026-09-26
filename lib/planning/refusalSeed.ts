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

/** The fields the predicate reads — a whole `ApprovalGate` row satisfies it (and so
 *  does the gate DTO, which carries `refusalVerdict` since MOTIR-6421). */
export type RefusalSeedGateFacts = Pick<ApprovalGate, 'kind' | 'state' | 'refusalVerdict'>;

/**
 * Is this gate a REFUSAL that may seed a re-plan?
 *
 *  - `decision_approval` / `decision_choice` in `changes_requested` — Request
 *    changes on a decision, None of these on a choice (MOTIR-6067's reason is
 *    required on both);
 *  - `decision_confirmation` in `overturned` — an Overturn;
 *  - `design_result` in `changes_requested` refused with the **Re-plan** verdict
 *    (`refusalVerdict === 're_plan'`; MOTIR-6070 · MOTIR-6424,
 *    `docs/decisions/design-refusal-verdict.md` §3). A **Revise**, a GitHub-synced
 *    refusal (which carries no verdict) and a refusal recorded before the verdict
 *    existed are NOT: they ask nothing and seed nothing.
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
      return gate.state === 'changes_requested' && gate.refusalVerdict === 're_plan';
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
 *  (`replanOwedOf`), else `[]`. A design Re-plan (MOTIR-6424) also reads the
 *  seed's ANCHOR (`anchorKey` — the design card's parent, §10h) and the keys of the
 *  not-`done` cards `blocked_by` the design (`waitingKeys`); the decision kinds
 *  ignore both. */
export interface SeedComposerInput {
  card: { key: string; title: string };
  gate: Pick<ApprovalGate, 'kind' | 'state' | 'noteMd'>;
  supersedesKeys: readonly string[];
  /** The work item the seeded session anchors on — the card itself for the
   *  decision kinds, the design card's parent for a design Re-plan. */
  anchorKey: string;
  /** The open work waiting on the card (its `blocks` edges), in order. */
  waitingKeys: readonly string[];
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
 * A DESIGN sent back to Re-plan (MOTIR-6424; the MOTIR-6420 design's first-turn
 * contract) — the same shape with one new part:
 *
 *  1. the DESIGN card's key and title (`heading`);
 *  2. `verb.designResult`;
 *  3. the reason, quoted verbatim (`reason`, omitted when there is none);
 *  4. `blockedBy` — the keys of the open cards waiting on the design, joined by
 *     `keySeparator`. NO card waiting ⇒ NO line, never a "none" one;
 *  5. `askDesign`, naming the ANCHOR — the design card's parent.
 */
function composeDesignReplanTurn(input: SeedComposerInput, t: SeedTranslator): string {
  const parts = [
    t('heading', { key: input.card.key, title: input.card.title }),
    t('verb.designResult'),
  ];
  const reason = input.gate.noteMd;
  if (reason && reason.trim() !== '') parts.push(t('reason', { reason }));
  if (input.waitingKeys.length > 0) {
    parts.push(t('blockedBy', { keys: input.waitingKeys.join(t('keySeparator')) }));
  }
  parts.push(t('askDesign', { parent: input.anchorKey }));
  return parts.join('\n\n');
}

/**
 * THE REGISTRY — one composer per gate kind whose refusal seeds a re-plan.
 *
 * `Partial` ON PURPOSE: a kind with no entry has no seed, and the read answers
 * it exactly as it answers an absent gate. MOTIR-6068 shipped the three
 * refusals of the decision kinds; MOTIR-6070 (MOTIR-6424) added `design_result`
 * sent back with the Re-plan verdict. The remaining stories each ADD ONE entry
 * here (and widen the predicate above by the same case) rather than building a
 * read of their own:
 *
 *  - MOTIR-6069 — a PICKED option on a `decision_choice` is planned;
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
  /** A design sent back with the Re-plan verdict (`changes_requested` +
   *  `re_plan`) — anchored on the design card's parent. */
  design_result: composeDesignReplanTurn,
};

/** The composer for a gate's kind, or `null` when that kind has none yet. */
export function refusalSeedComposerFor(kind: ApprovalGateKind): SeedComposer | null {
  return Object.prototype.hasOwnProperty.call(REFUSAL_SEED_COMPOSERS, kind)
    ? (REFUSAL_SEED_COMPOSERS[kind] ?? null)
    : null;
}

/**
 * Does a seed of this kind anchor on the card's PARENT rather than the card?
 * (`approval-gates.md` §10h; `design-refusal-verdict.md` §3.) Only a design
 * Re-plan does: what a design changes is the work planned after it, so the
 * planner opens on the item holding that work. A parentless (root or
 * folder-filed) design card anchors on itself. The seed read resolves the anchor
 * with it and the session stamp (`assertSeedApplicableWithin`) accepts it, so the
 * two can never disagree; the decision kinds keep anchoring on their own card.
 */
export function refusalSeedAnchorsOnParent(kind: ApprovalGateKind): boolean {
  return kind === 'design_result';
}
