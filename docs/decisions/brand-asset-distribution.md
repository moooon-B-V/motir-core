# ADR: Motir's brand chrome ships as `@motir/brand`, not inside `@motir/design-system`

- **Status:** Accepted (2026-08-27, drafted for Yue's review). **No runtime moves in this
  ADR** — it fixes the boundary only. The move itself is **MOTIR-1456**, which this blocks.
- **Story / Subtask:** MOTIR-656 (8.3 Marketing site + brand mark) · Subtask **MOTIR-3724**
  (this decision). `blocks` MOTIR-1456 (ship the brand chrome for cross-repo reuse).
- **Amends:** [`design-system-package.md`](./design-system-package.md) — it fixed the
  `@motir/design-system` boundary on 2026-07-02 and is **silent** about brand assets, because
  the brand mark did not exist yet (MOTIR-1150 landed 2026-08-07). This ADR closes that gap and
  does not reopen anything that one settled.
- **Builds on:** the brand mark itself (MOTIR-1139 design → MOTIR-1140 approval → MOTIR-1150
  application; re-drawn geometry MOTIR-3181 / MOTIR-3182), and
  [`design/brand/design-notes.md`](../../design/brand/design-notes.md) §3 (the reference CSS),
  §7 (the variants) and §8 (accessible names).

---

## Context

### The question

`motir-marketing` is a separate repository (MOTIR-1455 provisions it) and must render Motir's
brand chrome without hand-copying it — the two-sources-of-truth drift that
`design-system-package.md` §3.1 exists to kill. MOTIR-1456 assumed the shared design-system
package was the vehicle. It is not, and nobody had decided what is.

### Why it was open, and why it read as closed

`design-system-package.md` is an **Accepted** decision that covers this package, so at a glance
it looks like the boundary question has an answer. `grep -i 'brand\|marketing\|logo\|lockup\|wordmark'`
over it returns **0 hits**. It is silent, not permissive — and its two halves now disagree:

- **§1's boundary rule ADMITS the lockup.** _"A file moves into the package iff its only imports
  are (a) other package files, (b) framework peers, and (c) the classname helper `cn`."_
  `components/brand/BrandMark.tsx` imports its sibling `components/brand/waveBand.ts` and React.
  It passes cleanly.
- **§Context's consumer frame FORBIDS it.** The declared consumers are `motir-core`,
  _"`nextjs-prisma-vercel-starter` — a **planner input**, not a user product; the planner forks
  it and plans on top"_, and _"the coding/scaffold agent"_ — i.e. **every product a Motir user
  scaffolds**.

An import rule cannot see the difference between a neutral primitive and a trademark, because
the difference is not in the imports. It is in **who installs the artifact**.

### What is actually at stake — stated precisely, because the obvious framing is wrong

The obvious framing is _"a GPL-3.0 package on public npm would redistribute Motir's trademark."_
That framing does not survive contact with the facts: **`BrandMark.tsx`, `waveBand.ts` and the
`.brand-*` CSS already live in `motir-core`, which is GPL-3.0 and public.** Anyone may already
copy them. Nothing this ADR decides changes that, and a second package does not claw it back.

The real difference between the two options is narrower and worth naming exactly:

> A repository is something people **read and run**. A library on npm is something people
> **build products on**. Putting the mark in `@motir/design-system` does not create new
> redistribution rights — it creates an **easy, accidental path to third-party use in commerce**:
> a scaffolded product's author types `import { ` and autocomplete offers `BrandMark`. That is
> the act trademark law is about, and it is the act the boundary can actually prevent.

Two further facts constrain the answer:

1. **The brand chrome is a CONSUMER of the design system, not a peer of it.** The `.brand-*`
   block reads five tokens — `--el-accent-on-surface`, `--el-text`, `--el-accent-text`,
   `--el-text-secondary`, and `--font-sans-source` — and **every one is defined in
   `packages/design-system/theme.css`, none in motir-core's `app/globals.css` tail** (verified
   below). Whatever carries the brand must depend on the design system.
2. **The `.brand-*` presentation is app-tail CSS, not part of `theme.css`.** It has to travel as
   its own stylesheet under either option; neither is cheaper on that axis.

---

## Decision

### 1. The rule: the discriminator is WHO INSTALLS IT, not what it imports

`design-system-package.md` §1's import rule stands for everything it already governs. This ADR
adds a **second, prior test** that runs before it:

> **An artifact that identifies Motir — the wave band, the wordmark, the lockup, an app icon, an
> OG template — does NOT go into an artifact that third parties install, however clean its
> imports are.** The design system is a neutral kit anyone may build with. The brand is one
> product's identity. They have the same shape and opposite audiences.

