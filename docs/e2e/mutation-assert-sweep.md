# The unguarded mutation→assert sweep — the census and its dispositions

> **MOTIR-4399**, measured at `origin/main` `7b18a18a6` (2026-09-06).
> The scanner is `scripts/scan-e2e-mutation-assert.mjs`; every number below is
> reproducible from it, and the command that produced each one is printed beside it.

## What this document is for

A red Playwright check asks one question — **_is this my diff, or is it this?_** —
and answering it from scratch has now cost three separate sessions
([MOTIR-3694](https://github.com/moooon-B-V/motir-core), MOTIR-4399's own first
attempt, and [MOTIR-4496](https://github.com/moooon-B-V/motir-core)). This table
is the standing answer: **look your file and line up here first.**

## The shape

```ts
await page.getByRole('button', { name: 'Add' }).click(); // a server WRITE
await expect(page.getByText('the new row')).toBeVisible(); // persisted state
```

with no deterministic wait armed for the write. Playwright's implicit auto-retry
hides it locally and on a fast runner — the assertion's own 5 s budget usually
covers the round trip. Under CI load the write, the repaint it triggers and
React's reconcile stop fitting inside that budget, and the spec reds a pull
request that never touched it. `CLAUDE.md` § _E2E tests wait on the AUTHORITATIVE
signal_ forbids it.

## Why the bound is the SHAPE and not a file

MOTIR-3694 fixed this in `activity.spec.ts` and wrote its sweep criterion as
_"`git grep` over `tests/e2e/activity.spec.ts`"_ — bounded by the file the defect
was noticed in. Six weeks later the identical shape surfaced in
`issue-detail-flow.spec.ts`. Everything needed to fix the sibling had existed
since 2026-08-28; nothing pointed from the fixed file to the unfixed one. This
sweep is bounded by the shape, over every spec in the suite.

## The census

```
$ git ls-tree -r --name-only origin/main -- tests/e2e | grep '\.spec\.ts$' | wc -l
190
$ node scripts/scan-e2e-mutation-assert.mjs --ref origin/main --explain
```

|                      |    count |                                                            |
| -------------------- | -------: | ---------------------------------------------------------- |
| spec files           |      190 | at `7b18a18a6`                                             |
| **crude candidates** | **1014** | across 147 files — an UPPER BOUND, and most of it is noise |
| kept for hand triage |      104 | across 40 files                                            |

> **The card that opened this sweep measured `770 across 122 files` at
> `da4c4078b`, and the two numbers are not in conflict — they are different
> PREDICATES as well as different refs.** This scan also treats `.press`,
> `.check` / `.uncheck`, `.setChecked` and `.selectOption` as actions, and the
> suite has grown by 8 spec files since. **Re-measure with the command, not
> against the number**: a count with a ref beside it hands a reader the wrong
> thing to check, and a count with its COMMAND beside it lets them ask whether it
> is even the right set.

### Sites the triage DROPPED, by the predicate that dropped them

The first predicate to fire owns the site, so these are disjoint and sum with the
kept set to 1014. **Nothing is dropped silently.**

| dropped | predicate                    | why it is not this defect                                                                                                                                                                          |
| ------: | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     245 | `armed-in-window`            | a deterministic wait is armed in the ±window around the action — **card disposition (a), already guarded**                                                                                         |
|     178 | `armed-in-test`              | a deterministic wait is armed earlier in the same `test` / `test.step` block — **also (a)**; the card's original ±6/4-line window could not see these, which is most of why its bound over-counted |
|      70 | `navigation`                 | the action follows a link, or the assertion is on the URL. The URL lands with the navigation, so there is no repaint budget to overrun — a different race with a different remedy (`waitForURL`)   |
|     344 | `non-mutating-action`        | the clicked control carries no mutating verb, so it cannot write. This is the largest drop and the least certain one — see _What this scan can be wrong about_                                     |
|      51 | `client-only-assert`         | the assertion reads a dialog, menu, `aria-*` state or an absence — nothing is fetched                                                                                                              |
|      22 | `superseded-by-later-action` | another action sits between this one and the assertion, so the assertion races THAT action. Keeping both double-counts one site                                                                    |

## The four dispositions — stated as a QUESTION, not as a list of examples

Every kept site gets exactly one. The question that decides it:
**when does the asserted node appear, relative to the write?**

- **(a) ALREADY GUARDED** — a deterministic wait is armed for the write. In this
  sweep every (a) site was dropped mechanically by the two `armed-*` predicates
  above and is reported there as a count, not as a row.
- **(b) NO RACE ON A SERVER WRITE** — either nothing is written, **or the asserted
  node is rendered from the write's OWN response**, so the assertion cannot
  resolve before the write does. It _is_ the wait, and arming one in front of it
  waits for the same event one layer down.
  > ⚠️ **The card names (b) as _"client-only state that exists before any
  > request"_ and gives two examples of it. That is one member of the class, and
  > it is the smaller one.** The larger member — a toast, a returned DTO applied
  > in place, a `revalidatePath` payload — did not exist before the request and is
  > still not racing. Sorting by the QUESTION rather than by the two examples is
  > what moves 68 sites out of a remedy they do not need.
- **(c) OWES A WAIT** — the asserted node needs a signal BEYOND the write's own
  response (here, always a client island's `router.refresh()` RSC GET), **and the
  surface legitimately cannot patch in place** because the value is server-derived
  and could not be recomputed in the browser. Remedy: arm the wait. Fixed in this
  pull request.
- **(d) THE SURFACE OWES AN OPTIMISTIC UPDATE** — the same mechanism, but the
  asserted value IS computable from the write's own result and the surface waits
  for a whole-page refresh anyway. That is the page-state contract's case 3 left
  unmet (`CLAUDE.md`). **A wait is the wrong remedy: it papers over a real product
  defect AND retires the only detector that defect has.** Remedy: a `bug` against
  the surface; the spec is left alone.

  > **(c) and (d) share a mechanism and differ on one question — _could the
  > browser have computed this value?_** MOTIR-4496 is (d): the link row you just
  > added is exactly the row the response returns.
  > `PublicSubdomainCard` is (c), and says so in its own words — `renamesLeft` and
  > the alias rows are derived server-side, so _"optimism here would mean
  > re-deriving the cap in the browser."_ Without that question the two collapse,
  > and every refresh-driven surface in the product looks like a defect.

## The result

| disposition                                   | sites |                                                                                |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------ |
| (b) no race on a server write                 |   101 | nothing owed                                                                   |
| **(c) owes a wait**                           | **3** | `CustomDomainsSection`, `PublicSubdomainCard` — **fixed in this pull request** |
| **(d) the surface owes an optimistic update** | **0** | see below                                                                      |

### (d) — the class is EMPTY, and that is a finding rather than an absence

**No surface in the suite is left owing an optimistic update.** Getting to that
answer took reading each candidate surface's own mutation handler, and the two
near-misses are worth recording because both look like (d) from the spec side:

- **`WorkflowEditor` — four sites** (`board-config.spec.ts:68`,
  `workflow-settings.spec.ts:81` and `:88`, `workflow-delete-reassign.spec.ts:70`).
  The component takes `statuses` from props, patches nothing locally, and calls
  `router.refresh()`. That is the (d) shape exactly — **and it is not (d)**,
  because its Server Actions call `revalidatePath(WORKFLOW_PATH)`
  (`app/(authed)/settings/project/workflow/actions.ts`), so the revalidated RSC
  payload rides the ACTION's own response. The `router.refresh()` on top is
  belt-and-braces, not the paint. Disposition (b).
- **`AttachmentsPanel` and `CommentsSection`.** Both call `router.refresh()` and
  both looked like (d) to a grep. Both in fact apply the returned DTO in place
  first (`setAttachments`, `setThreads`) — the refresh only keeps the
  server-rendered first page fresh behind them. Disposition (b).

> **The rule those two produce: `router.refresh()` in the component is not the
> tell.** What decides (b) from (c)/(d) is whether the ACTION revalidates and
> whether the component patches — two reads, in the action file and in the
> handler. A sweep that stops at the component's `router.refresh()` call sites
> over-fires on a majority of them.

The only (d) this suite has ever had is the one already fixed:

| sites                                             | surface                                                       | the card                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue-detail-flow.spec.ts:461` · `:595` · `:622` | `app/(authed)/items/[key]/_components/RelationshipsPanel.tsx` | **MOTIR-4496 — already fixed**, merged 2026-09-04 in `motir-core#2626`. Listed because MOTIR-4399 criterion 4 asks for it, and because MOTIR-4496 criterion 6 makes these three tests its regression surface: **they are not amended, by anybody, and that is the point.** They no longer appear in the kept set — the panel now inserts and removes its rows from the action's own response |

### (c) — fixed here

| site                                       | what it waits on now                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `acceptance-public-address.spec.ts:160`    | `pageRefresh(page, '/settings/project/public-address')`, armed before _Add domain_ |
| `acceptance-public-address.spec.ts:197`    | the same, armed before _Rename_                                                    |
| `cloud-public-address-release.spec.ts:125` | the same, armed before _Rename_                                                    |

These three are the suite's only writes that go out over a plain `fetch` to an
API route — no Server Action, so **no `revalidatePath`, so no payload on the
response**, and the component patches nothing. A separate `router.refresh()` RSC
GET is the one and only thing that paints the asserted row, and its latency was
stacking on the write's inside a single 5 s budget.

`actionWrite` and `pageRefresh` — MOTIR-3694's two helpers, which lived inside
`activity.spec.ts` — are lifted into **`tests/e2e/_helpers/authoritative-signal.ts`**
and imported. `activity.spec.ts` keeps two one-line local aliases so every call
site in it is unchanged: the lift is a move, not a rewrite.

## What this scan can be wrong about

Say it here rather than let the next reader discover it:

- **`non-mutating-action` (344 sites) is a verb list, and a verb list is a
  heuristic.** A control named something this list does not carry — a bare glyph,
  a localised string, a test-id — that nonetheless writes, is dropped. The list is
  in the script and is the first thing to widen if a flake ever lands on a site
  this sweep did not keep.
- **The window is four lines.** An assertion further from its action than that is
  not seen at all.
- **A wait armed anywhere earlier in the test counts as armed**, even if it is
  for a different write. That over-drops, deliberately: the alternative is
  matching waits to writes, which needs the predicate the wait carries.
- **The dispositions were assigned by reading the SURFACE**, one component at a
  time — not by a rule over the spec text. A grep-shaped heuristic got
  `AttachmentsPanel` wrong during this very sweep (it patches in place through a
  setter the grep did not know the name of), which is why the table is hand-made.

## Re-running it

```sh
node scripts/scan-e2e-mutation-assert.mjs --ref origin/main --explain   # the ladder
node scripts/scan-e2e-mutation-assert.mjs --ref origin/main             # the kept sites
node scripts/scan-e2e-mutation-assert.mjs --ref origin/main --crude     # the upper bound
```

Always pass `--ref`. A count taken from a working tree is a measurement of your
own edits, not a property of the suite.

## Every kept site

| site                                           | disposition | why                                                                                                                                                               |
| ---------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-internal-billing.spec.ts:190`      | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `acceptance-internal-billing.spec.ts:271`      | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `acceptance-internal-billing.spec.ts:304`      | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `acceptance-planning-overlay.spec.ts:255`      | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `acceptance-public-address.spec.ts:160`        | C           | **(c)** needs a separate `router.refresh()` RSC GET, and the surface legitimately cannot patch in place (the value is server-derived) — **wait armed in this PR** |
| `acceptance-public-address.spec.ts:191`        | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `acceptance-public-address.spec.ts:197`        | C           | **(c)** needs a separate `router.refresh()` RSC GET, and the surface legitimately cannot patch in place (the value is server-derived) — **wait armed in this PR** |
| `attachments.spec.ts:172`                      | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `attachments.spec.ts:190`                      | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `attachments.spec.ts:192`                      | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `attachments.spec.ts:303`                      | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `automation.spec.ts:199`                       | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `automation.spec.ts:243`                       | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `automation.spec.ts:410`                       | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `backlog.spec.ts:198`                          | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `backlog.spec.ts:250`                          | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `board-config.spec.ts:68`                      | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `board-scrum-at-scale-interaction.spec.ts:643` | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `board-scrum-at-scale-interaction.spec.ts:716` | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `cloud-public-address-release.spec.ts:125`     | C           | **(c)** needs a separate `router.refresh()` RSC GET, and the surface legitimately cannot patch in place (the value is server-derived) — **wait armed in this PR** |
| `cloud-video.spec.ts:70`                       | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `cloud-video.spec.ts:194`                      | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `collab-journey.spec.ts:236`                   | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `collab-journey.spec.ts:245`                   | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `collab-journey.spec.ts:314`                   | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `collab-journey.spec.ts:329`                   | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `comments.spec.ts:58`                          | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `comments.spec.ts:121`                         | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `comments.spec.ts:130`                         | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `comments.spec.ts:135`                         | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `comments.spec.ts:140`                         | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `comments.spec.ts:151`                         | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `comments.spec.ts:156`                         | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `comments.spec.ts:159`                         | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `data-subject-request-journey.spec.ts:92`      | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `epic2-acceptance.spec.ts:142`                 | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `epic6-journey.spec.ts:267`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `issue-create-edit-flow.spec.ts:89`            | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `issue-create-edit-flow.spec.ts:167`           | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `issue-create-edit-flow.spec.ts:197`           | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `issue-create-edit-flow.spec.ts:226`           | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `issue-detail-flow.spec.ts:672`                | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `issue-detail-flow.spec.ts:695`                | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `issue-detail-flow.spec.ts:701`                | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `issue-detail-flow.spec.ts:737`                | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `issue-detail-flow.spec.ts:768`                | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `jobs-fanout-engine.spec.ts:339`               | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `labels-components-watch.spec.ts:260`          | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `labels-components-watch.spec.ts:266`          | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `labels-components-watch.spec.ts:341`          | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `labels-components-watch.spec.ts:651`          | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `link-search-flow.spec.ts:161`                 | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `link-search-flow.spec.ts:203`                 | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `link-search-flow.spec.ts:229`                 | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `link-search-flow.spec.ts:237`                 | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `link-search-flow.spec.ts:275`                 | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `onboarding-discovery.spec.ts:208`             | B           | (b) the asserted node arrives from the write’s own STREAMED response; `waitForResponse` resolves at headers, strictly earlier                                     |
| `onboarding-fresh.spec.ts:340`                 | B           | (b) the asserted node arrives from the write’s own STREAMED response; `waitForResponse` resolves at headers, strictly earlier                                     |
| `onboarding-fresh.spec.ts:427`                 | B           | (b) the asserted node arrives from the write’s own STREAMED response; `waitForResponse` resolves at headers, strictly earlier                                     |
| `onboarding-fresh.spec.ts:457`                 | B           | (b) the asserted node arrives from the write’s own STREAMED response; `waitForResponse` resolves at headers, strictly earlier                                     |
| `org-admin.spec.ts:357`                        | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `passkeys.spec.ts:256`                         | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `project-details.spec.ts:146`                  | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `project-details.spec.ts:242`                  | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `project-logo.spec.ts:199`                     | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `projects-flow.spec.ts:83`                     | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `projects-flow.spec.ts:96`                     | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `projects-flow.spec.ts:123`                    | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `projects-flow.spec.ts:126`                    | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `saved-filters.spec.ts:165`                    | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `saved-filters.spec.ts:199`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `saved-filters.spec.ts:335`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `saved-filters.spec.ts:344`                    | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `saved-filters.spec.ts:353`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `saved-filters.spec.ts:358`                    | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `saved-filters.spec.ts:364`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `saved-filters.spec.ts:371`                    | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `saved-filters.spec.ts:390`                    | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `shell-a11y-detail.spec.ts:214`                | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `shell-a11y.spec.ts:154`                       | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `shell-a11y.spec.ts:200`                       | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `shell-a11y.spec.ts:236`                       | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `shell-a11y.spec.ts:273`                       | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `shell-a11y.spec.ts:284`                       | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `shell-context-path.spec.ts:119`               | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `shell-context-path.spec.ts:122`               | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `shell-context-path.spec.ts:182`               | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `shell-flows.spec.ts:101`                      | B           | (b) the asserted state lands with a navigation, not with a repaint                                                                                                |
| `sprint-lifecycle.spec.ts:91`                  | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `sprint-lifecycle.spec.ts:280`                 | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `status-derivation.spec.ts:355`                | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `triage-flow.spec.ts:181`                      | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `work-item-todo-list.spec.ts:104`              | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `work-item-todo-list.spec.ts:114`              | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `work-item-todo-list.spec.ts:116`              | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `work-item-todo-list.spec.ts:131`              | B           | (b) the surface applies the write’s returned DTO IN PLACE — the asserted node arrives with the response                                                           |
| `work-item-type-vocabulary.spec.ts:155`        | B           | (b) client state that exists without any request (a form value, a picker prompt, a pending row before submit)                                                     |
| `workflow-delete-reassign.spec.ts:70`          | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `workflow-delete-reassign.spec.ts:95`          | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `workflow-settings.spec.ts:72`                 | B           | (b) the click opens a dialog / form / panel — the assertion reads its copy, which needs no request                                                                |
| `workflow-settings.spec.ts:81`                 | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `workflow-settings.spec.ts:88`                 | B           | (b) server-rendered, repainted by the action’s own `revalidatePath` payload — it rides the write’s response                                                       |
| `workspace-flows.spec.ts:126`                  | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
| `workspace-flows.spec.ts:142`                  | B           | (b) the asserted node is a TOAST rendered from the write’s own response — the assertion cannot resolve before the write does                                      |
