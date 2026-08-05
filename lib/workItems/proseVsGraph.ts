// PROSE-vs-GRAPH reference extraction (MOTIR-1969) — the pure half of the
// advisory that warns when a card's BODY names a not-done work item it carries
// no `blocked_by` edge to.
//
// ⚠️ This is an ADDITION beside the finishability rules, NOT an extension of
// them. `gatingItemSatisfied` (lib/workItems/validity.ts) is a pure
// EDGE-AND-STATUS walk — it never reads a description. This pass asks a
// different question entirely: compare the set a body NAMES against the set the
// graph has EDGES to. Do not try to route it through `gatingItemSatisfied`; the
// two share no input.
//
// ⚠️ KNOWN BLIND SPOT — a `type: decision` card's deferrals are invisible here
// (`notes.html` #202, found by MOTIR-1980). This check's ONLY input is
// `descriptionMd`. A decision card's deliverable is a DOCUMENT in a repository
// (e.g. `docs/decisions/ci-runner-fleet.md` §11), and every deferral it writes
// lives there — outside the graph and outside every plan-side validator. The
// card's own body never names what the document deferred, so the named set N is
// EMPTY for exactly the reference that mattered. Covering that gap needs repo
// access and is a much larger surface; it is deliberately NOT this module's job.
// The covering mechanism is a planner RULE (MOTIR-1975 W3 — a deferral must be
// mirrored onto the target card's acceptance criteria in the same pass), not
// code here. Documentation only; no behaviour follows from it.
//
// Pure string work — no Prisma, no IO — so it is unit-testable in isolation.
// The service half (resolving the named ids, dropping done / exempt targets)
// lives in `lib/services/proseGraphAdvisoryService.ts`.

import { WORKITEM_TOKEN_RE, INTRA_PLAN_REF_TOKEN_RE } from '@/lib/mentions/workItemRefs';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';

/**
 * How strongly a body reference suggests a MISSING `blocked_by` edge. Two tiers,
 * ONE advisory channel — NEITHER is a blocker (see the module note in
 * `proseGraphAdvisoryService`).
 *
 * - `advisory` — the not-done item is named ANYWHERE in the body. A reference
 *   may or may not be a dependency: out-of-scope sections, "the owner of the
 *   other half is X", context refs, superseded-by notes, sibling record cards.
 * - `likely-missing-edge` — the not-done item is named inside the card's own
 *   ACCEPTANCE-CRITERIA section. An AC is what the card is CLOSED AGAINST, so
 *   naming a not-done card there is consuming it by definition (MOTIR-2012
 *   item 2; the canonical fixture is MOTIR-2011, two of whose five ACs named
 *   MOTIR-2007's unmerged deliverables against a `relates_to`-only edge).
 */
export type ProseAdvisorySeverity = 'advisory' | 'likely-missing-edge';

/** Rank for "the card reports the HIGHEST tier" across a reference's occurrences. */
const SEVERITY_RANK: Record<ProseAdvisorySeverity, number> = {
  advisory: 0,
  'likely-missing-edge': 1,
};

/**
 * The heading that opens a card's acceptance-criteria section — any level, the
 * words optionally preceded by heading markup only. Deliberately a HEURISTIC
 * (see {@link acceptanceCriteriaSpan}); it is a refinement of the advisory,
 * never a precondition for emitting one.
 */
const AC_HEADING_RE = /^#{1,6}\s*acceptance criteria/i;

/** Any ATX heading line — group 1 is the `#` run, so its LEVEL is its length. */
const HEADING_LINE_RE = /^(#{1,6})\s/;

/**
 * The character span of a body's ACCEPTANCE-CRITERIA section: from the heading
 * matching {@link AC_HEADING_RE} to the next heading of the SAME or HIGHER level
 * (a deeper sub-heading stays inside the section), or to the end of the body.
 *
 * ⚠️ The section boundary is a HEURISTIC, so what happens when it fails is
 * specified rather than left to chance: a card with NO such heading — or with
 * its acceptance criteria inline in prose — returns `null`, which is **not an
 * error and not a silent miss**. Every reference in that card then falls back to
 * the plain `advisory` tier. The heuristic DEGRADES; it never suppresses.
 */
export function acceptanceCriteriaSpan(md: string): { start: number; end: number } | null {
  const lines = md.split('\n');
  // Byte offset of the start of each line, so a match maps back to a span.
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1; // +1 for the '\n' consumed by the split
  }

  let start: number | null = null;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (start === null) {
      if (!AC_HEADING_RE.test(line)) continue;
      start = offsets[i] as number;
      level = (HEADING_LINE_RE.exec(line)?.[1] as string | undefined)?.length ?? 1;
      continue;
    }
    const heading = HEADING_LINE_RE.exec(line);
    if (heading && (heading[1] as string).length <= level) {
      return { start, end: offsets[i] as number };
    }
  }
  return start === null ? null : { start, end: md.length };
}