Stated as the question to ask: _does a consumer of this package ship products that are not
Motir?_ For `@motir/design-system` the answer is **yes, by design** — that is its whole purpose.
So the brand does not belong in it.

### 2. The mechanism: a second published package, `@motir/brand`

**CHOSEN.** A new workspace package at `motir-core/packages/brand`, published to public npm as
`@motir/brand`, licensed **`GPL-3.0-only`** (identical to `motir-core`, `@motir/cli` and
`@motir/design-system` — see §4 on why the licence is not the protection).

- **`motir-core`** consumes it via the pnpm workspace (`workspace:*`), exactly as it consumes
  `@motir/design-system` today.
- **`motir-marketing`** depends on the published `@motir/brand@^<major>` plus
  `@motir/design-system@^<major>`.
- **`nextjs-prisma-vercel-starter`, the scaffold agent, and every scaffolded product** depend on
  `@motir/design-system` and **never** on `@motir/brand`. That is the entire point of the split,
  and it is enforceable by a one-line check on the starter's manifest.
- **`@motir/design-system` is an ordinary `dependencies` entry of `@motir/brand`**, on a caret
  range — not a peer, not a co-versioned lockstep. The token contract (`--el-*` names, the
  `data-*` attribute set) is already declared the semver surface by
  `design-system-package.md` §3, so a caret range is exactly the right instrument and token skew
  is a normal breaking-change conversation rather than a novel hazard.

**This is the shape the mirror product's own vendor ships.** Atlassian publishes
**`@atlaskit/logo`** — its own product marks — as a **separate package** from
`@atlaskit/primitives`, independently versioned (`21.5.1` vs `22.4.1` as of 2026-08-27), taking
`@atlaskit/tokens: ^16.8.0` as an ordinary dependency. Per the decision-authority ladder's rung 1,
that settles the mechanism: we are not inventing a boundary, we are matching the one the
reference product uses, and its dependency shape answers the coupling question directly.

### 3. What moves, concretely

| artifact              | today                                                                   | home                                                  |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| the lockup component  | `components/brand/BrandMark.tsx`                                        | `packages/brand/src/BrandMark.tsx`, exported from `.` |
| the approved geometry | `components/brand/waveBand.ts` (`WAVE_BAND_PATH`, `WAVE_BAND_VIEW_BOX`) | `packages/brand/src/waveBand.ts`, exported from `.`   |
| the presentation      | the `.brand-*` block in `app/globals.css`                               | `packages/brand/brand.css`, exported as `./brand.css` |

- **The exports map is `.` + `./brand.css`**, mirroring `@motir/design-system`'s shape, with the
  same `files` allowlist (`dist`, `brand.css`) and the same `tsup` build.
- **`BrandMark` is server-safe** — it holds no hooks and carries no `'use client'` — so the
  package is a pure-server bundle today and does **not** need
  `scripts/preserve-use-client.mjs` or the `scripts/build-index-barrel.mjs` re-barrel. If a
  client component is ever added to it, both post-build steps must come with it: that is
  MOTIR-1538's RSC-barrel defect, and it is silent until a server import crashes `next build`.
- **`motir-core` keeps a thin re-export shim** at `components/brand/BrandMark.tsx`
  (`export * from '@motir/brand'`), so its seven consumers — `app/(auth)/layout.tsx`,
  `app/(authed)/_components/TopNav.tsx`, `app/(public)/_components/PublicTopBar.tsx`,
  `app/(public)/explore/_components/ExploreTopBar.tsx`,
  `components/onboarding/DiscoveryChatRail.tsx`, `components/planning/PlanChangeRail.tsx`,
  `components/planning/PlanWithAIFab.tsx` — do not change. This is the pattern MOTIR-1527 used
  and proved.
- **Import ORDER matters in `globals.css`**, and it is the one thing a mechanical move can get
  wrong: `@motir/design-system/theme.css` must be imported **before** `@motir/brand/brand.css`,
  because the brand rules read tokens the theme defines.
- **The release lane is a copy of `.github/workflows/release-design-system.yml`**, whose own
  header documents the extension (change `PACKAGE` / `PKG_DIR`, the `on.push.tags` prefix, and
  the tag-strip prefix): tag `brand-v<x.y.z>`, OIDC Trusted Publishing, no `NPM_TOKEN`. One
  workflow per package, so each keeps its own tag namespace and cadence. **The first publish must
  be done by hand** — OIDC cannot bootstrap a package that does not exist yet, exactly as
  `@motir/design-system@0.1.0` was.
