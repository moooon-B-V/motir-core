# `design/repository-set/` — design notes

**Story MOTIR-1775 · subtask MOTIR-1778 (design gate, Principle #13).** The design reference for
**"Where should your code live?"** — the step at plan approval that gives an approved plan
somewhere for its code to live. It is the layout source of truth for **MOTIR-1782** (the
approval-step UI) and the surface **MOTIR-1785**'s E2E + acceptance video walk.

- **Asset of record:** [`repository-set.mock.html`](./repository-set.mock.html) — the source of
  truth, built from the real design system. Its `.png` export
  ([`repository-set.png`](./repository-set.png)) is the board/PR-visible face.
- **Definition of done (three files):** `design-notes.md` + `repository-set.mock.html` +
  `repository-set.png`. All three are committed.
- **Scope:** pixels and copy only. No React, no route, no `en.json` entries — those are
  MOTIR-1782's.

---

## 0. The answer in one line

**Motir hosts your code. One sentence, one button, and a small "I already have code" for the
people who do.**

Everything technical — repository names, roles, the account, per-repository progress, GitHub error
strings — lives **behind that small link**, and appears only once a user has said they already
have code, which is how they self-identify as someone the word "repository" means something to.

### Why the first version of this design was wrong, and what changed (Yue, 2026-07-30)

The first pass drew the underlying model on screen: a row per repository, each with a `web`/`api`
role chip, an editable `<owner>/<name>`, a seed source, and per-row GitHub failure reasons — and
asked the user to curate it. **That is a developer tool.** Motir is chat-first and explicitly not
developers-only; the person approving a plan is usually a founder who does not know what a
repository is, let alone why their project needs two.

This is the **`notes.html` #151 class, second occurrence**. #151 was the coding convention planned
as `proposed → edit → APPROVE → standard`, and the rule it produced is: _do not plan a human
approval gate — or a bespoke edit surface — for an AI-derived artifact a non-technical user cannot
meaningfully evaluate; derive it, use it automatically, and expose it read-only._ The repo SET is
exactly such an artifact: it is **derived** (ADR §0.1, from the plan's own contents), and a founder
cannot judge whether three repositories is right.

Two consequences worth recording, because they are not just a redraw:

- **The CARD asked for the wrong thing.** MOTIR-1778 requires "the set, as rows … role, editable
  name, where it will be created, what it is seeded from" and "both cardinalities drawn side by
  side" as the point of the card. Those requirements are satisfied here **for the technical path
  only**; the default path deliberately shows none of it. The card needs amending to say so.
- **ADR §0.2 needs one amendment.** It reads "the set is presented with every row editable (add,
  remove, rename, change role, switch to connect-existing) and nothing is created until it is
  confirmed." That is now true of the **technical path**, not of the default. The rest of the ADR
  is untouched — and §6 already anticipated this exact latitude: _"the one-question feel is a
  property of the PRESENTATION of a one-row set (MOTIR-1778 / MOTIR-1782), never of a second branch
  in the model."_

**The model is unchanged.** The set still holds as many rows as the architecture decides, still
carries roles and per-row state, and `targetRepo` still resolves through it (ADR §5). Only who is
shown it changed.

---

## 1. Where every decision came from (no flow is invented here)

| Behaviour                                                                                     | Source                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The set's cardinality is DERIVED from the plan; the default is one `web` repo on thin signals | ADR `docs/decisions/project-repository-set.md` §0.1 (MOTIR-1776, accepted)         |
| Presentation of a one-row set is this card's to decide, not the model's                       | ADR §6                                                                             |
| The role enum (`web` · `api` · `mobile` · `shared` · `infra` · `other`)                       | ADR §1.1                                                                           |
| ORDER is meaningful; the first row is the project's **primary** repository                    | ADR §1.3                                                                           |
| Names: `<project-slug>` at one row, `<project-slug>-<role>` at two or more; always editable   | ADR §1.4                                                                           |
| Collisions offer a suffixed name, pre-filled and editable, before the row is created          | ADR §1.5                                                                           |
| Seed source per role — the starter for `web`, an INITIALISED repo for everything else         | ADR §2                                                                             |
| **Motir's org + claimable when there is no GitHub identity** — the DEFAULT path here          | ADR §3.3, §3.4                                                                     |
| Ownership decided ONCE for the set; never half Motir's and half the user's                    | ADR §3.2, §3.5                                                                     |
| The per-row state machine, row independence, no rollback, resumability, partial completion    | ADR §4.1–§4.4                                                                      |
| The single-repo project is the degenerate case of one model, never a second code path         | ADR §6                                                                             |
| The per-row **reason** a proposed row surfaces                                                | MOTIR-1881 — "a row with no nameable reason should not exist"                      |
| The host surface, the split, the rail, the approve CTA, the decided outcome                   | `app/(authed)/plans/[id]/page.tsx` · `PlanningWorkspace` · `PlanReviewRail`        |
| The GitHub connect/install hand-off                                                           | `app/(authed)/settings/workspace/github/page.tsx` (7.10) — pointed at, not redrawn |
| Don't gate an AI-derived artifact a non-technical user can't judge                            | `notes.html` #151                                                                  |

> **A pleasant consequence of the inversion:** what used to be the "no-GitHub variant" is now the
> **main line**. Motir-hosted is the default, so the non-technical journey has no GitHub in it at
> all — and ADR §3.3's claimable framing stops being an edge case to explain and becomes the one
> promise the default path makes ("It's yours — move it to your own GitHub whenever you want").

### The spike's latency answer does not exist yet — and this design is safe either way

MOTIR-1777 (the four GitHub mechanics, including "what creating N repos back-to-back costs") was
**still in progress** when this was drawn; nothing of it is on `origin/main`. So the design takes
the shape that is correct under both answers:

- **Default path:** ONE status line for the whole set — _"Setting up your code…"_ — which is right
  whether that takes 400ms or 20s, and never exposes a per-repository count the user did not ask
  for.
- **Technical path:** **per-row** progress, required if creation is slow and harmless if it is
  fast.

If the spike finds partial failure is not retryable per repo, the failed row's **Retry** is the
affordance to revisit; the other two recoveries (use one of mine, skip) hold regardless. Nothing
else here depends on it.

---

## 2. Drawn against SHIPPED reality — what was RENDERED first

The step lands inside a surface that already exists, so it was **rendered before anything was
drawn** (`notes.html` #73 — reading the `.tsx` is not seeing what renders). `pnpm build` +
`next start` on `origin/main` @ `c76e2b7a`, signed in against a tenant seeded through the shipped
services (`tests/e2e/_helpers/plans-review-seed.ts`), full-page screenshots at 1440×,
`deviceScaleFactor: 2`:

- **`/plans/<planned-plan>`** — the pre-approve state: the bordered `--el-canvas` box, the
  proposed-plan canvas, and the rail's **"Approve — add 1 item to your backlog"** / **Decline**
  gate with the hint _"Approve materializes the proposals into your backlog."_
- **`/plans/<approved-plan>`** — the state the step lands back into: the rail's pill flipped to
  **Approved**, the history gaining **"Approved · Plans Owner"**, and `DecidedOutcome` showing a
  `--el-success` Sparkles + **"Added 1 item to your backlog"** + **"View in backlog"**.
- **`/settings/workspace/github`** (nav label **"Git"**) — the two-grant connect flow. Panel 3b
  mirrors it as the hand-off target and redraws none of it.

The route header, the box, the `grid-cols-[1fr_22rem]` split and every element of the rail are
**mirrored markup**, not stylized stand-ins. **The step is the only new surface.**

---

## 3. Placement and the access path

**The step takes the CANVAS pane of the plan-detail box; the review rail stays.**

1. The card requires the step "in place, inside the plan-approval flow — **not a floating panel**."
   A `Modal` is exactly what that rules out; the canvas pane is the surface's own content region.
2. **Keeping the rail is what makes the step honest.** It already reads **Approved** and **"Added
   24 items to your backlog"**, so the user can see their plan is safe while answering. That is the
   visual form of ADR §4.3.
3. Once the plan has materialized, the canvas of proposals has served its purpose; replacing it is
   the truthful use of the space.

```
/plans/[id]  ──[ Approve — add 24 items to your backlog ]──▶  the step  ──[ Continue ]──▶  the plan is live
  (planned)        materializes + derives the repo set        "Motir will      Motir sets it up      (rail outcome +
                                                              host your code"                        "Your code is ready")
```

**The rail's outcome gains exactly one plain line — "Your code is ready" — and never a repository
count or name.**

**Re-entry (the no-dead-end guarantee).** The set is durable (ADR §4.4), so the step is
re-enterable — but the default path has nothing to come back for, because Motir finishes it. The
door back exists for the two cases that need it: setup didn't finish (panel 2c), and the user later
decides to use their own GitHub. The permanent home for both is the code-context surface
(**MOTIR-1764** / Story MOTIR-1754) — **not drawn here**. The step earns **no new left-nav entry**:
it is an action inside an existing surface, not a first-class project VIEW (`notes.html` #99).

### Why this is a step and not a gate

- **Can the target user judge it?** The default asks one thing they can answer — _is it fine for
  Motir to host this?_ — and nothing they cannot.
- **Does answering it block their flow?** No. Approve materializes the plan **first**; the items
  are in the backlog before the step is answered, and **"Continue"** is a one-click accept of a
  default that is already correct.

---

## 4. The default path (panels 1, 1b, 2) — the whole thing for most users

**Panel 1.** Overline, one serif statement, one sentence of body, one primary, one quiet secondary.
Absent by design: repository name, role, account, count, rows, table chrome, seed source, reorder,
per-row menu, "add a repository". The only branch is **I already have code**, sized like the
exception it is.

**Panel 1b — both cardinalities.** The card's central problem, answered by **removing the
question**: the same screen ships whether the plan needs one repository or three. The two renders in
the mock are **identical pixels**; only what Motir does behind them differs. Nothing about
cardinality reaches the user, so a one-row set cannot look like a list of one and a three-row set
cannot look advanced.

**Panel 2 — three states, in plain language.** The ADR's six per-row states are the _model_; this
path renders only what the user can act on:

| ADR state                            | Default path                                                                                             | Forward path                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `creating`                           | **"Setting up your code…"** — one `role="status"` line for the whole set                                 | (resolves)                            |
| `created`                            | **"Your code is ready"** + _"See where it lives"_                                                        | **Go to my backlog**                  |
| `failed`                             | **"Motir couldn't finish setting up your code"** + what it costs (nothing yet)                           | **Try again** · _I already have code_ |
| `proposed` · `connected` · `skipped` | **cannot occur** — nothing is proposed for approval, nothing is adopted, and there is nothing to decline | —                                     |

**No per-repository progress, no repository name in the error, no GitHub status code** on this path.
The failure copy names the consequence in the user's terms — _"Your plan is safe in your backlog.
Nothing is lost — Motir will tell you if a task needs code that isn't ready yet"_ — which is the
honest hand-off to the code-blind signal MOTIR-1754 renders.

---

## 5. The technical path (panels 3–5) — behind "I already have code"

**Panel 3.** One short confirmation (_"Use your own GitHub instead"_), then the **shipped** connect
flow. Nothing on the default path sends a user to GitHub before they ask for it.

**Panel 4.** Once connected, repository vocabulary is theirs to read: one row per part the plan
needs, with a plain-language gloss beside each role chip (`web` · _The app people use_; `api` ·
_The service behind it_), the derivation's **"why"**, and reorder + a `⋯` menu at two or more rows.
One row drops the chip, the suffix, the grip and the menu, exactly as before.

### "Add a repository" vs "Use an existing repository" — the ambiguity, and the fix

In the first version these sat **side by side on one line**, which made them read as two ways of
doing the same thing. They are not, and the labels never said so. They now live at **different
levels**:

- **Per row** — a `Segmented` answers _where does THIS part live_: **Create for me** ·
  **Use one of mine**. Two mutually exclusive answers to one question, in the one control that
  means "pick one of these".
- **At set level** — **Add a repository** only ever means _the plan needs a part Motir didn't
  infer_. It changes **how many** rows there are, never where an existing row lives.

One asks _where_; the other asks _how many_. The old pairing asked both at once, in the same visual
weight, with no hint that one was per-row and one was per-set — which is exactly why it was
confusing.

**Panel 5 — the per-row states, on this path only.**

| State       | How it reads                                                                                                                                                                                 | Forward paths                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `creating`  | Per-row `Spinner` + **"Creating…"** + what it is doing, in `role="status"`. Siblings keep working.                                                                                           | resolves to `created` / `failed`                    |
| `created`   | `--el-success-surface` row · `CircleCheckBig` in `--el-success` + **"Created"** · the real `owner/name` as an external link                                                                  | (settled)                                           |
| `connected` | `--el-notice-info-bg` row · `Link` in `--el-info` + **"Connected"** · _"nothing was created and nothing was changed in it"_                                                                  | (settled)                                           |
| `skipped`   | Quiet `--el-surface-soft` row · `SkipForward` in `--el-icon-muted` + **"Skipped"** · what Motir will do about it                                                                             | **Create it after all** · **Use one of mine**       |
| `failed`    | `--el-danger-surface` row · `TriangleAlert` in `--el-danger` + **"Couldn't create"** · the REAL reason, in `role="alert"` · the name field re-opened with the suffixed suggestion (ADR §1.5) | **Retry** · **Use one of mine** · **Skip this one** |

**Rules the states obey**

- **Rows are independent** (ADR §4.2) — state lives on the row, so one spinner or failure never
  freezes or reverts a sibling. No set-level blocking overlay, and **no compensating delete**: a
  created repository is a real artifact in the user's account, and removing it to tidy a report is
  the worse answer.
- **No state is a dead end** — `failed` and `skipped` keep every recovery, now or on a later visit
  (§4.1, §4.4).
- **State is never colour alone** — always an icon **plus a word** (finding #35), with
  `--el-text-strong` / `--el-danger-surface-text` ink over every tint.
- **No dashed or dotted border signals state.** The planning canvas already owns dashed for
  proposed nodes and red-hatch for cross-story dependencies; a hardcoded border-style also breaks
  the `data-style` shape axis.
- **A state pill is NOT used on a tinted row.** `Pill severity="danger"` is `--el-tint-rose` and
  `--el-danger-surface` is the _same value_, so a danger pill on a failed row is invisible — same
  for mint/`created` and muted/`skipped`. The tint goes on the **row**; the state is named in text
  beside its icon (`.row-state`). Only the role chip stays a `Pill tone="neutral"`, which has its
  own border and reads on every tint.

**The PARTIAL outcome** (end of panel 5) — created + failed + skipped in one set, still completable
(§4.3): a `role="status"` summary counting the truth, the primary becoming **Finish setup**, and
nothing pretending the failed row succeeded.

---

## 6. Primitives — every element, and what it is

| Element                           | Primitive                                                | Notes                                                                            |
| --------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Step statement                    | `h2` `font-serif`                                        | 28px on the default path, 22px on the technical one                              |
| "Your project's code" overline    | `SectionLabel`                                           | mono · 11px · 0.06em · `--el-text-eyebrow`                                       |
| Primary action                    | `Button variant="primary"`                               | `Continue` · `Go to my backlog` · `Try again` · `Set up N repositories`          |
| Quiet secondary                   | a text button in `--el-link`                             | `I already have code` · `See where it lives` · `Let Motir host it`               |
| Default-path state line           | `Spinner` / lucide icon + text                           | `role="status"` while working, `role="alert"` on failure                         |
| **Per-row create-or-connect**     | **`Segmented`**                                          | the shipped `--el-tabnav-track` control; two options, one active                 |
| A row container (≥2 rows)         | `Card` (untinted, `data-surface="card"`)                 | `--radius-card` · `--el-border` · row padding, not `--spacing-card-padding`      |
| Repository name field             | `Input` (composing `FormField`)                          | `addonStart` carries the `owner /` prefix; `error` variant on a failed row       |
| Existing-repository picker        | `Combobox`                                               | over the repos the installation grants; "Grant more on GitHub" hands off to 7.10 |
| Role chip                         | `Pill tone="neutral"`                                    | mono; roles are metadata, not a status — no semantic tint is spent on them       |
| Reorder / menu trigger            | icon `Button` at `--height-control` + `--radius-control` | `ChevronUp` / `ChevronDown` / `Ellipsis`                                         |
| Row `⋯` menu                      | `Popover` + a menu list                                  | `--radius-card` container, `--radius-control` rows, `--el-option-active-bg`      |
| The "why" panel                   | a callout `div` (`--el-callout-bg`) + `Sparkles`         | mirrors the shipped AI-proposal callout; not a `Tooltip`                         |
| Row recoveries                    | `Button variant="secondary" size="sm"` + `ghost sm`      | Retry emphasized; the others quiet                                               |
| Rail (status · history · outcome) | **the shipped `PlanReviewRail`**                         | reused verbatim                                                                  |

**No new primitive is introduced.** If MOTIR-1782 finds it needs one, that is its own `design/`
subtask, not an improvisation.

---

## 7. Token roles — colour (`--el-*`) and shape

Every value in the mock's `:root` block was **generated** from `packages/design-system/theme.css`
(the Tier-0 `@theme` + Tier-3 `:root,[data-appearance-scope]` blocks), so no hex was retyped and the
asset cannot drift. The only raw values in the file are the mock **board's own** backdrop and the
canvas grid-dot texture — non-semantic decoration, per the colour rule's carve-out. **Dark mode
needs nothing extra:** every colour is an `--el-*` reference, so `theme.css`'s `[data-theme='dark']`
block re-skins the step.

| Element                                         | Token                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Step pane (behind the step)                     | `--el-canvas`                                                                   |
| Row container · rail card                       | `--el-card` · `--el-surface` / `--el-surface-soft`                              |
| Statement / body / helper ink                   | `--el-text` · `--el-text-secondary` · `--el-text-helper`                        |
| Overline                                        | `--el-text-eyebrow`                                                             |
| Field · combobox                                | `--el-page-bg` fill · `--el-input-border` · `--el-text-muted` prefix            |
| `Segmented` track · active option · active icon | `--el-tabnav-track` · `--el-page-bg` + `--shadow-subtle` · `--el-tabnav-active` |
| Primary action                                  | `--el-accent` / `--el-accent-text`                                              |
| Quiet secondaries and links                     | `--el-link`                                                                     |
| "ready" state icon · `created` row              | `--el-success` · `--el-success-surface`                                         |
| `connected` row · its icon                      | `--el-notice-info-bg` · `--el-info`                                             |
| failure icon · `failed` row · its ink           | `--el-danger` · `--el-danger-surface` · `--el-danger-surface-text`              |
| `skipped` row · its icon                        | `--el-surface-soft` · `--el-icon-muted`                                         |
| The "why" callout · its sparkle                 | `--el-callout-bg` · `--el-accent-on-surface`                                    |
| Role chip                                       | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                     |
| Rail status pill (Approved)                     | `--el-tint-mint` + `--el-text-strong` (the shipped `STATUS_TINT`)               |

| Surface                                             | Shape token                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| Buttons                                             | `--radius-btn` · `--height-btn-md` / `-sm` · `--spacing-btn-x`         |
| Row container · callouts · menu container · the box | `--radius-card`                                                        |
| Field · combobox trigger                            | `--radius-input` · `--height-input` · `--spacing-input-x`              |
| `Segmented` track · its options                     | `--radius-btn` · `calc(var(--radius-btn) - 2px)` · `--height-control`  |
| Role chip                                           | `--radius-badge` · `--spacing-chip-x` / `-y`                           |
| Icon buttons · menu rows                            | `--radius-control` · `--height-control` · `--spacing-control-x` / `-y` |
| Menu elevation · active segment                     | `--shadow-elevated` · `--shadow-subtle`                                |

**No Tier-0 `--color-*`, no generic `--radius-sm/md/lg`, no raw `rounded-md` / `p-2` / `h-9`, no
invented hue.** The default path is deliberately quiet (ink, accent, one state hue at a time); the
semantic spread — success, info, danger, warning, the lavender AI callout, the neutral chip — lives
on the technical path where there are states to tell apart, so neither screen is grey-and-purple
(finding #54) and neither is a fruit salad.

---

## 8. Copy — every string, as `en.json` keys

Namespace **`repositorySet`**. MOTIR-1782 adds these to `messages/en.json` **and**
`messages/zh.json` (the i18n-catalog parity test fails otherwise).

### The default path

| Key                 | String                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `overline`          | Your project's code                                                                                                                   |
| `title`             | Motir will host your code                                                                                                             |
| `lead`              | Your project's code lives with Motir, ready for your agents to start work. It's yours — move it to your own GitHub whenever you want. |
| `continueCta`       | Continue                                                                                                                              |
| `iHaveCode`         | I already have code                                                                                                                   |
| `working`           | Setting up your code…                                                                                                                 |
| `workingDetail`     | This takes a few seconds. Your plan is already in your backlog — you can leave this page.                                             |
| `ready`             | Your code is ready                                                                                                                    |
| `readyDetail`       | Motir keeps it safe and connected. It's yours — move it to your own GitHub whenever you want.                                         |
| `goToBacklog`       | Go to my backlog                                                                                                                      |
| `seeWhereItLives`   | See where it lives                                                                                                                    |
| `setupFailed`       | Motir couldn't finish setting up your code                                                                                            |
| `setupFailedDetail` | Your plan is safe in your backlog. Nothing is lost — Motir will tell you if a task needs code that isn't ready yet.                   |
| `tryAgain`          | Try again                                                                                                                             |
| `outcomeReady`      | Your code is ready _(the line added to the rail's outcome)_                                                                           |

### The technical path

| Key                   | String                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownTitle`            | Use your own GitHub instead                                                                                                                                     |
| `ownLead`             | Motir will connect to your account and use the repositories you choose. You pick which ones it may see, on GitHub — Motir never sees the rest.                  |
| `connectGithub`       | Connect GitHub                                                                                                                                                  |
| `letMotirHost`        | Let Motir host it                                                                                                                                               |
| `setTitle`            | Where should each part live?                                                                                                                                    |
| `setLead`             | Connected as {login}. Your plan separates the web app from the API, so Motir needs a home for each.                                                             |
| `roleGlossWeb`        | The app people use                                                                                                                                              |
| `roleGlossApi`        | The service behind it                                                                                                                                           |
| `createForMe`         | Create for me                                                                                                                                                   |
| `useOneOfMine`        | Use one of mine                                                                                                                                                 |
| `whereRoleLives`      | Where the {role} part lives _(the `Segmented` group's accessible name)_                                                                                         |
| `nameLabelForRole`    | Name of the {role} repository                                                                                                                                   |
| `nameLabelOne`        | Repository name                                                                                                                                                 |
| `pickerLabelForRole`  | Repository to use for the {role}                                                                                                                                |
| `pickerLabelOne`      | Repository to use                                                                                                                                               |
| `pickerHint`          | Only the repositories you granted Motir appear here.                                                                                                            |
| `grantMore`           | Grant more on GitHub                                                                                                                                            |
| `seedStarter`         | Seeded from the Motir Next.js starter.                                                                                                                          |
| `seedInitialised`     | Starts with a README, a licence, a `.gitignore` and a CI stub — your first task in it builds the skeleton.                                                      |
| `monorepoHint`        | Everything lives here. Motir won't create anything.                                                                                                             |
| `whyTrigger`          | Why this repository?                                                                                                                                            |
| `whyApi`              | {n} of the {total} items you approved build a backend service, so Motir asked for a separate home for it. Remove this row to keep everything in one repository. |
| `addRow`              | Add a repository                                                                                                                                                |
| `rowActions`          | Repository actions                                                                                                                                              |
| `moveUp` / `moveDown` | Move up / Move down                                                                                                                                             |
| `removeRow`           | Remove                                                                                                                                                          |
| `skipRow`             | Skip this one                                                                                                                                                   |
| `setUpMany`           | Set up {n} repositories                                                                                                                                         |
| `notNow`              | Not now                                                                                                                                                         |
| `setupNote`           | The first row is your project's main repository. Nothing is created until you press Set up.                                                                     |
| `stateCreating`       | Creating…                                                                                                                                                       |
| `stateCreatingDetail` | Adding it to the Motir GitHub App                                                                                                                               |
| `stateCreated`        | Created                                                                                                                                                         |
| `createdDetail`       | Seeded from the Motir Next.js starter · connected to Motir.                                                                                                     |
| `stateConnected`      | Connected                                                                                                                                                       |
| `connectedDetail`     | Your existing repository — nothing was created and nothing was changed in it.                                                                                   |
| `stateSkipped`        | Skipped                                                                                                                                                         |
| `skippedTitle`        | No repository for the {roleLabel}                                                                                                                               |
| `skippedDetail`       | Motir will plan around it, and say so when a task needs code that isn't there.                                                                                  |
| `createAfterAll`      | Create it after all                                                                                                                                             |
| `stateFailed`         | Couldn't create                                                                                                                                                 |
| `failedNameTaken`     | {login} already has a repository called {name}. Rename this one, or use the existing repository instead.                                                        |
| `failedLimit`         | GitHub declined the request — {login} has hit its repository limit. Nothing was created for this row.                                                           |
| `retryRow`            | Retry                                                                                                                                                           |
| `summaryPartial`      | {created} created · {skipped} skipped · {unresolved} needs a decision                                                                                           |
| `finishSetup`         | Finish setup                                                                                                                                                    |
| `finishHint`          | Your plan is already in the backlog. Motir will tell you which tasks are waiting on a repository.                                                               |
| `finishSetupLink`     | Finish setting up repositories                                                                                                                                  |

### Accessible names — the superstring audit

A new control's accessible name must not **contain** an existing one, or `getByRole` starts matching
two things (the superstring-label class). Checked against `messages/en.json`:

- **`Use one of mine`** was chosen over "Connect existing", which would have contained the exact
  existing name **"Connect"** (`import.steps.connect`, `gitlab.projects.connectAction`,
  `onboardingMigrate.rail.connect`). It also reads better beside **Create for me**.
- **`Not now`** was chosen over "Skip for now", which would have contained **"SKIP"**
  (`import.preview.actionSkip`) _and_ collided with this surface's own **Skip this one**.
- **`Continue`** duplicates `auth.continue` **exactly**, and **`Retry`** / **`Remove`** duplicate
  `dashboards.states.retry` / `settings.members.remove` exactly. Exact duplicates on other surfaces
  are fine and already the norm — only containment breaks a selector.
- **`Connect GitHub`** is the **same** name as the shipped Git-settings button, deliberately: it is
  the same action, and the E2E should be able to reach either by the same name.
- **Within this surface**, no name contains another. Note for MOTIR-1785: **`I already have code`**
  appears on both the default step and the failure state, so scope that locator to the state under
  test rather than the page.

---

## 9. a11y

- **Every state carries text**, not colour alone (finding #35); tinted rows hold
  `--el-text-strong` / `--el-danger-surface-text` ink so AA holds in both themes.
- **`role="status"`** on the default path's _Setting up your code…_ and on the partial summary;
  **`role="alert"`** on the default path's failure sentence and on each failed row's reason — the
  row that failed announces itself, not the whole step.
- **The `Segmented` is a labelled group** (_Where the web part lives_), so the two options are not
  two orphan buttons to a screen reader.
- **The reorder affordance is keyboard-operable** — the grip is decorative (`aria-hidden`) and the
  real controls are **Move up** / **Move down**; drag is an enhancement, never the only path.
- **Every field has a real label** — visible at one row (**Repository name**), visually hidden but
  role-specific at ≥2 (**Name of the web repository**), so rows stay distinguishable to a screen
  reader even though the visible label is the role chip.
- **The `⋯` menu is a `Popover`** whose trigger is named **Repository actions** — a menu with a
  door, and never portaled to `document.body` (that breaks it inside Radix).
- **Long names must not blow out the row.** Every flex column carries `min-width: 0` and the full
  `owner/name` truncates — this repo's recurring horizontal-overflow class is a missing `min-w-0`.

---

## 10. Page state after the step's mutations (the enforced contract)

Setting up code changes three surfaces, and they do **not** all refresh the same way
(`motir-core/CLAUDE.md`):

1. **The step's own state line / row** — the response IS the confirmation. Keep the returned state;
   do **not** `router.refresh()` it (the refresh re-reads and causes a visible revert).
2. **The rail's outcome card** (server-rendered from the plan review read) — `router.refresh()`
   reaches it, which is how **"Your code is ready"** / **"Finish setting up repositories"** appears.
3. **Any client island seeded from server props** — the code-context surface and any nav badge own
   their own state; `router.refresh()` cannot reach them, so they need an explicit refetch trigger
   (a provider tick). MOTIR-1782 does the ones that exist and leaves the rest to MOTIR-1764.

---

## 11. Explicitly OUT of scope here (so nothing is built twice)

- **The plan-approval surface, the canvas, the review rail** — shipped (MOTIR-847 / 1193 / 1194).
  Composed, not redrawn.
- **The GitHub connect / install screens** — 7.10. Only the hand-off is drawn.
- **The code-context / index-freshness surface, and the code-blind planning signal** — MOTIR-1764
  (Story MOTIR-1754). Pointed at as the durable home of the set; none of it drawn.
- **The claim / transfer flow** — MOTIR-711 (9.3.7). Only the claimable promise is worded.
- **The repo-set table, the derivation service, the creation primitive** — MOTIR-1780 / 1881 / 1781.
  Behaviour is quoted; no schema or service is designed here.
- **The multi-stack scaffold registry** — MOTIR-709 (9.3.5). The notes say honestly that a non-web
  repo starts near-empty until then, rather than implying a scaffold that does not exist.