/**
 * The work items a body NAMES — the set **N** of the prose-vs-graph rule — each
 * mapped to the HIGHEST severity any of its occurrences earns.
 *
 * Two token forms are extracted, and the returned key is what the caller
 * resolves the reference against:
 *  - `[LABEL](motir:<id>)` → the bare work-item id (the shipped chip form every
 *    card in this family carries — which is exactly why this is a REGEX over
 *    `descriptionMd` and not a text-understanding problem);
 *  - `[LABEL](motir-ref:planItem:<id>)` → `planItem:<id>`, the SAME temp-ref the
 *    plan projection keys a not-yet-materialized `add` by, so a projected body
 *    can name a projected sibling.
 *
 * Real-corpus behaviour, all deliberate:
 *  - **Multiple links to the same id are deduped** — one entry, highest tier.
 *  - **A malformed / unknown id simply doesn't match, or resolves to nothing.**
 *    It is body text, never an error (the same contract `parseWorkItemTokenIds`
 *    has always had).
 *  - **A token inside a code fence or blockquote IS extracted.** This module
 *    deliberately uses the SAME extraction as the shipped auto-relate write path
 *    (`autoRelateWorkItemMentions`), because auto-relate is what wrote the
 *    `relates_to` edge this advisory contrasts against `blocked_by`. Using a
 *    narrower N here would make the advisory disagree with the graph it is
 *    auditing. An advisory is non-blocking, so the cost of including an
 *    illustrative reference is a line of output, never a stalled card.
 */