- **`packages/` is excluded from the root `tsconfig.json` and root CI**, so `@motir/brand`'s
  build and tests are verified locally, like `@motir/cli` and `@motir/design-system`. Its build
  joins the root `postinstall` (`pnpm --filter @motir/brand build`), or every CI job and every
  Vercel build resolves `exports` at an unbuilt `dist/`.

**The type pin is the one substantive thing a move can silently break, and it gets a test.**
`.brand-word` must resolve `var(--font-sans-source, Inter)` — the raw FACE variable — and
**never** `var(--font-sans)`, the ROLE token that the `motir-mono`, `grotesk` and
`mono-technical` `[data-type]` blocks each re-point. Wiring the mark to the role makes the
wordmark re-letter itself when a reader changes their Appearance pairing; that defect already
shipped once, in `ExploreTopBar`. `packages/brand/test/` asserts it against `brand.css` directly,
and motir-core's existing `tests/components/brand-mark.test.tsx` stays where it is, now covering
the shim.

### 4. The licence is NOT the protection — the boundary and a notice are

`@motir/brand` is `GPL-3.0-only`, and it has to be: `motir-core` is GPL-3.0 and imports it, so a
more restrictive licence on the library would be incoherent. **A copyleft licence grants rights
over the CODE and grants nothing over the MARK** — GPL-3.0 §7(e) explicitly contemplates
declining to grant trademark rights as an additional term. Three things carry the protection
instead, and none of them is the licence:

1. **The package boundary** — the mark is not in the artifact third parties install. This is the
   only one that actually prevents anything, and it is what this ADR decides.
2. **A `NOTICE` in `packages/brand`** reserving the mark and stating that the copyright licence
   conveys no trademark rights. This ships with MOTIR-1456, as part of the package.
3. **A published trademark policy**, if one is ever wanted. That is not this ADR's to write and
   not a coding agent's to word — it belongs with MOTIR-2267, and its absence blocks nothing.

This is the ordinary open-source shape: Mozilla ships unbranded builds, Docker renamed the
project to Moby, Chromium is the unbranded Chrome. In every case the split is structural, and the
licence is left alone.

### 5. Relationship to MOTIR-2267 (trademark clearance, classes 9 + 42) — INDEPENDENT

**This decision does not wait on clearance, and the ADR records why rather than leaving it to be
re-litigated.** The two answer different questions:

- MOTIR-2267 asks _may Motir use this mark at all, in classes 9 and 42_ — a question about
  **Motir's own** use, whose answer is a property of the artwork.
- This ADR asks _where does the mark live so third parties do not ship it by accident_ — a
  question about **distribution**, whose answer is a property of the package graph.

Neither outcome of the first changes the second. If clearance fails and the mark is re-drawn, the
geometry constant changes and `@motir/brand` publishes a new version — a **content** change
inside a boundary this ADR has already fixed. If clearance passes, nothing moves at all.

**And the ordering favours deciding now.** An uncleared mark sitting in a package every scaffolded
product installs is strictly the worse exposure, so waiting for clearance before separating them
would hold the remedy behind the risk it removes. No `blocked_by` edge is owed from MOTIR-1456 or
MOTIR-3724 to MOTIR-2267, and this paragraph is the recorded reason.

---

## Options weighed

| Option                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A second published package, `@motir/brand`**                                 | **CHOSEN.** Keeps the mark out of every scaffolded product's dependency tree — the only option that does. Matches the mirror product's vendor (`@atlaskit/logo`, separate from `@atlaskit/primitives`, `@atlaskit/tokens` as a plain dependency), which is rung 1 of the decision-authority ladder. Gives the `NOTICE` a home. Costs a second npm name, a second release lane (a documented copy of an existing workflow), and a second version — all one-time, and all of it work MOTIR-1456 was already sized to do.                      |
| A subpath export, `@motir/design-system/brand`                                 | **Rejected.** One release lane, and it removes the _autocomplete_ path — but the mark still lands in the `node_modules` of every scaffolded product and every starter fork, so the thing the boundary exists to prevent still happens, just less visibly. It also leaves the artifact self-contradictory: a package whose stated consumers are third-party products, containing an asset those consumers must not use. The saving is one workflow file; the cost is that the rule cannot be stated in one sentence or checked mechanically. |
| Co-version the two packages in lockstep                                        | **Rejected** — considered because the brand CSS reads five design-system tokens, which looked like a skew hazard. `@atlaskit/logo` disposes of it: a caret `dependencies` range is the standard instrument, and the token contract is already the declared semver surface. Lockstep would force a `@motir/brand` release for every unrelated token change, for no benefit.                                                                                                                                                                  |
| `motir-marketing` carries its own copy                                         | **Rejected.** Exactly the two-sources-of-truth drift `design-system-package.md` §3.1 retired `nextjs-prisma-vercel-starter-with-design` to end. The brand is the _worst_ candidate for a hand copy: a mark that differs between motir.co and the app is a brand defect visible to everyone.                                                                                                                                                                                                                                                 |
| Leave the brand in `motir-core` and have motir-marketing take a git dependency | **Rejected** for the reasons `design-system-package.md` §3 already gave: git deps handle subdirectories poorly, pin to a commit rather than a semver range, and pull the whole repository. Nothing about the brand changes that analysis.                                                                                                                                                                                                                                                                                                   |

