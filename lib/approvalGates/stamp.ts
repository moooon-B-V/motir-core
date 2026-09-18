import { createHash } from 'node:crypto';

// THE STAMP — what a decision is ABOUT, recorded at the moment it was rendered
// (Story MOTIR-5232 · Subtask MOTIR-5234; ADR `docs/decisions/approval-gates.md`
// §6b's MOTIR-5234 amendment).
//
// ⚠️ THE ONLY DEFINITION IN THE REPO. The render read computes it
// (`approvalGatesService.getForWorkItem` / `listAwaitingMe`) and the decide door
// recomputes it UNDER THE LOCK and compares. Two implementations would be two
// answers to *did this change?*, and the refusal depends on them agreeing.
//
// ⚠️ DERIVED, NEVER STORED. No column, no migration, no backfill: it is a
// statement about rows that already exist, recomputed each time it is needed,
// so it cannot itself go stale.
//
// ⚠️ OPAQUE ON THE WIRE, COMPOSITE ON THE SERVER. A client holds one string and
// compares nothing. The server needs more than equality — the refusal has to say
// WHAT moved — so the token carries one digest per component and the comparison
// answers per component. A single digest over all three could only say *something
// changed*, which is the sentence the design card refuses to draw.
//
// ⚠️ IT ERRS WIDE, DELIBERATELY. The whole `descriptionMd` is hashed, so a typo
// fix also invalidates a pending decision. A false stale costs one re-read; a
// missed one applies an approval to a question that changed. And it hashes
// NOTHING ELSE — not the assignee, labels, status, watchers or `updatedAt`. A
// field nobody was deciding about must never interrupt a decision, and
// `updatedAt` is the obvious shortcut precisely because it moves for all of them.

/** One thing a decision is about, as the refusal names it. */
export type StampComponent = 'subject' | 'pull_requests' | 'criteria';

/** The components, in the ONE order the token and every list of them use. */
export const STAMP_COMPONENTS: readonly StampComponent[] = ['subject', 'pull_requests', 'criteria'];

/**
 * What the stamp is computed OVER — read from the gate, its companion and the card.
 *
 *  · `subjectVersion` — the pressed gate's own `subjectVersion`: the published
 *    result's commit for a design gate, the delivery set for an approve-to-merge
 *    gate.
 *  · `companionSubjectVersion` — the `subjectVersion` of the card's awaiting
 *    approve-to-merge gate when the PRESSED gate is a design gate: one press on a
 *    design with pull requests also decides that gate and merges its members
 *    (MOTIR-5652, `pullRequestMergeService.approveDesignAndMerge`), and the frame
 *    renders those pull requests as part of the decision. Null for every other kind.
 *  · `descriptionMd` — the card's body, where `## Acceptance criteria` lives.
 */
export interface StampInputs {
  subjectVersion: string | null;
  companionSubjectVersion: string | null;
  descriptionMd: string | null;
}

/**
 * THE BYPASS — a decision nobody PRESSED, so there is no rendered page to compare
 * against: the GitHub review sync (a reviewer on GitHub, ADR §8's fourth
 * amendment), and a composer deciding a SECOND gate inside one press whose
 * primary was already checked (the companion inside `approveDesignAndMerge`).
 *
 * ⚠️ A SYMBOL, NOT A SENTINEL STRING, and that is the whole of its safety. A server
 * action and a route receive what a client SERIALISED, and a symbol cannot be
 * serialised — so no request can arrive carrying it. Only code running on the
 * server can name it, and every place that does is a line a reviewer can find.
 */
export const DECIDED_WITHOUT_A_READER: unique symbol = Symbol('approvalGate.decidedWithoutAReader');

/** What a caller of the decide door supplies: what its reader was shown, or the bypass. */
export type DecisionStamp = string | typeof DECIDED_WITHOUT_A_READER;

const VERSION = 'v1';

function digest(value: string | null): string {
  // A NUL marks null so an absent value never collides with an empty string.
  return createHash('sha256')
    .update(value ?? '\u0000')
    .digest('hex')
    .slice(0, 32);
}

function componentValue(inputs: StampInputs, component: StampComponent): string | null {
  switch (component) {
    case 'subject':
      return inputs.subjectVersion;
    case 'pull_requests':
      return inputs.companionSubjectVersion;
    case 'criteria':
      return inputs.descriptionMd;
  }
}

/** The token a surface is handed on the read and hands back on the press. */
export function computeGateStamp(inputs: StampInputs): string {
  return [
    VERSION,
    ...STAMP_COMPONENTS.map((component) => digest(componentValue(inputs, component))),
  ].join('.');
}

/**
 * WHAT MOVED between the stamp a reader was shown and the inputs as they stand now.
 * An empty list means nothing did — the decision may proceed.
 *
 * A token that does not parse (a different version, a truncated string, anything a
 * client invented) cannot be compared component by component, so EVERY component
 * is reported: the reader is refused and re-reads, which is the only honest answer
 * to a stamp nobody can vouch for.
 */
export function stampMoved(presented: string, current: StampInputs): StampComponent[] {
  const parts = presented.split('.');
  if (parts.length !== STAMP_COMPONENTS.length + 1 || parts[0] !== VERSION) {
    return [...STAMP_COMPONENTS];
  }
  return STAMP_COMPONENTS.filter(
    (component, index) => parts[index + 1] !== digest(componentValue(current, component)),
  );
}

/**
 * `moved` in the words the READER uses (design `approval-control--stale-refusal.mock.html`
 * planning flag). When the pressed gate is the approve-to-merge gate, its own subject IS
 * the pull requests, and a reader shown *"A newer version was published"* about commits
 * would be told something false. So its `subject` is reported as `pull_requests`.
 */
export function movedAsReaderSees(
  moved: readonly StampComponent[],
  pressedKind: string,
): StampComponent[] {
  const named =
    pressedKind === 'pull_request_approval'
      ? moved.map((component) => (component === 'subject' ? 'pull_requests' : component))
      : [...moved];
  return STAMP_COMPONENTS.filter((component) => named.includes(component));
}
