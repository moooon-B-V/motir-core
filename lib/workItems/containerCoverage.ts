import { acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';

// The CONTAINER-COVERAGE check (MOTIR-5362) — the pure half. Does every
// acceptance criterion a CONTAINER states have a child that owns it?
//
// Every completion signal Motir produces about a container is computed from its
// CHILDREN: the subtree validator asks whether each child can be finished, the
// rollup flips the parent when the last child lands, and the reference advisories
// ask what a card NAMES. None of them reads the container's OWN criteria against
// what its children deliver, so a criterion nobody owns and a criterion everybody
// discharged produce the identical board. This module is the only reader of that
// relationship, and it is a heuristic: noun overlap is not delivery.
//
// ⚠️ SCOPED TO THE POPULATION WHERE THE FAILURE CAN OCCUR — an ADOPTED child, one
// created BEFORE its container. A child authored under this container was scoped
// against these criteria; an adopted one was sealed against a different parent,
// and its silence about this container is not agreement. That is one field, so
// the scope is exact rather than a noise filter — and it is what keeps the firing
// rate low enough to be read (the measurement is recorded on MOTIR-5362).

/**
 * The filing instant of a card that does not exist yet — a PLAN proposal
 * (MOTIR-5403). A proposal is filed when its plan is approved, which is after
 * every row already stored, so it takes the latest representable instant rather
 * than a guessed date. The one comparison in {@link containerCoverageFinding}
 * then states the whole projected rule: a proposed child is never adopted, under
 * any container, and a stored child of a proposed container is.
 */
export const NOT_YET_FILED = new Date(8_640_000_000_000_000);

/** One direct child, reduced to what the check reads. */
export interface CoverageChild {
  /** The child's identifier (e.g. `MOTIR-7`) — reported when it is adopted. */
  identifier: string;
  /**
   * The child's TITLE — the only text ownership is judged against. Not its body:
   * see {@link unownedCriteria} for the measurement that decided it.
   */
  title: string;
  createdAt: Date;
}

/** The COVERAGE finding for ONE container. */
export interface ContainerCoverageFinding {
  /** 1-based indices of the container's criteria no child owns, ascending. */
  unownedCriterionIndices: number[];
  /** The children created BEFORE the container — the population that gated it. */
  adoptedChildren: string[];
}

/**
 * How many of a criterion's distinguishing tokens ONE child must carry to own it.
 *
 * Two, because a single shared noun is not ownership: a container criterion about
 * a session cookie and a child about a planning session share `session` and
 * nothing else. The card's own phrasing — *a child whose body carries that
 * clause's distinguishing nouns* — is plural, and it is ONE child that has to
 * carry them, not the union of every child's vocabulary. A criterion with only one
 * distinguishing token needs that one.
 */
export const COVERAGE_MIN_SHARED_TOKENS = 2;

/** A word shorter than this carries no distinguishing weight. */
const MIN_WORD_LENGTH = 5;

/**
 * Words that appear in almost every card body, so sharing one says nothing about
 * which child owns a criterion. Two sources: ordinary English of the minimum
 * length, and the planning vocabulary every container and child in this product
 * is written in. Compared AFTER {@link stem}, so each entry is its stemmed form.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'about',
  'above',
  'after',
  'again',
  'against',
  'along',
  'already',
  'always',
  'among',
  'another',
  'anything',
  'around',
  'because',
  'before',
  'being',
  'below',
  'between',
  'cannot',
  'could',
  'doe',
  'during',
  'either',
  'every',
  'everything',
  'exactly',
  'first',
  'following',
  'there',
  'their',
  'these',
  'thing',
  'those',
  'three',
  'through',
  'under',
  'unless',
  'until',
  'where',
  'whether',
  'which',
  'while',
  'without',
  'would',
  'should',
  'other',
  'never',
  'nothing',
  'still',
  'shall',
  'itself',
  'rather',
  'since',
  'something',
  'whose',
  'within',
  'written',
  'yours',
  // Planning vocabulary
  'acceptance',
  'criteria',
  'criterion',
  'story',
  'stories',
  'epic',
  'subtask',
  'task',
  'container',
  'child',
  'children',
  'item',
  'items',
  'work-item',
  'work-items',
  'card',
  'asserted',
  'assert',
  'assertion',
  'exist',
  'exists',
  'shipped',
  'ship',
  'ships',
  'below',
  'named',
  'names',
  'record',
  'recorded',
  'decided',
  'decision',
  'motir',
]);

/** A plain word, optionally hyphenated (`better-auth`, `host-only`). */
const WORD_RE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g;

/** A backtick code span — an identifier, a path, a flag: the strongest token a body has. */
const CODE_SPAN_RE = /`([^`\n]+)`/g;

/** A work-item key is a reference to a card, not a noun about the work. */
const WORK_ITEM_KEY_RE = /^[a-z][a-z0-9]*-\d+$/;

/** Inline emphasis and backticks, stripped before the word scan. */
const INLINE_MARKUP_RE = /[`*_]/g;

/**
 * Fold the regular English plurals so `refusals` meets `refusal`. Deliberately
 * crude — it only has to make two spellings of one noun collide, and applying the
 * same fold to both sides is what makes that true.
 */
