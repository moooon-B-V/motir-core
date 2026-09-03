import manifest from './egress-manifest.json';

// THE EGRESS MANIFEST (Story MOTIR-3909 · MOTIR-4008) — the vendor set
// `motir-core`'s own tree proves will receive customer data at general
// availability, as a committed artifact this application SERVES.
//
// ── ⚠️ WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────
// `motir.co/legal/subprocessors` is a published legal representation, and it
// was held honest by `tests/legal/subprocessor-list-guard.test.ts`, which read
// TWO things: the rows we DISCLOSE, and the EVIDENCE that a vendor receives
// anything — this repository's `package.json` and the outbound hosts in `lib/`
// and `app/`. The page has moved to `motir-marketing`. **The evidence cannot
// follow it**: a guard run there would measure a marketing website's dependency
// tree, pass forever, and say nothing about the software the page is about.
//
// So the guard splits at the repository line
// (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §E). `motir-core` keeps
// the MEASUREMENT and emits it here; `motir-marketing` asserts the DISCLOSURE
// against it. The binding requirement is a PROPERTY rather than a pipe: **the
// seam FAILS when the two sides diverge.**
//
// ── ⚠️ THE DATA IS `egress-manifest.json`, AND THAT IS DELIBERATE ──────────
// This module holds the TYPES and re-exports the artifact; the artifact itself
// is a sibling JSON file. Two reasons, and the second is structural:
//
//   * it is SERVED verbatim, so the file on disk and the bytes the other
//     repository fetches are the same thing, with no serializer in between;
//   * `tests/legal/egress-manifest-guard.test.ts` lives in the STRUCTURAL-GUARD
//     LANE, which forbids a lane member importing from `lib/` — the lane exists
//     so these whole-tree specs carry no coverage into the merged report. A
//     guard can `readFileSync` a JSON artifact; it may not import a `lib/`
//     module. Splitting data from types is what lets both readers have it.
//
// ── ⚠️ NOTHING GENERATES IT, AND THE GUARD IS WHAT MAKES IT TRUE ────────────
// It is committed, reviewed, and asserted against the tree in BOTH directions —
// a vendor with live evidence and no entry fails, and an entry claiming
// repository evidence that the tree does not show fails. That is deliberate: a
// generated file is a diff nobody reads, and the whole reason this mechanism
// exists is that four staleness incidents in two days were each caught by a
// person who happened to look.
//
// ── ⚠️ WHAT IT IS NOT ──────────────────────────────────────────────────────
// It is NOT the disclosure. It carries no transfer basis, no region, no
// processing purpose and no contract reference — every one of those is a
// judgement about a legal relationship that no repository fact can settle, and
// the retired guard's own header says so. `motir-marketing` holds the page;
// this says only which companies this software actually reaches, and how we know.

/** How we know a vendor belongs on the disclosure. */
export type EgressBasis =
  /** A dependency or an outbound host in THIS repository proves it. */
  | 'repository-evidence'
  /**
   * Real, disclosed, and leaving no trace this repository can read — reached
   * over a wire protocol, through the gateway, or with no code path at all.
   * The reason is carried so an unverifiable row is still ATTRIBUTABLE rather
   * than merely unexplained.
   */
  | 'not-evidenced-here';

export interface EgressVendor {
  /** The label, matching the first bolded span of the page's table row. */
  readonly vendor: string;
  readonly basis: EgressBasis;
  /**
   * The repository facts that prove it, e.g. `host api.resend.com`. EMPTY for
   * `not-evidenced-here`, where {@link reason} carries the explanation instead.
   */
  readonly evidence: readonly string[];
  /** Why this vendor leaves no local trace. Present iff `not-evidenced-here`. */
  readonly reason?: string;
}

export interface EgressManifest {
  /**
   * The artifact's own version. It is an INTERNAL artifact between two
   * repositories under one owner, not a public contract with third-party
   * readers, so it carries a plain integer rather than the deprecation policy
   * `AMENDMENT 1 §D` binds the public API to (AMENDMENT 2 §G). Bump it when the
   * SHAPE changes; adding or removing a vendor is content, not shape.
   */
  readonly version: 1;
  /** Which repository's tree the evidence was measured against. */
  readonly measuredIn: 'motir-core';
  readonly vendors: readonly EgressVendor[];
}

export const EGRESS_MANIFEST = manifest as EgressManifest;
