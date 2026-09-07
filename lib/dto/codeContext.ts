import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';

// The CODE-CONTEXT DTOs (Story MOTIR-1754 · MOTIR-1767) — what a PROJECT's
// planning surfaces are told about the code Motir can read for them.
//
// ⚠️ THERE IS NO VERDICT TYPE HERE, AND THAT IS THE POINT OF THIS FILE'S SECOND
// REVISION. It first shipped a `CodeRepoVerdict` of its own —
// `current | stale | indexing | never_indexed` — computed by a `resolveVerdict`
// in the service beside it. `lib/codeGraph/indexState.ts` (MOTIR-4724) is THE ONE
// derivation of those states, `tests/codeGraph/indexState.test.ts` asserts that no
// second implementation of "stale" exists under `lib/`, and that module's own
// header names *the `Code` page (MOTIR-1754)* as a surface that must not be able
// to disagree with it. So the state is IMPORTED, never re-declared: a second
// union would compile, diverge silently, and put a different answer on a
// different screen.
//
// ⚠️ AND THE VOCABULARY IS NOT A RENAME OF THE OLD ONE. The states are
// `never | indexing | indexed | stale`, and `indexed` is deliberately NOT
// `current`: a null head sha means "not known yet", never "up to date", so
// claiming currency would tell somebody their graph matches their code at the
// exact moment they are deciding whether to trust a plan built from it.

/** One repository of the PROJECT's configured set, with what Motir knows about its graph. */
export interface CodeContextRepoDTO {
  /** `owner/name` — the ref the code graph is keyed on. */
  repoRef: string;
  /** The git-provider discriminator (`github` / `gitlab`). */
  provider: string;
  /** The shipped four-state answer. Imported, never re-derived. */
  indexState: CodeGraphIndexState;
  /**
   * When the graph was last built. Rendered as "indexed <when>" and NEVER used to
   * decide staleness — `indexedAt` is a timestamp and staleness is a sha
   * comparison, which is the distinction `indexState.ts` exists to hold.
   */
  indexedAt: Date | null;
  /**
   * How far the default branch has moved past the graph, IN COMMITS.
   *
   * ⚠️ ALWAYS `null` TODAY, and that is a first-class answer rather than a gap.
   * Telling `stale` from `indexed` needs only a sha inequality, which
   * `indexState.ts` does; COUNTING the commits between two shas needs a
   * commit-graph read neither repository holds. MOTIR-4644 is its producer.
   *
   * It is carried rather than dropped because a CONSUMER already depends on the
   * distinction: `isBadlyStale` pauses the auto-cadence on a THRESHOLD, never on
   * any drift, and `indexState === 'stale'` cannot stand in for it — an active
   * repository is a few commits behind between every push, so conflating the two
   * would pause the cadence permanently for exactly the projects doing the most
   * work.
   */
  commitsBehind: number | null;
}

/** The project's whole code-context answer. */
export interface CodeContextDTO {
  /**
   * Whether the planner would get `context.code` at all for this project — i.e.
   * whether its configured set contains at least one REALIZED repository.
   */
  hasCodeContext: boolean;
  /** The project's repositories, in the set's own order. Empty when there are none. */
  repos: CodeContextRepoDTO[];
  /**
   * Whether anybody has reported implementing work in this project. Drives the
   * "connect your code" prompt: a project nobody has built in yet is not one to
   * nag. Deliberately NOT "any done item" (a migrated tracker is full of those,
   * implemented by nobody through Motir) and NOT "any pull-request link" (which
   * presumes the very connection the affordance is asking for).
   */
  hasImplementedWork: boolean;
}