function stem(word: string): string {
  if (word.length > MIN_WORD_LENGTH && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > MIN_WORD_LENGTH && /(?:sses|ches|shes|xes)$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.length > MIN_WORD_LENGTH && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/** Every distinguishing WORD in a text, stemmed and deduped. */
function distinguishingWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().replace(INLINE_MARKUP_RE, ' ').matchAll(WORD_RE)) {
    const word = match[0];
    if (word.length < MIN_WORD_LENGTH || WORK_ITEM_KEY_RE.test(word)) continue;
    const stemmed = stem(word);
    if (!STOPWORDS.has(stemmed)) words.add(stemmed);
  }
  return words;
}

/**
 * A criterion's DISTINGUISHING TOKENS: its code spans (lower-cased, matched as
 * substrings of a child) and its words (stemmed, matched as whole tokens).
 *
 * A code span is matched by substring because its value is its exact spelling —
 * `prMergeMode` in a criterion and `Project.prMergeMode` in a child are the same
 * identifier, and a word scan would split neither usefully.
 */
export function criterionTokens(criterion: string): { spans: string[]; words: string[] } {
  const spans = new Set<string>();
  for (const match of criterion.matchAll(CODE_SPAN_RE)) {
    const span = (match[1] as string).trim().toLowerCase();
    if (span.length >= 3 && !WORK_ITEM_KEY_RE.test(span)) spans.add(span);
  }
  return { spans: [...spans], words: [...distinguishingWords(criterion)] };
}

/**
 * A criterion that QUANTIFIES OVER THE CONTAINER'S OWN CHILDREN — *"Every story
 * below is done"*, *"Each story carries its own ADR"*. Its owner is the children
 * collectively, by construction, so asking which ONE child owns it has no answer
 * and reporting it would be a false positive every time.
 */
const CHILD_QUANTIFIER_RE =
  /^(?:[-*+]|\d+[.)])\s+(?:every|each|all(?:\s+of)?(?:\s+the)?)\s+(?:child(?:ren)?|stor(?:y|ies)|subtasks?|tasks?|work\s+items?|cards?)\b/i;

/** Whether a criterion quantifies over the container's own children — see {@link CHILD_QUANTIFIER_RE}. */
export function quantifiesOverChildren(criterion: string): boolean {
  return CHILD_QUANTIFIER_RE.test(criterion.replace(INLINE_MARKUP_RE, ''));
}

/**
 * The 1-based indices of a container's criteria that NO single child owns.
 *
 * A child owns a criterion when its TITLE carries at least `min(minShared,
 * tokenCount)` of that criterion's distinguishing tokens. Two kinds of criterion
 * are never reported: one with NO distinguishing token (it cannot be judged, so
 * the heuristic degrades to silence, never to an accusation), and one that
 * quantifies over the children themselves ({@link quantifiesOverChildren}).
 *
 * ⚠️ TITLES, NOT BODIES — decided by measurement on MOTIR-5362, and the reason is
 * not precision but RECALL. The one genuine unowned criterion on the live open
 * tree (MOTIR-4882, three criteria no child delivers) was invisible under a
 * title+body reading: an adopted child's body names the container's nouns as
 * CONTEXT and as explicit NON-scope (*"does not touch the provisioning App"*), so
 * body overlap marked every one of them owned. A title is the child's declared
 * deliverable, which is the question being asked. The accepted cost is the
 * opposite error — a child whose body delivers a criterion its title does not
 * name is reported — and the channel never gates, which is what makes that cost
 * one line of output.
 */
export function unownedCriteria(
  containerMd: string | null | undefined,
  children: ReadonlyArray<Pick<CoverageChild, 'title'>>,
  minShared: number = COVERAGE_MIN_SHARED_TOKENS,
): number[] {
  const criteria = acceptanceCriteriaTexts(containerMd);
  if (criteria.length === 0 || children.length === 0) return [];

  const haystacks = children.map((child) => ({
    lower: child.title.toLowerCase(),
    words: distinguishingWords(child.title),
  }));

  const unowned: number[] = [];
  criteria.forEach((criterion, i) => {
    if (quantifiesOverChildren(criterion)) return;
    const { spans, words } = criterionTokens(criterion);
    const tokenCount = spans.length + words.length;
    if (tokenCount === 0) return;
    const needed = Math.min(minShared, tokenCount);
    const owned = haystacks.some((h) => {
      let shared = 0;
      for (const span of spans) if (h.lower.includes(span)) shared += 1;
      for (const word of words) if (h.words.has(word)) shared += 1;
      return shared >= needed;
    });
    if (!owned) unowned.push(i + 1);
  });
  return unowned;
}

/**
 * The COVERAGE finding for ONE container, or `null`.
 *
 * Emitted only when BOTH halves hold: at least one direct child was created
 * strictly BEFORE the container (it was adopted, so its criteria were sealed
 * against a different parent), and at least one of the container's criteria has
 * no owning child. A container with no adopted child is never reported, however
 * its criteria read — every child it holds was written against them.
 */
export function containerCoverageFinding(
  container: { descriptionMd: string | null; createdAt: Date },
  children: readonly CoverageChild[],
): ContainerCoverageFinding | null {
  const adoptedChildren = children
    .filter((child) => child.createdAt.getTime() < container.createdAt.getTime())
    .map((child) => child.identifier)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (adoptedChildren.length === 0) return null;

  const unownedCriterionIndices = unownedCriteria(container.descriptionMd, children);
  if (unownedCriterionIndices.length === 0) return null;
  return { unownedCriterionIndices, adoptedChildren };
}
