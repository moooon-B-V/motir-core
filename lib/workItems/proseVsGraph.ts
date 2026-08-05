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

// ─────────────────────────────────────────────────────────────────────────────
// THE REPO-STRADDLE CHECK (MOTIR-2177) — gate 1's criterion-by-criterion repo
// column, mechanized as far as it mechanizes and NO FURTHER.
//
// A CONTRADICTION, not a count. The naive form — count the distinct repos named
// across the criteria, warn at two — fires on nearly every card in this corpus,
// because motir-core submitting a job that EXECUTES in motir-ai is the
// architecture, and gate 1's own text says so. So the question asked here is
// narrower and answerable from facts the card already asserts: an acceptance
// criterion names a repo-qualified path whose owning repo is NOT the card's
// `targetRepo`. ONE SUBTASK = ONE REPO = ONE PR, so a criterion discharged
// outside the pin is unsatisfiable inside it — wrong regardless of how the
// reference was meant.
//
// ⚠️ TWO FORMS OF THE TELL THIS CHECK CANNOT SEE. Neither is an oversight, and a
// reader who assumes `likely-repo-straddle` retires gate 1's prose will lose
// coverage rather than gain it:
//
//   1. **The BARE SYMBOL.** MOTIR-1983's entire self-declaration was
//      `SHARED_PLANNING_RULES` inside a parenthetical — a symbol whose repo a
//      reader happens to know. Mapping a symbol to a repo needs a cross-repo
//      index this check does not have and is not getting. Gate 1's prose remains
//      the ONLY cover for that form.
//   2. **A BOUNDARY-CONTRACT card** — a producer plus its mirrored consumer, two
//      coordinated PRs, legitimately one card — WILL fire here. That is an
//      ACCEPTED false positive, not a bug: the advisory never blocks, the shape
//      is rare, and one line of output is the whole cost. It is also why this is
//      the FIRST check to withdraw if advisory fatigue shows — its precision is
//      lower than the ordering check's, and the prose still covers its family.
//
// Deliberately NO exemption predicate (contrast {@link isOrderingCheckExempt}).
// The ordering check's exemption is the RULE'S OWN REMEDY read back — a `deploy`
// / `human` card is DEFINED by needing the merge. Gate 1 has no such shape;
// suppressing the boundary-contract card would need a signal the plan does not
// carry, and guessing at one would cost real coverage to buy tidiness.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One repo the check can resolve a path prefix against — the structural subset
 * of `ConnectedRepoName` (`lib/workItems/targetRepo.ts`) this module needs.
 *
 * Declared here rather than imported so the module stays pure and unit-testable
 * with a literal; `ConnectedRepoName` is structurally assignable to it, so the
 * service passes the workspace's connected set straight through.
 */
export interface RepoCandidate {
  /** The bare repo NAME — the value `work_item.targetRepo` stores. */
  name: string;
  /** `owner/name`, the form the GitHub surfaces display. */
  repoRef: string;
}

/**
 * A path-like token: two or more `/`-separated segments. Matched against text
 * with {@link INLINE_MARKUP_RE} already stripped, because the corpus writes
 * paths in backticks (`` `motir-ai/src/foo.ts` ``).
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g;

/** {@link PATH_TOKEN_RE} without `g`, for a `test()` that must not carry state. */
const PATH_TOKEN_PRESENT_RE = new RegExp(PATH_TOKEN_RE.source);

/**
 * The repo a path-like token belongs to, or `null` when it belongs to none of
 * `candidates`.
 *
 * Both prefix forms `targetRepo` itself accepts (`normalizeTargetRepo`) are
 * resolved, `owner/name` first so an owner that happens to share a repo's name
 * cannot shadow it:
 *  - `moooon-B-V/motir-core/lib/x.ts` → the `owner/name` form, matched against
 *    {@link RepoCandidate.repoRef};
 *  - `motir-core/lib/x.ts` → the bare-name form, matched against
 *    {@link RepoCandidate.name}.
 *
 * Case-insensitive (git-host repo names are), and the returned value is the
 * CANDIDATE's own casing, so a finding and the `targetRepo` column can never
 * disagree on spelling.
 *
 * **A token that resolves to nothing is BODY TEXT and yields `null`** — no
 * error, no finding. `packages/cli/build.ts`, `docs/decisions/x.md` and
 * `https://ghcr.io/token` are all just prose here, which is what keeps the check
 * a reading of the repo registry rather than a guess about what a slash means.
 *
 * A token with NO slash is likewise `null` even when it exactly names a repo: a
 * bare name is the SYMBOL form this check does not cover (see the module note),
 * and treating it as a path would fire on every card that merely says
 * "motir-ai".
 */
export function resolvePathRepo(
  token: string,
  candidates: readonly RepoCandidate[],
): string | null {
  const segments = token.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const ownerName = `${segments[0]}/${segments[1]}`.toLowerCase();
  const byRef = candidates.find((c) => c.repoRef.toLowerCase() === ownerName);
  if (byRef) return byRef.name;
  const bare = (segments[0] as string).toLowerCase();
  return candidates.find((c) => c.name.toLowerCase() === bare)?.name ?? null;
}

