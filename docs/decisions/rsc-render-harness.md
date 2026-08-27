# ADR: Rendering route components in vitest — the harness, and why route components are NOT declared out of coverage scope

- **Status:** Accepted (2026-08-27). Task **MOTIR-3568**, under Epic 8 (Launch
  readiness), `relates_to` Story **MOTIR-3440** and Subtask **MOTIR-3449**.
- **Repo:** `motir-core`. Ships `tests/helpers/serverPageHarness.tsx`,
  `tests/navigation/render/*.test.tsx`, and five report-only `coverage.include`
  entries in `vitest.config.ts`. **No product code changes.**
- **Builds on:** Story 11.4's `renderPageToHtml` (`tests/api-docs/story-gate.test.tsx`),
  the four `tests/planning/*` page tests, and `tests/auth/sessionRenderProbe.ts`.

> Convention (`work-item-type-taxonomy.md`): **Status → Context → Decision →
> Consequences**, load-bearing facts in tables.

---

## Context

MOTIR-3449 recorded that MOTIR-3440's seventeen changed `page.tsx` files were
absent from the coverage report, and `vitest.config.ts` said so in three places,
each giving the same reason: **"this repo has no RSC render harness, so no
`app/**/page.tsx` has ever been in this report."\*\*

MOTIR-3568 was raised to decide what to do about that, and offered three options:
**(1)** await-and-assert, **(2)** `react-dom/server`'s streaming renderer, or
**(3)** declare route components permanently out of coverage scope and say so at
the allowlist.

### ⚠️ The premise was false in both halves, measured on `origin/main` at `e88d3d73`

**Six route components were already in `coverage.include`**, and five of them are
GATED at 90/90/90 in `thresholds` — nine lines below the note saying no page has
ever been in the report:

| entry                                      | in `thresholds`? |
| ------------------------------------------ | ---------------- |
| `app/**/docs/page.tsx`                     | ✅ 90 / 90 / 90  |
| `app/**/docs/api/page.tsx`                 | ✅ 90 / 90 / 90  |
| `app/**/docs/api/getting-started/page.tsx` | ✅ 90 / 90 / 90  |
| `app/**/docs/api/stability/page.tsx`       | ✅ 90 / 90 / 90  |
| `app/**/docs/sandbox/page.tsx`             | ✅ 90 / 90 / 90  |
| `app/**/docs/layout.tsx`                   | report-only      |

**And something could already render one.** Both of the card's "options" were
shipped techniques, hand-rolled once per file:

| technique                                                 | where it already lived                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| option 1 — `await Page()`, walk the returned element tree | `tests/planning/roadmapPageStreaming.test.tsx` · `planningPageStreaming.test.tsx` · `plansPageEntrance.test.tsx` (with its own `walk`) · `plansTabbedList.test.tsx` |
| option 2 — Fizz over `react-dom/server.edge`              | `tests/api-docs/story-gate.test.tsx` · `docs-rail-tiers.test.tsx` · `cli-story-gate.test.tsx`, each declaring its own `renderPageToHtml`                            |

The true, narrower statement — the one `vitest.config.ts` now makes — is that no
page under **`app/(authed)`** had ever been in the report. That is a different
problem with a different cause: an authed page needs request-scoped shims (a
session, an active project, a permission set, a router hook for the island Fizz
actually renders) that a public docs page does not.

---

## Decision

### 1 — Build the harness. Options 1 and 2 are not alternatives; they are two layers of it

`tests/helpers/serverPageHarness.tsx` factors what the seven files above were
each re-deriving, and adds the shims an authed page needs. It answers three
different questions, and a card picks the cheapest one that can see its claim:

| entry point                                                         | what it sees                                                                              | cost                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `renderTree(Page, …)` + `walk` / `findAll` / `findFirst` / `textOf` | the settled element tree; every branch of the page function; which element got which prop | no renderer, no DOM                         |
| `renderToHtml(element)`                                             | the complete document, client islands included                                            | Fizz                                        |
| `renderFirstFlush(element)`                                         | **what React flushed BEFORE a pending body resolved**                                     | Fizz, plus a `deferred()` the test controls |
| `until(predicate)`                                                  | that two reads of a `Promise.all` were both ISSUED while the first was open               | no renderer                                 |

`renderFirstFlush` and `until` are the two the story actually needed, and neither
existed anywhere:

- **The first flush is the claim the acceptance lane had to give up.**
  `tests/e2e/acceptance-pages-stream.spec.ts` says so in its own words: against a
  seeded fixture the late reads resolve before the first flush, so no fallback
  ever reaches the DOM, and _"an assertion that can only pass when the database
  is SLOW is a flake wearing a proof's clothes."_ In the harness the read is held
  open **by the test**, so the frame is deterministic.
- **`until` turns a source claim into an execution claim.**
  `canvas-surfaces-arrival.test.ts` asserts a one-wave read by finding a
  `Promise.all([...])` whose TEXT contains both call names — which survives every
  edit that keeps both names inside one `Promise.all` while making them serial in
  fact.

### 2 — Option 3 is REJECTED, and the reason is that its premise is gone

Option 3 was a legitimate outcome, and the card was right to say so: _a floor
that cannot be met is worse than a stated exclusion._ It is rejected because the
floor **can** be met — five route components clear a 90% per-file gate on `main`
today, through this exact mechanism. Writing a permanent exclusion into
`vitest.config.ts` would have recorded an impossibility that the same file
already disproves nine lines further down, and would have taken the ≥90% floor
`CLAUDE.md` states permanently off the surfaces that decide what a reader sees
when something is wrong.

### 3 — Fizz, not Flight — and the limit is named rather than left to be discovered

