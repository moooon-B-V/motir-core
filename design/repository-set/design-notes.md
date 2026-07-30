# `design/repository-set/` — design notes

**Story MOTIR-1775 · subtask MOTIR-1778 (design gate, Principle #13).** The design reference
for **"Where should your code live?"** — the step at plan approval that turns an approved plan
into the repositories the project's architecture needs. It is the layout source of truth for
**MOTIR-1782** (the approval-step UI) and the surface **MOTIR-1785**'s E2E + acceptance video
walks.

- **Asset of record:** [`repository-set.mock.html`](./repository-set.mock.html) — the source of
  truth, built from the real design system. Its `.png` export
  ([`repository-set.png`](./repository-set.png)) is the board/PR-visible face.
- **Definition of done (three files):** `design-notes.md` + `repository-set.mock.html` +
  `repository-set.png`. All three are committed.
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — those are
  MOTIR-1782's.

---

## 0. Where every decision below came from (no flow is invented here)

| Behaviour                                                                                                         | Source                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The set's cardinality is DERIVED and CONFIRMED by the user; nothing is created until confirmation                 | ADR `docs/decisions/project-repository-set.md` §0 (MOTIR-1776, accepted)           |
| The role enum (`web` · `api` · `mobile` · `shared` · `infra` · `other`), the free-form label                      | ADR §1.1                                                                           |
| A role may repeat; ORDER is meaningful and the first row is the project's **primary** repository                  | ADR §1.2, §1.3                                                                     |
| Names: `<project-slug>` at one row, `<project-slug>-<role>` at two or more; always editable                       | ADR §1.4                                                                           |
| Collisions offer a suffixed name, pre-filled and editable, before the row is created                              | ADR §1.5                                                                           |
| Seed source per role — the starter for `web`, an INITIALISED repo for everything else                             | ADR §2                                                                             |
| Ownership decided ONCE for the set; user's account when connected, else Motir's org + claimable                   | ADR §3.1–§3.5                                                                      |
| The per-row state machine, row independence, no rollback, resumability, completion with an unresolved row         | ADR §4.1–§4.4                                                                      |
| The single-repo project is the degenerate case of the same model — a PRESENTATION difference, never a second path | ADR §6                                                                             |
| The per-row **reason** each proposed row surfaces                                                                 | MOTIR-1881 (the derivation) — "a row with no nameable reason should not exist"     |
| The host surface, the split, the rail, the approve CTA, the decided outcome                                       | `app/(authed)/plans/[id]/page.tsx` · `PlanningWorkspace` · `PlanReviewRail`        |
| The GitHub connect/install hand-off                                                                               | `app/(authed)/settings/workspace/github/page.tsx` (7.10) — pointed at, not redrawn |

### The spike's latency answer does not exist yet — and this design is safe either way

MOTIR-1777 (the four GitHub mechanics, including "what creating N repos back-to-back costs")
was **still in progress** when this was drawn; nothing about it is on `origin/main`. So rather
than guess, the design takes the shape that is correct under **both** answers: **per-row
progress**. Each row owns its own `creating` indicator and resolves independently, which is
required if creation is slow and merely harmless if it is fast. The card's instruction — "if the
spike finds creation is slow, draw per-row progress rather than one blocking spinner" — is
therefore satisfied without waiting on it.

**What the spike could still change, and where:** if it finds a row can be created and installed
in a few hundred milliseconds, the `creating` state becomes a flicker and MOTIR-1782 may choose
one request for the whole set — the drawing does not change, only how long the state is on
screen. If it finds partial failure is **not** retryable per repo, the failed row's **Retry**
recovery is the affordance to revisit (the other two — use-an-existing, skip — hold regardless).
Nothing else in this asset depends on it.

---

## 1. Drawn against SHIPPED reality — what was RENDERED first

The step lands inside a surface that already exists, so it was **rendered before anything was
drawn** (`notes.html` #73 — reading the `.tsx` is not seeing what renders). `pnpm build` +
`next start` on `origin/main` @ `c76e2b7a`, signed in against a tenant seeded through the shipped
services (`tests/e2e/_helpers/plans-review-seed.ts`), full-page screenshots at 1440×,
`deviceScaleFactor: 2`:

- **`/plans/<planned-plan>`** — the pre-approve state: the bordered `--el-canvas` box, the
  proposed-plan canvas on the left, and the rail's **"Approve — add 1 item to your backlog"** /
  **Decline** gate with the hint _"Approve materializes the proposals into your backlog."_
- **`/plans/<approved-plan>`** — the state the step lands back into: the same box, the rail's
  status pill flipped to **Approved**, the history gaining **"Approved · Plans Owner"**, and
  `DecidedOutcome` showing a `--el-success` Sparkles + **"Added 1 item to your backlog"** +
  **"View in backlog"**.
- **`/settings/workspace/github`** (nav label **"Git"**) — the two-grant connect flow (identity,
  then install). Panel 5 points at it in one line of secondary type and redraws none of it.

Everything in the mock composes what those renders actually show. The route header (back chevron +
`font-serif text-xl` title), the box, the `grid-cols-[1fr_22rem]` split, and every element of the
rail are **mirrored markup**, not a stylized stand-in.

### What is genuinely new here

Exactly one thing: **the step that occupies the canvas pane.** The rail is reused untouched; the
route, the box and the split are the shipped ones. Per `notes.html` #82/#95, this design does not
redraw the plan-approval surface, the canvas, the review rail, or the GitHub connect screens — and
it does not draw the code-context / index-freshness surface, which **MOTIR-1764** owns.

---

## 2. Placement — derived from shipped reality, not chosen freely

**The step takes the CANVAS pane of the plan-detail box; the review rail stays.** Three reasons,
all from the shipped surface rather than preference:

1. **The card requires the step "in place, inside the plan-approval flow — not a floating panel."**
   A `Modal` is exactly the floating panel that rules out; the canvas pane is the surface's own
   content region.
2. **Keeping the rail is what makes the step honest.** The rail already says **Approved** and
   **"Added 24 items to your backlog"** — so the user can see, while answering the repo question,
   that their plan is already safe. That is the visual form of §4.3: the step is not a gate.
3. **The proposals are no longer the thing to look at.** Once the plan has materialized, the
   canvas of proposed nodes has served its purpose; replacing it (not shrinking it) is the
   truthful use of the space.

**Access path, drawn in panel 0** (the access-path rule — the reader must SEE the door):

```
/plans/[id]  ──[ Approve — add 24 items to your backlog ]──▶  the step  ──[ Create N repositories ]──▶  the plan is live
  (planned)        materializes + proposes the repo set        (canvas pane,        per-row outcomes        (rail outcome +
                                                               rail = Approved)                             "N repositories created")
```

**Re-entry, also drawn:** while any row is `failed` or `skipped`, the rail's outcome card carries
**"Finish setting up repositories"** in place of the created-count line, routing back into this
same step. It earns **no new left-nav entry** — this is an action inside an existing surface, not
a first-class project VIEW (`notes.html` #99). The durable home for "which roles have code, how
fresh is the index" is MOTIR-1764's code-context surface; this asset points at it and stops.

### Why this is a step and NOT an approval gate (the `notes.html` #151 test, applied)

#151 forbids a human approval gate on an AI-derived artifact a non-technical user cannot judge.
This step passes both of its questions:

- **Can the target user meaningfully judge it?** Yes. "Where should my code live, and what is it
  called" is a question a non-technical founder can answer — and the answer creates real
  repositories in an account they own. It is not a coding standard.
- **Does answering it block their flow?** No. Approve materializes the plan **first**; the items
  are in the backlog before the step is answered, every row can be skipped, and **Not now** leaves
  the whole set for later. Nothing the user needs is held hostage.

It is therefore a **step with a proposed default**, not a gate — which is also exactly what ADR
§0.2 decided (Principle #3: the plan is editable before coding starts, and the repo set is part of
the plan).

---

## 3. The two cardinalities — what changes, and what deliberately does not

The card's central design problem. **One component, two renderings.**

### What is DIFFERENT at ≥2 rows

| At one row                                                 | At two or more rows                                                          | Why                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **No row container** — the field sits directly on the pane | Each row is a `Card`-shaped container                                        | A single card around a single field is a box inside a box         |
| **No role chip**                                           | A neutral mono role chip per row (`web` · `api` · …)                         | With one repository there is nothing to tell apart                |
| Name is `acme-booking` — **no role suffix**                | Names gain the suffix: `acme-booking-web` · `acme-booking-api`               | ADR §1.4                                                          |
| **No reorder grip, no per-row `⋯` menu**                   | Grip + Move up/Move down + a `⋯` menu (use existing · skip · remove)         | Order only means something with a second row (ADR §1.3)           |
| **No "Primary repository" caption**                        | The first row carries it                                                     | Same reason                                                       |
| **No per-row "Why this repository?"**                      | Every row carries it                                                         | The reason answers "why is there another one?"                    |
| Secondary is plain text beside **Add a repository**        | Secondary moves into the row's `⋯` menu                                      | Per-row actions need a per-row home once rows are distinguishable |
| Lead copy: _"Motir will create this repository…"_          | Lead copy names the split: _"Your plan separates the web app from the API…"_ | The count is explained, never merely displayed                    |
| Primary: **Create repository**                             | Primary: **Create 2 repositories**                                           | The CTA names what it will create (the shipped review grammar)    |

### What is deliberately the SAME

The **heading**, the **eyebrow**, the **set-level target line**, the **row component**, the
**field**, every **per-row state**, the **why** grammar, **Add a repository**, **Not now**, the
primary-action shape, and the completion path. There is **no table header, no count chip, no
"1 of N", no step counter and no grid** at any cardinality — a two-row set is two rows, not a
spreadsheet with two entries. Going from one row to two adds **one row and four affordances**,
never a different screen.

> **A one-row set must never look like a list of one, and a two-row set must never look
> advanced.** If the single-repo case grows table chrome, or the two-repo case grows a
> "multi-repo mode", the design has been broken.

---

## 4. Every per-row state (ADR §4.1), and its forward path

| State       | How it reads                                                                                                                                                                                            | Forward paths on the row                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `proposed`  | The default: editable name field, seed-source helper, the "why" disclosure, `⋯` menu. No state indicator — it is the resting state.                                                                     | Create (set-level) · use existing · skip · remove              |
| `creating`  | **Per-row** `Spinner` + **"Creating…"** + what it is doing (_"Adding it to the Motir GitHub App"_), in a `role="status"` line. The name is frozen; siblings keep working.                               | resolves to `created` or `failed`                              |
| `created`   | `--el-success-surface` row · `CircleCheckBig` in `--el-success` + **"Created"** · the real `owner/name` as an external link · what it was seeded from.                                                  | (settled) open on GitHub                                       |
| `connected` | `--el-notice-info-bg` row · `Link` icon in `--el-info` + **"Connected"** · the adopted `owner/name` · _"nothing was created and nothing was changed in it."_                                            | (settled) open on GitHub                                       |
| `skipped`   | Quiet `--el-surface-soft` row · `SkipForward` in `--el-icon-muted` + **"Skipped"** · _"No repository for the mobile app"_ in secondary ink · what Motir will do about it.                               | **Create it after all** · **Use an existing repository**       |
| `failed`    | `--el-danger-surface` row · `TriangleAlert` in `--el-danger` + **"Couldn't create"** · the reason **in words**, in a `role="alert"` · the name field re-opened with the suffixed suggestion (ADR §1.5). | **Retry** · **Use an existing repository** · **Skip this one** |

**Rules the states obey**

- **Rows are independent.** State lives on the row, never on the step — one spinner or one failure
  never freezes or reverts a sibling (ADR §4.2). There is **no set-level blocking overlay** and
  **no compensating delete**: a created repository is a real artifact in the user's account, and
  removing it to make a report tidy is the worse answer.
- **No state is a dead end.** `failed` and `skipped` both keep every recovery, at this visit and at
  any later one (§4.1, §4.4).
- **State is never colour alone** — always an icon **plus a word** (finding #35), and every tinted
  row keeps AA by holding `--el-text-strong` / `--el-danger-surface-text` ink over the tint.
- **No dashed or dotted border signals state.** The planning canvas already owns dashed borders for
  proposed nodes and red-hatch for cross-story dependencies; reusing either here would collide
  (and a hardcoded border-style also breaks the `data-style` shape axis).
- **A state pill is NOT used on a tinted row.** `Pill severity="danger"` is `--el-tint-rose` and
  `--el-danger-surface` is the same value, so a danger pill on a failed row is invisible — the same
  for mint/`created` and muted/`skipped`. So the **tint goes on the row** and the state is named in
  text beside its icon (`.row-state`). Only the role chip stays a `Pill tone="neutral"`, which has
  its own border and reads on every tint.

---

## 5. The PARTIAL outcome (panel 4) — the picture a happy-path mock omits

One set holding `created` + `failed` + `skipped`, drawn as a first-class state:

- A `role="status"` summary counts the truth: **"1 created · 1 skipped · 1 needs a decision"**.
- The primary action becomes **Finish setup** — approval may complete with an unresolved row
  (ADR §4.3), and the step must not trap the user.
- Nothing pretends the failed row succeeded, and the created row is not rolled back.
- The closing note tells the user what the state costs them: _"Your plan is already in the backlog.
  Motir will tell you which tasks are waiting on a repository."_ — the honest handover to the
  code-blind signal MOTIR-1754 renders.

---

## 6. The no-GitHub path (panel 5)

**Same step, same rows, same primary action.** Only two things differ:

1. The set-level target line becomes **"Created in Motir's organization — yours to claim any
   time"** with a `Building2` icon instead of the GitHub mark (ADR §3.3), and the row prefixes read
   `motir-projects /`.
2. A `--el-warning-surface` callout explains the consequence and its undo: _"Motir holds these
   repositories for you. **Claiming moves the whole set to your own GitHub account** and keeps
   everything connected — do it whenever you're ready, or never."_ (ADR §3.4; MOTIR-711 / 9.3.7 is
   the flow that later performs it, whole-set.)

**There is no GitHub prompt on this path.** Connecting an account is a single line of secondary
type under the primary action — _"Prefer your own account? **Connect a GitHub account first** — it
opens Settings › Git, and this step waits for you."_ — handing off to the **shipped** pane. Because
ownership is a set-level property (§3.5), a set is never half in the user's account and half in
Motir's: a row that cannot be created in the chosen target **fails as a row** and never silently
retargets.

---

## 7. The per-row "why" (tied to the derivation's recorded signal)

MOTIR-1881 records the signal that produced each proposed row, and requires that _"a row with no
nameable reason should not exist."_ This design surfaces it as a **per-row disclosure**, not a
tooltip — so it is readable, keyboard-reachable and quotable:

- Trigger: a quiet `CircleHelp` + **"Why this repository?"** in `--el-link`, at the bottom of the
  row.
- Open: a `--el-callout-bg` (lavender) panel with a `Sparkles` in `--el-accent-on-surface` — the
  **shipped AI-proposal grammar** (`ExpansionNudgeBanner` / the plan-review `add` treatment), so an
  inferred thing looks inferred.
- Content: the signal in the user's terms, then the way out —
  _"9 of the 24 items you approved build a backend service, so Motir proposed a separate `api`
  repository. Remove this row if you would rather keep everything in one."_

A wrong proposal is then **arguable rather than mysterious**, which is the whole point of recording
the reason.

---

## 8. Primitives — every element, and what it is

| Element                           | Primitive                                                   | Notes                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Step heading                      | `h2` `font-serif text-2xl`                                  | Matches the shipped serif page/panel heading scale                                                                                    |
| "Your project's code" overline    | `SectionLabel`                                              | mono · 11px · 0.06em · `--el-text-eyebrow`                                                                                            |
| A row container (≥2 rows)         | `Card` (untinted, `data-surface="card"`)                    | `--radius-card` · `--el-border` · row padding, NOT `--spacing-card-padding` (a row is denser than a page card)                        |
| Repository name field             | `Input` (composing `FormField`)                             | `addonStart` carries the `owner /` prefix; `--height-input` · `--radius-input` · `--el-input-border`; `error` variant on a failed row |
| Role chip                         | `Pill tone="neutral"`                                       | mono label; roles are metadata, not a status — no semantic tint is spent on them                                                      |
| Primary action                    | `Button variant="primary"` + `GithubMark`                   | `Create repository` / `Create 2 repositories`                                                                                         |
| `Not now`                         | `Button variant="ghost"`                                    | Set-level defer                                                                                                                       |
| Row recoveries                    | `Button variant="secondary" size="sm"` (first) + `ghost sm` | Retry is the emphasized one; the others stay quiet                                                                                    |
| Reorder / menu trigger            | icon `Button` at `--height-control` + `--radius-control`    | `ChevronUp` / `ChevronDown` / `Ellipsis`                                                                                              |
| Row `⋯` menu                      | `Popover` + a menu list                                     | `--radius-card` container, `--radius-control` rows, `--el-option-active-bg` active row                                                |
| Connect-existing picker           | `Combobox`                                                  | over the repos the installation already grants; the "Grant more on GitHub" link hands off to 7.10                                     |
| `creating` indicator              | `Spinner size="sm"`                                         | inside a `role="status"` line                                                                                                         |
| The "why" panel                   | a callout `div` (`--el-callout-bg`) + `Sparkles`            | mirrors the shipped AI-proposal callout; not a `Tooltip`                                                                              |
| The claimable callout             | a callout `div` (`--el-warning-surface`) + `Info`           | text + icon, never colour alone                                                                                                       |
| Failed-row reason                 | `p role="alert"` + `TriangleAlert`                          | announced once, per row                                                                                                               |
| Rail (status · history · outcome) | **the shipped `PlanReviewRail`**                            | reused verbatim — no new primitive                                                                                                    |

**No new primitive is introduced.** If MOTIR-1782 finds it needs one, that is its own `design/`
subtask, not an improvisation.

---

## 9. Token roles — colour (`--el-*`) and shape

Every value in the mock's `:root` block was **generated** from `packages/design-system/theme.css`
(the Tier-0 `@theme` + Tier-3 `:root,[data-appearance-scope]` blocks), so no hex was retyped and
the asset cannot drift from the shipped layer. The only raw values authored anywhere in the file
are the mock **board's own** backdrop and the canvas grid-dot texture — non-semantic decoration
that carries no meaning, per the colour rule's one carve-out. **Dark mode needs nothing extra:**
because every colour is an `--el-*` reference, `theme.css`'s `[data-theme='dark']` block re-skins
the whole step.

### Colour

| Element                                         | Token                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Step pane (behind the step)                     | `--el-canvas` (the shipped recessed board)                           |
| Row container · rail card                       | `--el-card` · `--el-surface` / `--el-surface-soft`                   |
| Row border                                      | `--el-border` (`--el-border-soft` on a skipped row)                  |
| Heading / body / helper ink                     | `--el-text` · `--el-text-secondary` · `--el-text-helper`             |
| Overline                                        | `--el-text-eyebrow`                                                  |
| Field                                           | `--el-page-bg` fill · `--el-input-border` · `--el-text-muted` prefix |
| Primary action                                  | `--el-accent` / `--el-accent-text`                                   |
| Secondary action outline                        | `--el-button-border`                                                 |
| Links (`Change account`, `undo`, the repo name) | `--el-link`                                                          |
| `created` row · its icon                        | `--el-success-surface` · `--el-success`                              |
| `connected` row · its icon                      | `--el-notice-info-bg` · `--el-info`                                  |
| `failed` row · its icon · its ink               | `--el-danger-surface` · `--el-danger` · `--el-danger-surface-text`   |
| `skipped` row · its icon                        | `--el-surface-soft` · `--el-icon-muted`                              |
| The "why" callout · its sparkle                 | `--el-callout-bg` · `--el-accent-on-surface`                         |
| The claimable callout · its icon                | `--el-warning-surface` · `--el-warning` (ink `--el-warning-text`)    |
| Role chip                                       | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`          |
| Rail status pill (Approved)                     | `--el-tint-mint` + `--el-text-strong` (the shipped `STATUS_TINT`)    |
| Grip / icon buttons                             | `--el-icon-muted` · `--el-icon-btn`                                  |

Six semantic hues are in play (accent, success, info, danger, warning, lavender-callout) plus the
neutral chip — this is not a grey-and-purple screen (finding #54), and every hue lives in a
BACKGROUND with `--el-text-strong`-class ink over it, never as small coloured text.

### Shape

| Surface                                             | Token                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Buttons                                             | `--radius-btn` · `--height-btn-md` / `--height-btn-sm` · `--spacing-btn-x` |
| Row container · callouts · menu container · the box | `--radius-card`                                                            |
| Field · combobox trigger                            | `--radius-input` · `--height-input` · `--spacing-input-x`                  |
| Role chip                                           | `--radius-badge` · `--spacing-chip-x` / `-y`                               |
| Icon buttons · menu rows                            | `--radius-control` · `--height-control` · `--spacing-control-x` / `-y`     |
| Menu elevation                                      | `--shadow-elevated`                                                        |

**No Tier-0 `--color-*`, no generic `--radius-sm/md/lg`, no raw `rounded-md` / `p-2` / `h-9`, and
no invented hue** anywhere in the asset — the two swap axes (palette, style) both stay intact.

---

## 10. Copy — every string, as `en.json` keys

Namespace **`repositorySet`**. MOTIR-1782 adds these to `messages/en.json` **and**
`messages/zh.json` (the i18n-catalog parity test fails otherwise).

| Key                   | String                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overline`            | Your project's code                                                                                                                                                        |
| `title`               | Where should your code live?                                                                                                                                               |
| `leadOne`             | Motir will create this repository in your GitHub account and connect it, so your agents can start work. Rename it first if you like.                                       |
| `leadSplit`           | Your plan separates the web app from the API, so Motir proposed two repositories. Rename, add or remove any of them before they are created.                               |
| `leadPartial`         | Two of three are settled. You can finish now and come back to the third.                                                                                                   |
| `targetUser`          | Created in {login} on GitHub                                                                                                                                               |
| `targetMotir`         | Created in Motir's organization — yours to claim any time                                                                                                                  |
| `changeAccount`       | Change account                                                                                                                                                             |
| `nameLabelOne`        | Repository name                                                                                                                                                            |
| `nameLabelForRole`    | Name of the {role} repository                                                                                                                                              |
| `primaryRow`          | Primary repository                                                                                                                                                         |
| `seedStarter`         | Seeded from the Motir Next.js starter — app, database and design system, ready to run.                                                                                     |
| `seedStarterShort`    | Seeded from the Motir Next.js starter.                                                                                                                                     |
| `seedInitialised`     | Starts with a README, a licence, a `.gitignore` and a CI stub — your first task in it builds the skeleton.                                                                 |
| `whyTrigger`          | Why this repository?                                                                                                                                                       |
| `whyApi`              | {n} of the {total} items you approved build a backend service, so Motir proposed a separate {role} repository. Remove this row if you would rather keep everything in one. |
| `addRow`              | Add a repository                                                                                                                                                           |
| `useExisting`         | Use an existing repository                                                                                                                                                 |
| `skipRow`             | Skip this one                                                                                                                                                              |
| `removeRow`           | Remove                                                                                                                                                                     |
| `rowActions`          | Repository actions                                                                                                                                                         |
| `moveUp` / `moveDown` | Move up / Move down                                                                                                                                                        |
| `createOne`           | Create repository                                                                                                                                                          |
| `createMany`          | Create {n} repositories                                                                                                                                                    |
| `notNow`              | Not now                                                                                                                                                                    |
| `createHintOne`       | You can change this later — nothing is created until you press Create.                                                                                                     |
| `createHintMany`      | Both are created in the same account, and both stay yours.                                                                                                                 |
| `stateCreating`       | Creating…                                                                                                                                                                  |
| `stateCreatingDetail` | Adding it to the Motir GitHub App                                                                                                                                          |
| `stateCreated`        | Created                                                                                                                                                                    |
| `createdDetail`       | Seeded from the Motir Next.js starter · connected to Motir.                                                                                                                |
| `stateConnected`      | Connected                                                                                                                                                                  |
| `connectedDetail`     | Your existing repository — nothing was created and nothing was changed in it.                                                                                              |
| `stateSkipped`        | Skipped                                                                                                                                                                    |
| `skippedTitle`        | No repository for the {roleLabel}                                                                                                                                          |
| `skippedDetail`       | Motir will plan around it, and say so when a task needs code that isn't there.                                                                                             |
| `createAfterAll`      | Create it after all                                                                                                                                                        |
| `stateFailed`         | Couldn't create                                                                                                                                                            |
| `failedNameTaken`     | {login} already has a repository called {name}. Rename this one, or use the existing repository instead.                                                                   |
| `failedLimit`         | GitHub declined the request — {login} has hit its repository limit. Nothing was created for this row.                                                                      |
| `retryRow`            | Retry                                                                                                                                                                      |
| `summaryPartial`      | {created} created · {skipped} skipped · {unresolved} needs a decision                                                                                                      |
| `finishSetup`         | Finish setup                                                                                                                                                               |
| `finishHint`          | Your plan is already in the backlog. Motir will tell you which tasks are waiting on a repository.                                                                          |
| `claimNote`           | Motir holds these repositories for you. Claiming moves the whole set to your own GitHub account and keeps everything connected — do it whenever you're ready, or never.    |
| `connectInstead`      | Prefer your own account? Connect a GitHub account first — it opens Settings › Git, and this step waits for you.                                                            |
| `pickerLabel`         | Repository to use for the {role}                                                                                                                                           |
| `pickerHint`          | Only the repositories you granted Motir appear here.                                                                                                                       |
| `grantMore`           | Grant more on GitHub                                                                                                                                                       |
| `monorepoCollapsed`   | Everything lives here. Motir removed the second proposed row — undo.                                                                                                       |
| `outcomeRepos`        | {n} repositories created                                                                                                                                                   |
| `outcomeUnresolved`   | {n} of {total} repositories still needs a decision.                                                                                                                        |
| `finishSetupLink`     | Finish setting up repositories                                                                                                                                             |

### Accessible names — the superstring audit

A new control's accessible name must not **contain** an existing one, or `getByRole` selectors
start matching two things (`notes.html` — the superstring-label class). Checked against
`messages/en.json`:

- **`Use an existing repository`** was chosen over "Connect existing", which would have contained
  the exact existing name **"Connect"** (`import.steps.connect`, `gitlab.projects.connectAction`,
  `onboardingMigrate.rail.connect`).
- **`Not now`** was chosen over "Skip for now", which would have contained
  **"SKIP"** (`import.preview.actionSkip`) — and, worse, would have collided with this surface's
  own **"Skip this one"**.
- **`Retry`** and **`Remove`** duplicate existing names **exactly** (`dashboards.states.retry`,
  `settings.members.remove`). That is fine and already the norm — an exact duplicate on another
  surface is not a superstring; only containment breaks a selector.
- **Within this surface**, no name contains another: `Create repository` / `Create 2 repositories`,
  `Add a repository` / `Use an existing repository`, `Skip this one`, `Repository actions`,
  `Move up` / `Move down`, `Not now`, `Finish setup`, `Why this repository?`, `Retry`, `Remove`,
  `Create it after all`, `Change account`, `Grant more on GitHub`.
- `Create repository` / `Create 2 repositories` both contain **"Create"**, which exists exactly on
  other surfaces (`shell.createIssue.create`). Unavoidable for a create action, and never on the
  same screen — noted so MOTIR-1785 scopes its selectors to this step rather than the page.

---

## 11. a11y

- **Every state carries text**, not colour alone: an icon plus a word (finding #35). Tinted rows
  hold `--el-text-strong` / `--el-danger-surface-text` ink so AA holds in both themes.
- **The failed row's reason is a `role="alert"`**, once per row — the row that failed announces
  itself, not the whole step.
- **`creating` and the partial summary are `role="status"`** (polite): progress and counts are
  announced without interrupting.
- **The reorder affordance is keyboard-operable** — the grip is decorative (`aria-hidden`) and the
  real controls are **Move up** / **Move down** buttons; the drag is an enhancement, never the only
  path.
- **Every field has a real label.** At one row it is visible (**Repository name**); at ≥2 rows it
  is visually hidden but role-specific (**Name of the web repository**), so the rows are
  distinguishable to a screen reader even though the visible label is the role chip.
- **The `⋯` menu is a `Popover`** with the trigger named **Repository actions** — a menu with a
  door, not a floating list (and never portaled out of a dialog: portaling a custom popover to
  `document.body` breaks it inside Radix).
- **Long names must not blow out the row.** Every flex column in the mock carries `min-width: 0`
  and the full `owner/name` truncates with an ellipsis — this repo's recurring
  horizontal-overflow class is a missing `min-w-0`.

---

## 12. Page state after the step's mutations (the enforced contract)

Creating a row's repository changes three surfaces, and they do **not** all refresh the same way
(`motir-core/CLAUDE.md`):

1. **The row itself** — the response IS the confirmation. Keep the optimistic/returned state; do
   **not** `router.refresh()` the row (the refresh re-reads and causes a visible revert).
2. **The rail's outcome card** (server-rendered from the plan review read) — `router.refresh()`
   reaches it, which is how **"N repositories created"** / **"Finish setting up repositories"**
   appears.
3. **Any client island seeded from server props** — the project's code-context surface and any nav
   badge own their own state; `router.refresh()` cannot reach them, so they need an explicit
   refetch trigger (a provider tick). MOTIR-1782 must do the ones that exist and leave the rest to
   MOTIR-1764.

---

## 13. Explicitly OUT of scope here (so nothing is built twice)

- **The plan-approval surface, the canvas, the review rail** — shipped (MOTIR-847 / 1193 / 1194).
  Composed, not redrawn.
- **The GitHub connect / install screens** — 7.10 (`settings/workspace/github`). Only the hand-off
  is drawn.
- **The code-context / index-freshness surface, and the code-blind planning signal** — MOTIR-1764
  (Story MOTIR-1754). This asset points at it as the durable home of the set and draws none of it.
- **The claim / transfer flow** — MOTIR-711 (9.3.7). Only the claimable framing is drawn.
- **The repo-set table, the derivation service, the creation primitive** — MOTIR-1780 / 1881 / 1781. Behaviour is quoted; no schema or service is designed here.
- **The multi-stack scaffold registry** — MOTIR-709 (9.3.5). The design states honestly that a
  non-web repo starts near-empty until then, rather than implying a scaffold that does not exist.