/** A resolvable repo-qualified path, and which criterion wrote it. */
export interface CriterionRepoPath {
  /** The path token as the criterion wrote it (markup stripped). */
  path: string;
  /** The repo it resolves to, in the candidate's own casing. */
  repo: string;
  /** 1-based index of the criterion within the acceptance-criteria list. */
  criterionIndex: number;
}

/**
 * Whether a body's acceptance criteria contain ANY path-like token at all.
 *
 * Pure, candidate-free, and cheap — its only job is to let the service skip the
 * connected-repositories read for the common card that names no path. It is
 * deliberately over-inclusive (it cannot know which prefixes resolve); a `true`
 * here means "worth resolving", never "there is a finding".
 */
export function hasCriterionPathTokens(md: string | null | undefined): boolean {
  if (!md) return false;
  const span = acceptanceCriteriaSpan(md);
  if (!span) return false;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (PATH_TOKEN_PRESENT_RE.test(raw.replace(INLINE_MARKUP_RE, ''))) return true;
  }
  return false;
}

/**
 * Every repo-qualified path in the acceptance-criteria span, in document order,
 * each attributed to the criterion that carries it.
 *
 * Scope and attribution are {@link firstPostMergeCriterion}'s exactly — the AC
 * span only, enumerated criteria only, a continuation line belonging to the
 * bullet it wraps from — so the two shape checks report the same criterion
 * numbering and a card carrying both findings can be cut against one index.
 * Unresolvable tokens are dropped as they are met.
 */
export function criterionRepoPaths(
  md: string | null | undefined,
  candidates: readonly RepoCandidate[],
): CriterionRepoPath[] {
  if (!md || candidates.length === 0) return [];
  const span = acceptanceCriteriaSpan(md);
  if (!span) return [];

  const found: CriterionRepoPath[] = [];
  let criterionIndex = 0;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) criterionIndex += 1;
    if (criterionIndex === 0) continue; // the heading and any lead-in prose
    for (const m of raw.replace(INLINE_MARKUP_RE, '').matchAll(PATH_TOKEN_RE)) {
      const path = m[0];
      const repo = resolvePathRepo(path, candidates);
      if (repo !== null) found.push({ path, repo, criterionIndex });
    }
  }
  return found;
}

/**
 * Why a straddle finding was emitted — the two arms are different questions and
 * a reader must not have to infer which one fired.
 *
 * - `contradiction` — the card PINS `targetRepo: X` and a criterion is
 *   discharged in repo Y. The card contradicts itself; the pin and the criterion
 *   are both things the card asserts.
 * - `unpinnable` — the card pins NOTHING and its criteria name two or more
 *   distinct repos. Gate 1's *"`targetRepo: null` on a card whose deliverables
 *   you can ENUMERATE is not 'not yet pinned' — check whether it is
 *   UNPINNABLE"*, which is the same finding wearing a friendlier face.
 */
export type RepoStraddleReason = 'contradiction' | 'unpinnable';

/** The REPO-STRADDLE finding: which path, whose repo, which criterion, why. */
export interface RepoStraddleCriterion extends CriterionRepoPath {
  reason: RepoStraddleReason;
}

/**
 * The FIRST acceptance criterion that straddles a repo boundary, or `null`.
 *
 * **Pinned card (`targetRepo` non-null) — the CONTRADICTION arm.** The first
 * resolvable path whose repo is not the pin. A criterion naming a path in the
 * PINNED repo is the normal case and never fires, however many times it does so.
 *
 * **Unpinned card (`targetRepo` null) — the UNPINNABLE arm.** With nothing to
 * contradict, one repo across the criteria is a card that simply has not been
 * pinned yet, and nothing is emitted. TWO OR MORE distinct repos is the finding:
 * the reported path is the first occurrence of the SECOND repo — the point at
 * which the split becomes visible, which is the same cut-line semantics
 * {@link firstPostMergeCriterion} reports and the same place a human building
 * gate 1's repo column would stop.
 *
 * Returns the first offender only, for gate 14's reason: the remedy is one
 * number, and the criteria after it are consequences rather than findings.
 */
export function firstRepoStraddleCriterion(
  md: string | null | undefined,
  targetRepo: string | null,
  candidates: readonly RepoCandidate[],
): RepoStraddleCriterion | null {
  const paths = criterionRepoPaths(md, candidates);
  if (paths.length === 0) return null;

  if (targetRepo !== null) {
    const pin = targetRepo.toLowerCase();
    const offender = paths.find((p) => p.repo.toLowerCase() !== pin);
    return offender ? { ...offender, reason: 'contradiction' } : null;
  }

  const first = (paths[0] as CriterionRepoPath).repo.toLowerCase();
  const second = paths.find((p) => p.repo.toLowerCase() !== first);
  return second ? { ...second, reason: 'unpinnable' } : null;
}