---

## Consequences

- **MOTIR-1456 is now buildable**, and its scope is fixed rather than open: create
  `packages/brand`, move three artifacts, add the shim, wire `postinstall`, copy the release
  lane, hand-publish `0.1.0`, and prove no visual change. Its acceptance criteria already require
  the compiled-CSS parity proof MOTIR-1527 used (build before and after, compare the chunks) —
  that remains the evidence, not a screenshot.
- **The starter gains a checkable invariant**: `nextjs-prisma-vercel-starter` and any scaffolded
  product must not list `@motir/brand`. Worth a one-line assertion in the starter's existing
  `tests/design-system-wiring.test.ts` when someone is next in that file; it is not MOTIR-1456's
  to add, and it is recorded here so it is not lost.
- **Two release lanes now exist**, and a token rename becomes a two-package conversation. That is
  the accepted cost, and the caret dependency is what keeps it a conversation rather than a
  breakage.
- **`design-system-package.md` §1's rule is unchanged.** This ADR adds a test that runs _before_
  it, and does not weaken it. A file that fails the import rule still stays in motir-core.
- **Nothing about self-hosting changes.** A self-hosted Motir builds `motir-core`, which depends
  on `@motir/brand`, and renders the mark from its own origin exactly as it does today.

---

## Evidence

Verified on `origin/main` at `2eadf63ba` (2026-08-27) and against the public npm registry.

- **The brand chrome is absent from the package**, which is the gap this ADR exists to close:
  `grep -c '\.brand-'` returns **10** in `app/globals.css` and **0** in
  `packages/design-system/theme.css`.
- **The brand CSS is a strict consumer of the design system's tokens.** Every one of the five
  tokens the `.brand-*` block reads is defined in `packages/design-system/theme.css` and **none**
  is defined in motir-core's `app/globals.css` tail: `--el-accent-on-surface` (4 occurrences in
  `theme.css`, 0 definitions in the app tail), `--el-text-secondary` (5 / 0), `--el-accent-text`
  (7 / 0), `--font-sans-source` (2 / 0), `--el-text` (28 / 0).
- **The type pin is real and load-bearing**: `--font-sans` is re-pointed **4** times in
  `theme.css` by the `[data-type]` blocks, while `--font-sans-source` is the raw face. Binding
  the wordmark to the former is the `ExploreTopBar` defect.
- **`BrandMark.tsx` carries no `'use client'`** and imports only `./waveBand` and React — which
  is why it passes `design-system-package.md` §1's import rule, and why the rule alone is not a
  sufficient boundary.
- **The mirror product's vendor separates the two.** `npm view` on 2026-08-27:
  `@atlaskit/logo@21.5.1` ("A logo is a visual representation of a brand or app"), whose tarball
  carries Atlassian's own product marks (`admin-logo`, `align-logo`, `analytics-logo`,
  `assets-logo`, …), against `@atlaskit/primitives@22.4.1` ("token-backed low-level building
  blocks"). `@atlaskit/logo`'s `dependencies` include `@atlaskit/tokens: ^16.8.0` — an ordinary
  caret range, not a peer and not a lockstep.
- **The prior boundary record is silent, not permissive**: `grep -i` for
  `brand|marketing|logo|lockup|wordmark` over `docs/decisions/design-system-package.md` returns
  **0** hits. It was Accepted 2026-07-02; the brand mark was applied by MOTIR-1150 on 2026-08-07,
  five weeks later.
- **Clearance is genuinely open**: `design/brand/design-notes.md` records _"Neither prior-art
  check nor trademark clearance covers this mark"_, and MOTIR-2267 is `todo`. §5 above is why
  that does not gate this decision.
