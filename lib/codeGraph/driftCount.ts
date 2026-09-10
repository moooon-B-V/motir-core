// THE DRIFT COUNT, READ (Story MOTIR-1754 · MOTIR-4644) — the one place that
// decides whether a stored count may be served.
//
// ⚠️ A COUNT IS A FACT ABOUT A PAIR, NOT ABOUT A REPOSITORY. It answers "how far
// is `defaultBranchHeadSha` ahead of `indexedHeadSha`", and BOTH of those move:
// a push moves the head, an index run moves the base. The moment either does,
// the stored number is a true statement about a pair that no longer exists — and
// it renders identically to a current one, which is what makes serving it
// unsafe rather than merely imprecise.
//
// So the stored count travels with the pair it was computed for, and this
// function is the comparison. It is deliberately tiny and deliberately the ONLY
// caller-facing rule: `indexState.ts` is the ONE derivation of the four states,
// and this is the ONE decision about the number beside them. A second comparison
// written at a call site would be a second definition of "current enough".

/** The columns a drift read needs — the live pair, and the stored one. */
export interface DriftCountFacts {
  /** `GithubRepo.commitsBehind` — the stored number, or null if never computed. */
  commitsBehind: number | null;
  /** The `indexedHeadSha` the stored number was computed against. */
  commitsBehindBaseSha: string | null;
  /** The `defaultBranchHeadSha` the stored number was computed against. */
  commitsBehindHeadSha: string | null;
  /** The graph's head, NOW. */
  indexedHeadSha: string | null;
  /** The default branch's head, NOW. */
  defaultBranchHeadSha: string | null;
}

/**
 * The drift count to render, or `null`.
 *
 * ⚠️ `null` IS A FIRST-CLASS ANSWER AND IS NEVER `0`. Zero means the graph
 * MATCHES the head — every consumer reads it that way — so returning it for
 * "nobody has counted" would put the most reassuring answer on the least
 * evidence. Four situations produce `null` and all four render the same way
 * (`design/code-context/design-notes.md` panel D3, "behind by an unknown number
 * of commits"): never computed, computed for a pair that has since moved, a pair
 * with no common ancestor, and a host that could not answer.
 *
 * ⚠️ A NULL SHA ON EITHER SIDE IS ALSO `null`, and for the reason
 * `deriveCodeGraphIndexState` gives about the same two columns: a missing
 * comparand is NOT KNOWN YET, never a match. Treating two nulls as "equal" would
 * serve a count for a pair nobody has observed.
 */
export function resolveDriftCount(facts: DriftCountFacts): number | null {
  if (facts.commitsBehind === null) return null;
  if (facts.indexedHeadSha === null || facts.defaultBranchHeadSha === null) return null;
  if (facts.commitsBehindBaseSha !== facts.indexedHeadSha) return null;
  if (facts.commitsBehindHeadSha !== facts.defaultBranchHeadSha) return null;
  return facts.commitsBehind;
}

/**
 * Does this repository need its drift counted?
 *
 * True when both shas are known, they DIFFER — a matching pair is `indexed`,
 * with nothing to count — and the stored PAIR is not already this one.
 *
 * ⚠️ IT TESTS THE PAIR, NOT THE COUNT, AND THAT DISTINCTION IS THE WHOLE RULE.
 * "Has this pair been tried?" and "did trying produce a number?" are different
 * questions, and only the first decides whether to spend a provider call. A
 * force-pushed repository has no common ancestor, so its honest answer is `null`
 * — for ever, until one of its shas moves. Selecting on `commitsBehind === null`
 * would re-select it on every tick, spend a provider call to learn the same
 * thing, and write the same null: an infinite retry loop that looks like a
 * working sweep and shows up only as a rate-limit bill.
 *
 * So a stored pair equal to the live pair means TRIED, whatever the answer was.
 * The count's own nullness is {@link resolveDriftCount}'s business, and the two
 * functions deliberately disagree on exactly that one case.
 */
export function needsDriftRecompute(facts: DriftCountFacts): boolean {
  if (facts.indexedHeadSha === null || facts.defaultBranchHeadSha === null) return false;
  if (facts.indexedHeadSha === facts.defaultBranchHeadSha) return false;
  return (
    facts.commitsBehindBaseSha !== facts.indexedHeadSha ||
    facts.commitsBehindHeadSha !== facts.defaultBranchHeadSha
  );
}