export function bodyReferenceSeverities(
  md: string | null | undefined,
): Map<string, ProseAdvisorySeverity> {
  const out = new Map<string, ProseAdvisorySeverity>();
  if (!md) return out;

  const note = (id: string, severity: ProseAdvisorySeverity): void => {
    const prev = out.get(id);
    if (prev === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[prev]) out.set(id, severity);
  };

  const scan = (text: string, severity: ProseAdvisorySeverity): void => {
    for (const m of text.matchAll(WORKITEM_TOKEN_RE)) note(m[1] as string, severity);
    for (const m of text.matchAll(INTRA_PLAN_REF_TOKEN_RE)) {
      note(`${TEMP_REF_PREFIX}${m[2] as string}`, severity);
    }
  };

  // Whole body first (every reference earns at least `advisory`), then the AC
  // section promotes the ones inside it — so the tiers are computed
  // per-occurrence and each reference reports the highest.
  scan(md, 'advisory');
  const span = acceptanceCriteriaSpan(md);
  if (span) scan(md.slice(span.start, span.end), 'likely-missing-edge');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDERING CHECK (MOTIR-2175) — gate 14's third axis, mechanized.
//
// A different question from everything above: not "does this body name a card
// the graph has no edge to", but "does this body ask for state that cannot
// exist yet". It shares only the AC span with the reference scan, which is why
// it lives in the same module and not in a new one.
//
// A card's own boundary ends at **PR opened** — `subtask_pr_merge_mode` is
// `manual`, `motir run` stops at the PR, and the merge is Yue's. So an
// acceptance criterion whose truth requires the merge belongs to a DIFFERENT
// card, and gate 14's remedy is to cut the card at that line. The 1-based index
// of the offending criterion is therefore the actionable half of the finding:
// it names where the cut goes.
//
// ⚠️ The phrase list below is gate 14's own, VERBATIM. It is not a heuristic to
// tune and not a place to be clever — `notes.html` #221 chose a string match
// over a smell test in those words, and MOTIR-2164 established that the miss
// was about what EXECUTES the check, not about how it is worded. Widening or
// narrowing this list is a change to `plan-rules.md` first, mirrored here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gate 14's ORDERING phrase list (`plan-rules.md`, *"An ACCEPTANCE CRITERION
 * must be satisfiable INSIDE the card's own scope boundary"*), verbatim. A
 * criterion carrying any of these reads on state that exists only after the
 * card's own PR has merged.
 *
 * `the published` is the list's `the published <X>` entry — the phrase is the
 * prefix; what follows it is the artifact and varies per card.
 *
 * ⚠️ Pinned against the prose by `tests/workItems/proseVsGraph.test.ts`, so a
 * drift between `plan-rules.md` and this constant is a RED TEST rather than a
 * silent gap in the check.
 */
export const POST_MERGE_CRITERION_PHRASES = [
  'merged to main',
  'once this lands',
  'once it lands',
  'after release',
  'on main',
  'the published',
] as const;

/** One phrase, as a whitespace-tolerant, word-bounded matcher. */
const POST_MERGE_PHRASE_MATCHERS: ReadonlyArray<{ phrase: string; re: RegExp }> =
  POST_MERGE_CRITERION_PHRASES.map((phrase) => ({
    phrase,
    // `\s+` between words so a criterion that wraps a line still matches; `\b`
    // at both ends so `on main` does not fire inside `companion maintainer`.
    re: new RegExp(`\\b${phrase.split(' ').join('\\s+')}\\b`, 'i'),
  }));

/** A criterion line: a top-level `-`/`*`/`+` or `1.`/`1)` bullet, unindented. */
const CRITERION_BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Inline markup a phrase can be wearing. Gate 14's own prose writes "merged to
 * `main`" and MOTIR-2162 wrote "**once it lands**", so a matcher that reads the
 * raw Markdown finds neither. Backticks and emphasis runs are stripped before
 * matching; nothing else is touched (underscores stay, so identifiers survive).
 */
const INLINE_MARKUP_RE = /[`*]/g;

/** The ORDERING finding: which phrase, and which criterion carries it. */
export interface PostMergeCriterion {
  /** The matched phrase in its canonical {@link POST_MERGE_CRITERION_PHRASES} form. */
  phrase: string;
  /** 1-based index of the offending criterion within the acceptance-criteria list. */
  criterionIndex: number;
}

/**
 * The FIRST acceptance criterion that reads on post-merge state, or `null`.
 *
 * Scope is the **acceptance-criteria span only** — {@link acceptanceCriteriaSpan}
 * — and its degrade-never-suppress contract applies here unchanged, with one
 * inversion worth stating out loud: for the reference scan, no AC heading means
 * every reference falls back to the plain `advisory` tier; here it means
 * **nothing is emitted at all**. That is deliberate rather than a shortcut. The
 * phrases are perfectly legitimate in a body's narrative — a card's own
 * explanation may say "once this lands, the next card can start" — and are a
 * DEFECT only in a criterion, which is the thing the card is closed against. A
 * body-wide scan would fire on most well-written cards in this corpus.
 *
 * Only ENUMERATED criteria count. A bullet (or `1.` item) at column zero opens a
 * criterion; everything after it — continuation lines, indented sub-bullets —
 * belongs to that criterion, so a phrase in a wrapped line is attributed to the
 * bullet it wraps from. Prose inside the AC section that is not under any bullet
 * is not a criterion and is not scanned; there is no index to report for it.
 *
 * Returns the FIRST offender because gate 14's remedy needs exactly one number:
 * *"EVERY criterion at or below the first line carrying one belongs to a
 * different card"* — so the first index IS the cut line, and the ones below it
 * are consequences rather than separate findings.
 */
export function firstPostMergeCriterion(md: string | null | undefined): PostMergeCriterion | null {
  if (!md) return null;
  const span = acceptanceCriteriaSpan(md);
  if (!span) return null;

  let criterionIndex = 0;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) criterionIndex += 1;
    // Before the first bullet: the heading itself and any lead-in prose.
    if (criterionIndex === 0) continue;
    const text = raw.replace(INLINE_MARKUP_RE, '');
    for (const { phrase, re } of POST_MERGE_PHRASE_MATCHERS) {
      if (re.test(text)) return { phrase, criterionIndex };
    }
  }
  return null;
}

/**
 * Whether a card is EXEMPT from the ordering check — `type: 'deploy'` or
 * `executor: 'human'`.
 *
 * ⚠️ This is the rule's own remedy read back as a predicate, NOT a noise filter
 * and NOT a threshold. Gate 14 says post-merge criteria belong on a `deploy` /
 * `human` card — the release trio's *cut* leg, which is DEFINED by needing the
 * merge — so such a card carrying such a phrase is the shape the rule wants and
 * the phrase in it is correct. Suppressing there costs no coverage at all,
 * while a false positive on it would train readers to skip the advisory
 * channel, which is how the check that DID fire unaided (`likely-missing-edge`)
 * gets ignored.
 */
export function isOrderingCheckExempt(
  type: string | null | undefined,
  executor: string | null | undefined,
): boolean {
  return type === 'deploy' || executor === 'human';
}