The harness renders through `react-dom/server.edge`, not through the RSC Flight
renderer. `tests/auth/sessionRenderProbe.ts` measured the difference and its
finding stands: **Fizz installs no per-request `cache()` scope** (the same
three-deep tree still called through three times under `renderToReadableStream`).
So a page whose behaviour depends on React's request memoisation is still that
probe's job — a child process under `node --conditions=react-server` — and this
harness is not a substitute for it. What Fizz reproduces faithfully is what this
story is about: the shell, the Suspense boundaries, and the order their contents
reach the client.

### 4 — A page is rendered under a host element, because that is what the app does

`withProviders` wraps the page in `NextIntlClientProvider` **and a `<div>`.
The div is load-bearing**, and it is fidelity rather than a workaround. Measured
on a two-case control:

| tree                                                   | first `read()`                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `<Suspense fallback={<b>F</b>}><Pending/></Suspense>`  | **blocks until the body settles** — nothing is ever flushed        |
| `<div><p>H</p><Suspense …><Pending/></Suspense></div>` | flushes immediately: `<p>H</p>`, the boundary marker, the fallback |

React's Fizz flushes a _shell_, and a tree whose root **is** the pending boundary
has no shell to flush. No page renders that way in the app — every one is a child
of `app/layout.tsx` → `app/(authed)/layout.tsx` → `<main>` — so rendering a page
bare would model a shape production never produces, and `/invite/accept`, whose
whole body is one boundary, would look unframeable when it is the one surface in
MOTIR-3440 that earned a frame of its own. A context provider is not enough: it
emits no DOM.

### 5 — The five pages enter `coverage.include` REPORT-ONLY

One page per family, no `thresholds` entry for any of them:

| family (MOTIR-3440, `design/shell/design-notes.md`) | page                          | what the render sees that nothing else does                                 |
| --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| project settings (+ workspace/organization)         | `settings/project/automation` | the header and `SettingsPaneFrame` in the FIRST FLUSH, with the pane absent |
| reports + one-shots                                 | `invite/accept`               | the frame flushed with **none of the four terminal bodies** in it           |
| canvases                                            | `plans/[id]`                  | the establish-view read issued while the project resolution is open         |
| work-item lists                                     | `items/[key]/edit`            | the same, below a gate that is proven to hold both back                     |
| its own card                                        | `code-health`                 | the page's four branches — and a `loadError` arm that cannot be reached     |

Pinning happens in a follow-up card, off the number CI publishes, and **never at
a value chosen to make a build pass**. That is the sequence `vitest.config.ts`
prescribes for itself and keeps citing while the number stays unmeasured.

**The measurement, so the follow-up starts from a number rather than from
zero.** Taken on this branch, scoped to the diff — `vitest run
tests/navigation/render --coverage` with `coverage.include` narrowed to these
five files, which is the whole-suite question asked at the cost of the five
specs that answer it:

| page                          | stmts | branch | funcs | lines |
| ----------------------------- | ----- | ------ | ----- | ----- |
| `invite/accept`               | 100   | 100    | 100   | 100   |
| `items/[key]/edit`            | 100   | 100    | 100   | 100   |
| `plans/[id]`                  | 100   | 89.47  | 100   | 100   |
| `settings/project/automation` | 94.44 | 70     | 75    | 93.75 |
| `code-health`                 | 81.66 | 63.33  | 72.72 | 81.48 |

**⚠️ TWO OF THE FIVE ARE BELOW THE ≥90 FLOOR, AND THAT IS REPORTED RATHER THAN
ACCOMMODATED** (MOTIR-3568 AC 4). Nothing here is pinned, so nothing is loosened;
the numbers are the starting point the follow-up measures against. `code-health`
is the lowest and is also the one whose figure is understated by the scoping:
`tests/code-health-page.test.ts` imports `loadCodeHealthSurfaces` from the same
module and will contribute to it in the real run. CI's figure is the
authoritative one, on a clean runner merged with `main`.

---

## Consequences

- **`vitest.config.ts` no longer says a route component cannot be measured.**
  Three notes repeated the false claim; each now says the true thing — the file
  is out because nobody has measured it.
- **A new page test starts from one import.** The shims (`navigationHooks()`),
  the tree walkers and the three render entry points are in one module with the
  precedent named, instead of a fifth hand-rolled `walk`.
- **One finding fell out of the first render, and it is filed rather than
  fixed** (this card changes no product code): `/code-health`'s
  `if (err instanceof MotirAiError) loadError = …` arm is **unreachable**.
  `readRepoAudit` and `readRepoConvention` each absorb a `MotirAiError` into the
  row's own empty state, and `loadCodeHealthSurfaces` has no other
  `aiConventionService` call site — while `resolveCodeContext`, which can still
  throw one, is issued OUTSIDE the `try`. So the page renders a banner nothing
  can raise, and the one live `MotirAiError` path is uncaught rather than
  degraded. It is invisible to a structural test, which never executes it, and
  reads to a reviewer as the careful thing to have written.
- **The harness does not replace the structural suites.** The 59 assertions in
  `tests/navigation/*-arrival.test.ts` run over every page on every PR at no
  render cost; the render suites cover five. The two answer different questions —
  _is the page shaped correctly_ and _does the shape produce the flush_ — and the
  second is the expensive one, so it is spent where a claim needs it.
- **`tests/coverage-gate-globs.test.ts` covers the new entries**, including the
  escaped dynamic segments (`\[id\]`, `\[key\]`) — unescaped, `[id]` is a
  character class to picomatch, and its matching the literal directory today is a
  coincidence of the same family as the `app/(authed)/…` form that test exists
  to catch.
