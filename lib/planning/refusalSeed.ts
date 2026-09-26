import type { ApprovalGate, ApprovalGateKind } from '@/generated/prisma/client';
import type { ChosenOption } from '@/lib/approvalGates/choiceOptions';

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

// ── THE PICK SEED (story MOTIR-6069 · MOTIR-6433; `docs/decisions/picked-option-planning.md`) ──
//
// A PICKED option on a `decision_choice` seeds a planning session too — but it is
// NOT a refusal, and `isRefusalSeedGate` keeps meaning refusal: the ask after a
// press (`asksToReplanAfterPress`) and the Re-plan door read it, and a pick must
// never reach either. So the pick gets its own predicate, and the seed read asks
// the UMBRELLA of the two.

/** The fields the pick predicate reads — a whole `ApprovalGate` row satisfies it. */
export type PickSeedGateFacts = Pick<ApprovalGate, 'kind' | 'state' | 'chosenOption'>;

/**
 * Is this gate a PICK that may seed a planning session — an option chosen on a
 * `decision_choice` (`approved`), with its `chosenOption` stamped? A choice
 * decided before the stamp existed carries none, and has nothing to seed from.
 */
export function isPickSeedGate(gate: PickSeedGateFacts): boolean {
  return gate.kind === 'decision_choice' && gate.state === 'approved' && gate.chosenOption !== null;
}

/** May this gate seed a planning session at all — a refusal OR a pick? */
export function isPlanningSeedGate(gate: PickSeedGateFacts): boolean {
  return isRefusalSeedGate(gate) || isPickSeedGate(gate);
}

/** What the seeded turn asks for: `plan` forward after a pick, `replan` after a refusal. */
export type PlanningSeedIntent = 'plan' | 'replan';

/** The intent of a gate the umbrella accepts. */
export function seedIntentOf(gate: PickSeedGateFacts): PlanningSeedIntent {
  return isPickSeedGate(gate) ? 'plan' : 'replan';
}

/**
 * The stamped `chosenOption` JSON, read DEFENSIVELY: the column is `Json`, so a
 * row that does not carry the four string fields is treated as no stamp at all
 * (the read then answers its ordinary no-leak 404) rather than composing a turn
 * out of `undefined`.
 */
export function readChosenOption(value: unknown): ChosenOption | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.optionId !== 'string' ||
    typeof v.label !== 'string' ||
    typeof v.bestFor !== 'string' ||
    typeof v.followUp !== 'string'
  ) {
    return null;
  }
  return value as ChosenOption;
}

/** One ancestor of the gate's work item, as the anchor walk reads it. */
export interface SeedAncestor {
  key: string;
  /** The ancestor's status CATEGORY in its project's workflow — never the literal key. */
  statusCategory: string | null;
  archived: boolean;
}

/**
 * WHERE the seeded planning surface anchors — a TOTAL per-kind resolver, pure.
 *
 *  - every refusal (and every other kind) anchors on the gate's OWN work item;
 *  - a PICK anchors on the choice's PARENT: the nearest ancestor, walking UP from
 *    the parent, that is neither in a `done`-category status nor archived. A done
 *    card may not be given children, and the owed pass lays under the container
 *    the level stopped at (`picked-option-planning.md` §2).
 *
 * `null` means THE PROJECT — a root choice, a folder-filed one, or a chain whose
 * every ancestor is done. `ancestors` is ordered root → parent, as
 * `workItemRepository.findAncestors` returns them.
 *
 * The switch is EXHAUSTIVE over `ApprovalGateKind`, so MOTIR-6424 moving the
 * `design_result` arm to its parent is a one-arm change here.
 */
export function anchorOf(
  gate: PickSeedGateFacts,
  itemKey: string,
  ancestors: readonly SeedAncestor[],
): string | null {
  const kind: ApprovalGateKind = gate.kind;
  switch (kind) {
    case 'decision_choice': {
      if (!isPickSeedGate(gate)) return itemKey;
      for (let i = ancestors.length - 1; i >= 0; i -= 1) {
        const a = ancestors[i]!;
        if (!a.archived && a.statusCategory !== 'done') return a.key;
      }
      return null;
    }
    case 'decision_approval':
    case 'decision_confirmation':
    case 'design_result':
    case 'pull_request_approval':
    case 'pull_request_merge':
    case 'acceptance_result':
    case 'plan_approval':
      return itemKey;
    default: {
      const unreachable: never = kind;
      void unreachable;
      return itemKey;
    }
  }
}

// ── THE COMPOSER REGISTRY (MOTIR-6208; `approval-gates.md` §10f) ──────────────
//
// The seed read (`planningSeedService.getPlanningSeed`, behind `GET
// /api/approval-gates/[id]/planning-seed`) composes the planning surface's
// pre-filled first turn ON THE SERVER, from the decided gate row — the link
// carries the gate id only, never the reason's text. One composer per gate kind.

/** What a composer reads: the gate's work item, the decided gate, and — on an
 *  overturn only — the keys its decision's `## Supersedes` names
 *  (`replanOwedOf`), else `[]`. A PICK also reads the stamped `chosenOption`
 *  (never the current body) and the resolved anchor (`null` = the project). */
export interface SeedComposerInput {
  card: { key: string; title: string };
  gate: Pick<ApprovalGate, 'kind' | 'state' | 'noteMd'>;
  supersedesKeys: readonly string[];
  chosenOption?: ChosenOption | null;
  anchorKey?: string | null;
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
 * The first turn of a PICK (MOTIR-6433; design MOTIR-6432 sheet 1–2), in order:
 *
 *  1. the choice's key and title;
 *  2. on a PROJECT anchor only, one line saying the choice had no open container;
 *  3. the option chosen and its best-if line;
 *  4. what the choice gates (`followUp`, verbatim);
 *  5. one sentence asking to PLAN that work with the option.
 *
 * Every value is interpolated as a VALUE, so the stamped text's line breaks and
 * braces survive, exactly as `composeRefusalTurn` does for `noteMd`.
 */
function composePickTurn(input: SeedComposerInput, t: SeedTranslator): string {
  const chosen = input.chosenOption;
  /* v8 ignore next -- the seed read never composes a pick without a stamp. */
  if (!chosen) return t('heading', { key: input.card.key, title: input.card.title });
  const parts = [t('heading', { key: input.card.key, title: input.card.title })];
  // The line that tells the PLANNER this is the follow-up to a choice just made
  // (MOTIR-6432's revised design); the rail's chip and card tell the person.
  parts.push(t('pick.followUp'));
  if (input.anchorKey === null) parts.push(t('pick.noContainer'));
  parts.push(t('pick.chosen', { label: chosen.label, bestFor: chosen.bestFor }));
  parts.push(t('pick.gates', { gates: chosen.followUp }));
  parts.push(t('pick.ask'));
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
  /** A choice holds TWO cases, dispatched on state: an option chosen
   *  (`approved`) composes the PICK turn (MOTIR-6069), and None of these
   *  (`changes_requested`) keeps the refusal turn byte-for-byte. */
  decision_choice: (input, t) =>
    input.gate.state === 'approved'
      ? composePickTurn(input, t)
      : composeRefusalTurn('verb.decisionChoice', input, t, false),
};

/** The composer for a gate's kind, or `null` when that kind has none yet. */
export function refusalSeedComposerFor(kind: ApprovalGateKind): SeedComposer | null {
  return Object.prototype.hasOwnProperty.call(REFUSAL_SEED_COMPOSERS, kind)
    ? (REFUSAL_SEED_COMPOSERS[kind] ?? null)
    : null;
}
