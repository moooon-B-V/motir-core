# Design notes — AI planning project settings (`design/ai-settings/`)

**Story:** MOTIR-813 · _Cadence — auto-planning + AI sprint planning_ (Epic 7).
**Subtask:** MOTIR-914 (7.13.1) — the design gate for MOTIR-919 (7.13.6), which implements this
asset verbatim.
**Amended by:** MOTIR-1739 (7.13.9) — **panel 6, the auto-plan PAUSED state** (§8 state 7), the
design gate for MOTIR-1740 (7.13.10). The amendment adds one state to the Auto-plan card and
nothing else: panels 0–5, every other panel, primitive, copy string and token role below are
MOTIR-914's, unchanged.

| File                             | What it is                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `ai-planning-settings.mock.html` | The asset SOURCE — seven panels, built from the real design system. Layout source of truth. |
| `ai-planning-settings.png`       | Full-page export (light, `deviceScaleFactor: 2`, viewport 1200) — the reviewable face.      |
| `design-notes.md`                | This spec: placement, primitives, copy, token roles, states, a11y.                          |

The surface: **where a project is configured for cadence** — when Motir expands the plan, how it
packs sprints, whether it drafts a "why" for each item, and which model does the drafting.

---

## 1. Placement — its OWN page in the settings area (a correction to the card's prose)

**The card says:** _"Render it among the existing project-settings rows (where `workflowPolicyMode` /
`estimationStatistic` / `pointScale` already live) — NOT a standalone page."_

**Shipped reality says otherwise, and shipped reality wins** (the design-against-shipped-reality
rule: never invent a layout the app does not have). Verified on `origin/main`:

- `lib/settings/projectSettingsNav.ts` — project settings is a **registry-driven AREA**: a typed
  entry per **page**, grouped `general · access · work · automation`, rendered as the settings rail
  and as `⌘K` deep links from the same registry.
- Those three fields do **not** share a page of rows: `workflowPolicyMode` →
  `/settings/project/workflow`; `estimationStatistic` + `pointScale` →
  `/settings/project/estimation`. **One concern, one page** is the shipped idiom.
- `tests/settings/projectSettingsNav.test.ts` enforces a **totality** pairing: every
  `settings/project/**/page.tsx` has exactly one registry entry and vice versa.

So "one more settings section, not a bolt-on" — the card's actual intent — is expressed in this app
as **a new registry entry + its own route**, not as a row bolted into another concern's page:

```ts
{
  id: 'ai-planning',
  group: 'automation',
  href: '/settings/project/ai-planning',
  icon: Sparkles,                 // lucide; the AI glyph, distinct from Rules' Bot
  labelKey: 'nav.aiPlanning',
  access: browse,                 // every member SEES it; a non-admin gets read-only (§8)
}
```

Placed **above `Rules`** in the Automation group: cadence configures the automatic planner, the same
family as automation rules, and it reads as the AI sibling of that group rather than a fourth "Work"
concern. Registering the entry lights **both doors at once** (rail row + `⌘K` `settings-ai-planning`)
and keeps the totality test green — which a row inside another page would not.

> **MOTIR-919 must apply this correction too**: build the page + the registry entry, not a row inside
> Estimation/Workflow. (MOTIR-919's description repeats the card's original phrasing; the planner has
> been asked to amend it.)

## 2. The access path (panel 0 — the door, drawn)

1. **Settings rail** → group **Automation** → **AI planning** (`Sparkles`), `aria-current="page"`
   when active, standard `SidebarNavItem` treatment: `--el-sidebar-item-bg-active` fill, a hairline
   `--el-sidebar-border`, `--shadow-subtle`, and the glyph in `--el-icon-active`.
2. **Command palette** (`⌘K`) → "AI planning", labelled `Project settings` — free, from the registry.

There is no third entrance. Nothing on any other surface links here in this Story; if a later Story
wants a "configure cadence" shortcut from a plan/roadmap surface, that is its own design.
The rail row carries **no badge** — no "New"/"Soon" chip. It is an ordinary nav entry from the day it
ships, exactly like its siblings.

## 3. Page shell — copied from the shipped settings pages

Mirrors `app/(authed)/settings/project/estimation/page.tsx` exactly:

- Container `mx-auto flex max-w-[42rem] flex-col gap-6` — **672 px, centred**.
- `<header>`: `<h1>` `font-serif text-3xl font-semibold text-(--el-text)` + `<p>`
  `text-sm text-(--el-text-muted)`.
- **No breadcrumb.** (`design/estimation/estimation-settings.mock.html` drew a `Project settings ·
motir` crumb; the shipped page has none. This asset drops it — follow the code, not the older mock.)
- Then the card stack, `gap-5`/`gap-6`.

## 4. Three cards, one footer

Three `Card`s — **auto-plan · AI sprint planning · planner** — because they are three decisions with
different blast radius, and a project may want one without the others. The **Save/Cancel footer
appears once, on the last card, and governs the whole page's dirty state**, exactly as
`EstimationSettingsEditor` ships it (`--el-surface-soft` footer, right-aligned, admin-only).

Save is **optimistic-with-reconcile + toast** (the shipped pattern): the committed snapshot flips
immediately, reverts and error-toasts on failure. It is a `PATCH` to a settings route → the project
settings service → the MOTIR-915 repository methods; the client never touches the service directly.

| Card               | Controls                            | Backing column (MOTIR-915)                                                                           |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Auto-plan          | switch · threshold stepper          | `aiAutoPlanEnabled` · `aiAutoPlanThreshold`                                                          |
| AI sprint planning | switch · sprint-length stepper      | `aiSprintPlanningEnabled` · `aiSprintLengthDays`                                                     |
| Planner            | explanation switch · model combobox | `aiGenerateExplanations` (Story 7.4 / MOTIR-850 — **surfaced, never duplicated**) · `aiPlannerModel` |

`Project.aiGenerateExplanations` has shipped since MOTIR-850 with **no UI anywhere** (it reaches
`aiGenerationService` through the projects DTO). This panel is its first and only control surface.

## 5. Primitives composed — the no-hand-rolling checklist

| Element                           | Primitive                                                | Notes                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card head / body / footer         | `Card` (`components/ui/Card`)                            | head + `--el-border-soft` divider + `--el-surface-soft` footer, as Estimation composes it                                                                                                                                                                                                                   |
| Enable toggles (×3)               | **`Switch`** (`Switch.tsx`)                              | `role="switch"`, `h-5 w-9`, `--el-switch-on` track + `--el-switch-knob` thumb, `rounded-full` (the sanctioned circular carve-out)                                                                                                                                                                           |
| Threshold / sprint length         | **stepper = `Input type="number"` + two icon `Button`s** | **A COMPOSITION of shipped primitives, not a new primitive.** `−` / `+` are `--height-control` square icon buttons (`--radius-control`, `--el-button-border`); the field is `--height-control` × 74 px, `--radius-input`, `--el-input-border`, mono numerals. Each button disables at its end of the range. |
| Planner model                     | **`Combobox`** (`Combobox.tsx`, `searchable={false}`)    | trigger = label + secondary text + `ChevronsUpDown`; panel = `role="listbox"` of `role="option"` rows with a `Check` on the selected one (`--el-option-active-bg` highlight, `--el-accent-on-surface` check)                                                                                                |
| Field label + hint                | `FormField` grammar                                      | label `text-sm font-medium text-(--el-text)`, hint `text-xs text-(--el-text-helper)`, linked by `aria-describedby`                                                                                                                                                                                          |
| Save / Cancel                     | `Button` `primary` / `secondary`                         | `--height-btn-md`, `--radius-btn`                                                                                                                                                                                                                                                                           |
| Save confirmation                 | `Toast` (`success`)                                      | title + description                                                                                                                                                                                                                                                                                         |
| Validation message                | inline `<p role="alert">`                                | `text-xs text-(--el-danger)` + `AlertCircle` — the shipped `CustomScaleEditor` treatment                                                                                                                                                                                                                    |
| Read-only / not-connected banners | the Estimation lock-banner shape                         | `--el-surface` (lock) / `--el-tint-peach` (gate) inside the card body                                                                                                                                                                                                                                       |
| Guardrail / rationale callouts    | same banner shape, tinted                                | `--el-tint-sky` (guardrail) · `--el-tint-lavender` (rationale)                                                                                                                                                                                                                                              |
| **Paused status banner** (1739)   | the SAME callout box, in the **gate** role               | Not a new primitive and not a new tint: `--el-tint-peach` + `--el-warning`, the role this asset already gives "the setting is on, but the feature is not running — here is why". Adds a stacked text column + a meta line (§8.7).                                                                           |
| **Out-of-date badge** (1739)      | the SHIPPED stale badge, reused verbatim                 | From `components/planning/PlanItemNode.tsx`: `--el-tint-yellow` fill, `--el-text-strong` text, `TriangleAlert`, `--radius-badge`, `--spacing-chip-x/y`. ONE addition — a `--el-border-soft` hairline, so it still reads sitting ON the peach banner rather than on the card.                                |
| Rail row                          | `SidebarNavItem` via the nav registry                    | no bespoke nav markup                                                                                                                                                                                                                                                                                       |

**No new primitive is required.** If the implementer finds one is, that is a new `design/` subtask —
not a hand-rolled control in the settings page.

## 6. Copy — the exact strings

Page:

- Title: **AI planning**
- Description: **How Motir's planner keeps this project moving — when it expands the plan, how it
  packs sprints, and which model drafts the work.**

Card 1 — Auto-plan:

- Card title **Auto-plan** · sub **Expand the plan automatically when ready work runs low.**
- Switch label **Expand the plan automatically**
  hint **When ready work drains, Motir drafts the next slice of the plan for you to review.**
- Stepper label **Ready-work threshold**
  hint **Motir starts drafting when fewer than this many work items are ready to start.**
  unit suffix **ready items**
- **Guardrail (Principle #1, shown when the switch is on):**
  **Auto-plan _proposes_ an expansion for your approval — it never creates work without you.**
- Validation: **Enter 1 or more ready items.**

Card 1 — Auto-plan, **paused** (MOTIR-1739 · shown only when the switch is ON and a plan is
undecided):

- Banner lead **Auto-plan is paused — a plan is waiting for your review.**
  body **Motir drafts one plan at a time. It picks up again as soon as you approve or decline this
  one.**
- Meta line **Planned {when}** · **{n} proposed items** — the same phrasing the shipped Plans list
  uses (`aiPlanning.plannedAt` / `aiPlanning.itemCount`), so both surfaces describe a plan the same
  way.
- Link **Review the plan** (→ `/plans/{id}`)
- The out-of-date face adds: badge **Out of date** (the shipped `planReview.staleBadge` string) +
  **Your project has changed since this plan was drafted — {n} items may be out of date.**

No implementation noun appears in any of it — no `Plan.status`, no "cadence", no "cron", no
"stale". A reader learns both what stopped and what to do about it: a plan is waiting, go review it.

Card 2 — AI sprint planning:

- Card title **AI sprint planning** · sub **Pack ready work into short sprints that respect what
  blocks what.**
- Switch label **Plan sprints with Motir**
  hint **Motir proposes the next sprints from ready work; you approve before any sprint is created.**
- Stepper label **Sprint length**
  hint **Sized for agent throughput, not human sprints. Widen it if your team works at human pace.**
  unit suffix **days**
- **Short-sprint rationale (shown when the switch is on):**
  **An agent finishes a work item in minutes, so a two-week sprint hides a whole plan inside one
  bucket. Short sprints keep plan → build → review a loop you can actually watch.**
- Validation: **Choose a sprint length between 1 and 14 days.**

Card 3 — Planner:

- Card title **Planner** · sub **The model that drafts plans, sprints and explanations for this
  project.**
- Switch label **Draft a why for each item**
  hint **Every proposed work item gets a short "why this matters" you can read without opening the
  code.**
- Combobox label **Planner model**
  hint **Leave this on Default unless you have a reason to pin one. Usage is billed to this
  workspace either way.**

Footer / states:

- **Cancel** · **Save changes** · dirty hint **Unsaved changes** · invalid hint **Fix the highlighted
  fields to save**
- Toast **AI planning settings saved** / **Cadence updated for {project}.**
- Read-only banner **Only a project admin can change AI planning settings.**
- Not-connected banner **Motir AI isn't connected.** **AI planning runs on Motir's cloud service.
  These settings are saved but stay inactive until this deployment is connected to Motir AI.**

**Voice rules applied:** "work item", never "issue"/"ticket"; "Motir"/"agent", never "the AI" or
"coding agent"; no dev jargon in a label (the model id appears only as secondary text). The
guardrail sentence is Principle #1 restated in the user's words, not a policy citation.

## 7. Planner-model options — the real shipped set

From motir-ai `src/llm/gatewayClient.ts`:
`PLANNER_MODELS = { default: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }`, chosen today by the
`PLANNER_MODEL` env. So the picker offers **exactly three** rows — human label leading, model id as
secondary mono text (the shipped `Combobox` label+secondary shape):

| Label        | Secondary           | Writes                                                             |
| ------------ | ------------------- | ------------------------------------------------------------------ |
| **Default**  | `recommended`       | `aiPlannerModel = null` → follows the deployment's `PLANNER_MODEL` |
| **Thorough** | `deepseek-v4-pro`   | pins the capable channel                                           |
| **Fast**     | `deepseek-v4-flash` | pins the light channel                                             |

Adding a model later is one more option row — no layout change. **Do not invent model names**; take
the set from `PLANNER_MODELS` at implementation time.

## 8. States (panels 1 · 2 · 4 · 5 · 6)

1. **Default / off.** Every AI setting ships off or at its default, so an existing project is
   untouched until someone opts in. A dependent control is **present but disabled**, never hidden —
   the reader sees what the switch will unlock (the Linear cycle-settings shape). The disabled
   dependent keeps its layout; only its opacity + text tokens drop (`--el-text-faint`). — faint is correct here: a disabled dependent, which WCAG 1.4.3 exempts.
2. **Configured.** Parent on → dependent live **and that group's explanatory callout appears**. The
   callouts render only when the setting is live, so the default view stays quiet.
3. **Validation.** `threshold ≥ 1`; `sprintLengthDays` within 1–14. The stepper's `−`/`+` disables at
   each end, so the ordinary path cannot produce an invalid value; the error state exists for typed
   input. Message under the control, `role="alert"`, `--el-danger`; the input takes a `--el-danger`
   border. **Save disabled while any field is invalid.** The client mirrors — never replaces — the
   MOTIR-915 server validation; a typed server rejection surfaces in the same slot.
4. **Saved.** Footer returns to not-dirty + success `Toast`.
5. **Non-admin (read-only).** Page is visible to every member (`access: browse`); the lock banner
   renders and every control is disabled, matching the shipped Estimation panel. The write is
   re-gated server-side — `isAdmin` only governs whether the edit affordances render.
6. **Motir AI not connected.** Driven by the shipped `isMotirAiConfigured()` probe
   (`lib/ai/availability.ts` — `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN`). Controls grey out with a
   stated reason instead of offering switches that would do nothing. **Deliberately NO "Connect"
   button**: there is no in-app provisioning flow in the shipped app, and inventing one would be a
   route that does not exist. The banner renders on all three cards.
7. **Auto-plan PAUSED — a plan is waiting for a decision (panel 6 · MOTIR-1739).** Auto-plan is ON
   and configured, but MOTIR-916's watcher SKIPS the project because a plan is still undecided
   (`generating` / `planned`), and nothing expires a plan — `plansService.declinePlan` is an
   explicit human act. Without a signal that silence is indistinguishable from a broken feature, so
   the state is **surfaced, never aged out** (the 2026-07-27 decision; auto-declining would silently
   discard work someone may still want).
   - **Where.** A status banner at the TOP of the Auto-plan card body — the same slot the lock and
     not-connected banners use — above the switch row. It is the SAME `.callout` box as the
     Principle-#1 guardrail, in the **gate** role (§9); no new banner primitive.
   - **The way out.** The banner carries a **link to the waiting plan** (`/plans/{id}`, the shipped
     MOTIR-847 detail). This is the point of the state: it makes the silence actionable, not merely
     explained. Today that plan is otherwise reachable only from the Plans list.
   - **Two faces, both drawn.** _Pending-and-current_ — lead + body + meta (planned-when · item
     count) + link. _Pending-and-STALE_ — the same, plus the **Out of date** badge and the drift
     sentence, because a drifted plan is where "go decide this" is most urgent. Staleness is the
     rolled-up verdict of the shipped `planStalenessService` (MOTIR-1340); the banner shows the
     count, never the per-item reason list (that lives on the plan detail).
   - **Pausing is NOT disabling.** The enable switch and the threshold stepper stay fully
     interactive, and Save works normally — the user can reconfigure while a plan waits. (Contrast
     panel 5, where a non-admin's controls really are `disabled`.) The guardrail callout stays too:
     it renders whenever the switch is on, paused or not.
   - **When it does NOT render.** Auto-plan off, or no undecided plan → the card is exactly as
     MOTIR-919 ships it (panel 6's left-hand card, identical to panel 2). Nothing is hidden or moved
     to make room for the banner.

## 9. Colour + shape token roles (per element)

Colour — `--el-*` only; **no Tier-0 `--color-*` in component code, no invented hue** anywhere:

| Element                                            | Token                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Page title · control labels                        | `--el-text`                                                                                              |
| Page description · card sub · field hints          | `--el-text-muted` / `--el-text-helper`                                                                   |
| Disabled dependent label + hint                    | `--el-text-faint`                                                                                        |
| Card surface · page background                     | `--el-card` / `--el-page-bg`                                                                             |
| Card border · inner dividers                       | `--el-border` / `--el-border-soft`                                                                       |
| Card footer band                                   | `--el-surface-soft`                                                                                      |
| Switch track ON · knob · track OFF                 | `--el-switch-on` · `--el-switch-knob` · `--el-muted` + `--el-border-strong`                              |
| Stepper input border · icon-button border          | `--el-input-border` · `--el-button-border`                                                               |
| Combobox trigger border · chevron · secondary text | `--el-input-border` · `--el-icon-field` · `--el-text-identifier`                                         |
| Combobox option highlight · selected check         | `--el-option-active-bg` · `--el-accent-on-surface`                                                       |
| Primary button fill / its text                     | `--el-accent` / `--el-accent-text`                                                                       |
| Secondary button                                   | `--el-page-bg` + `--el-button-border` + `--el-text-secondary`                                            |
| **Guardrail callout** (approval promise)           | `--el-tint-sky` bg + `--el-text-strong` + `--el-info` icon                                               |
| **Rationale callout** (short sprints)              | `--el-tint-lavender` bg + `--el-text-strong` + `--el-accent-on-surface` icon                             |
| **Not-connected callout**                          | `--el-tint-peach` bg + `--el-text-strong` + `--el-warning` icon                                          |
| **Paused callout** (1739)                          | `--el-tint-peach` bg + `--el-text-strong` + `--el-warning` `PauseCircle`                                 |
| **Paused callout's link** (1739)                   | `--el-text-strong` + underline (NOT `--el-link`) + `--el-warning` `ArrowRight`                           |
| **Out-of-date badge** (1739)                       | `--el-tint-yellow` bg + `--el-text-strong` + `--el-warning` `TriangleAlert`, `--el-border-soft` hairline |
| Read-only lock banner                              | `--el-surface` + `--el-border` + `--el-icon-muted` icon                                                  |
| Validation text + invalid border                   | `--el-danger`                                                                                            |
| Saved toast icon                                   | `--el-success`                                                                                           |
| Card-head glyphs                                   | `--el-icon-heading`                                                                                      |
| Rail active row · its icon                         | `--el-sidebar-item-bg-active` + `--el-sidebar-border` · `--el-icon-active`                               |
| Focus ring                                         | `--focus-ring-color`                                                                                     |

Three tinted callouts use **three distinct tint slots** so they never read as the same message; text
on every tint is `--el-text-strong` (AA, finding #35). No page-level surface is tinted.

**The paused banner (1739) REUSES the gate/peach role rather than claiming a fourth tint** — a
deliberate choice, recorded here so it is not read as a collision. Peach already means _"the
setting is on, but the feature is not running — here is why"_; paused is that same message with a
different cause, and the two cannot co-occur (a deployment with no Motir AI connection can have no
undecided plan). The two are told apart by their glyph and their first sentence, not by hue. The
**link inside a tinted callout takes `--el-text-strong` + an underline, never `--el-link`**:
`--el-link` on `--el-tint-peach` is 4.13:1, under AA (finding #35). The **Out of date** badge keeps
its own shipped `--el-tint-yellow`, which is what the app already uses for drift everywhere else.

Shape — element-semantic tokens only (`data-style` swaps them; never `rounded-md`/`p-2`/`h-9`):

`--radius-card` (cards, callouts, combobox panel) · `--radius-input` (stepper field, combobox
trigger) · `--radius-control` (icon buttons, listbox rows, rail rows, chips) · `--radius-btn`
(buttons) · `--radius-badge` (chips) · `--spacing-card-padding` · `--spacing-control-x/y` ·
`--spacing-btn-x/y` · `--spacing-chip-x/y` · `--height-control` · `--height-btn-md` ·
`--height-input` · `--shadow-card` / `--shadow-subtle` / `--shadow-elevated`.
`rounded-full` on the Switch track/knob is the sanctioned circular carve-out.

> The card's acceptance criteria name `[data-display-style]`; the shipped attribute is **`data-style`**
> (`packages/design-system/src/theme/{styles,init-script}.ts`). Same axis, current name.

## 10. A11y

- Every `Switch` gets its visible label by reference (`aria-labelledby`, not a duplicated
  `aria-label`), so the accessible name can't drift from the text on screen.
- Steppers: the number input carries `aria-label` (e.g. "Ready-work threshold"), the `−`/`+` buttons
  carry `aria-label`s ("Decrease threshold" / "Increase threshold"), and `aria-describedby` links the
  hint **and** the error message. `aria-invalid` on the field while invalid.
- Combobox: the shipped primitive's ARIA (combobox → listbox/option, `aria-activedescendant`) is
  used as-is; the trigger is labelled by the visible "Planner model" label.
- A disabled dependent control is `disabled` (focus-skipped), not `aria-hidden` — it stays legible to
  a screen reader as an unavailable option, matching what a sighted user sees.
- Validation messages are `role="alert"` so they announce on appearance.
- Keyboard: rail → page → each card top-to-bottom; no focus trap; the combobox returns focus to its
  trigger on close.
- The paused banner (1739) is a `role="status"` region, so the state is announced when it appears
  after a save or a refresh without stealing focus. Its meaning is carried by the sentence and the
  `PauseCircle` glyph — **never by the peach fill alone**; the same holds for the **Out of date**
  badge, whose word IS the signal (the `TriangleAlert` is `aria-hidden`, decorative). The link is a
  real `<a>` whose accessible name ("Review the plan") says where it goes; the `·` separators in the
  meta line are `aria-hidden`. The switch and stepper are NOT `aria-disabled` while paused — they
  really are operable, and the a11y tree must say so.

## 11. i18n

Keys land under the existing **`settings`** namespace as `settings.aiPlanning.*` — the shipped
convention for every settings page (`settings.estimation.*`, `settings.nav.*`), plus
`settings.nav.aiPlanning` for the rail label.

> MOTIR-919's description asks for a new top-level `aiSettings` namespace. Prefer
> `settings.aiPlanning.*`: it matches every sibling settings page, keeps the rail label beside the
> other `nav.*` keys, and avoids a namespace that exists for one page. Every new `en.json` key needs
> its `zh.json` counterpart in the SAME PR (the i18n-catalog parity gate).

The paused state (1739) adds `settings.aiPlanning.paused.*` — `lead`, `body`, `reviewCta`,
`staleBody` — plus the two strings it REUSES rather than re-authors: `planReview.staleBadge` ("Out
of date") and `aiPlanning.plannedAt` / `aiPlanning.itemCount` for the meta line. Re-authoring those
would let the settings page and the Plans list drift apart in wording for the same fact.

## 12. Out of scope for this asset

- The **plan-review surface** a cadence-fired proposal lands in — that is Story 7.4's, already
  designed; this page only decides _when_ a proposal is drafted.
- The **sprint-proposal review** UI (MOTIR-918's persist flow) — its own surface, not a settings pane.
- Usage / spend for the chosen model — `design/ai-usage/` owns that; the hint here only points at
  where billing lands.
- Workspace- or org-level AI settings — every control here is **project-scoped**, matching the
  MOTIR-915 columns on `Project`.
- **Expiry / auto-decline of a waiting plan** — explicitly NOT designed (MOTIR-1739). The decision
  was to SURFACE the pause, not age it out; aging it out would discard proposals a human may still
  want. If expiry is ever wanted, it is its own decision card and its own design.
- The **plan detail** the paused banner links to — shipped (MOTIR-847); this asset only draws the
  door to it.

---

# Amendment — THE LESSON LIBRARY (Story MOTIR-3329 · Subtask MOTIR-3332)

**Asset:** `ai-planning-lessons.mock.html` + `ai-planning-lessons.png` (this file is the area's one
notes file; §§1–12 above are MOTIR-914/1739's and are unchanged by this amendment).
**Implements:** MOTIR-3338 (the list, the detail, the empty state, the door). MOTIR-3330 builds the
retire action whose two states §L6 draws; MOTIR-3331 owns the recording switch §L5 points at.

| File                            | What it is                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `ai-planning-lessons.mock.html` | The asset SOURCE — seven panels. Layout source of truth for MOTIR-3338.                |
| `ai-planning-lessons.png`       | Full-page export (light, `deviceScaleFactor: 2`, viewport 1200) — the reviewable face. |
| `design-notes.md` §§L1–L12      | This spec.                                                                             |

The surface: **what this project taught its planner** — the corrections Motir distilled from its own
planning work here and applies to every plan it drafts for this project afterwards.

## L1. Drawn against a RENDER, not against a reading of the code

The shipped AI-planning settings page was **rendered and screenshotted before anything was drawn** —
the real `AiPlanningSettingsEditor` bundled with the real `packages/design-system/theme.css`,
screenshotted headless at 1200×2 (the can-render-UI-headless technique). Everything in the new asset
composes what that render actually shows: the 672 px centred column, the serif page head, the
`SettingsCard` grammar (icon + title + `hsub`, hairline divider, body), the `SwitchRow`, the
`--el-surface-soft` footer with Cancel + Save.

**The new asset's stylesheet IS MOTIR-914's**, reused byte-for-byte with only new layout rules
appended. Two assets describing the same page cannot then describe it differently, and no token
value was re-copied out of `theme.css` a second time (the re-copy is where a drift would enter).

## L2. Placement — a fourth CARD as the door, and a DRILL-DOWN for the library

Three placements were possible and the choice is load-bearing, so it is recorded rather than implied:

| option                                        | verdict                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The whole list inline, as a fourth card       | ✗ The library is **paged and unbounded** (`ADMIN_PAGE_DEFAULT = 50`). A settings page with a Save/Cancel footer is not a place to page through a list. |
| Its own rail row under Automation             | ✗ It would compete with the settings it belongs to, and read as a second AI concern rather than as the planner's memory.                               |
| **A door card + a nested route** — **chosen** | ✓ The reader meets it where they already are; the library gets a page that can be as long as it needs. And it is the **shipped idiom**, not a new one. |

The shipped idiom is `SettingsNavEntry.nestedRoutes` — a **DRILL-DOWN**, added in MOTIR-2263 for
`roles/[roleKey]`: a route reached from its parent's rail row, which **gets no rail row of its own
and still lights one**. `tests/settings/projectSettingsNav.test.ts` already enforces all three of its
properties (a nested route is a strict sub-path of its owner; it never becomes a rail row or a
palette action; it still lights its parent's row). So:

```ts
{
  id: 'ai-planning',
  group: 'automation',
  href: '/settings/project/ai-planning',
  nestedRoutes: [
    '/settings/project/ai-planning/lessons',
    '/settings/project/ai-planning/lessons/[lessonId]',
  ],
  …
}
```

The route↔registry totality test stays green with no weakening, and no new rail row appears.

## L3. The access path — DRAWN (panel 0)

1. **Settings rail** → **Automation** → **AI planning** (unchanged; the row stays `active` on every
   nested route, which is what `nestedRoutes` buys).
2. On that page, a **fourth card — “What Motir has learned”** — below `Planner`. It shows the three
   most recent takeaways and **“View all N lessons →”**. A preview, not the list.
3. The link opens `/settings/project/ai-planning/lessons`; a row opens
   `/settings/project/ai-planning/lessons/[lessonId]`. Both carry a back link to their parent.

**⚠️ The Save/Cancel footer stays on the `Planner` card.** §4 above says the footer “appears once, on
the last card, and governs the whole page's dirty state”. The lessons card is **read-only**, so that
sentence is refined to **the last EDITABLE card** — which is the same card today, so nothing moves.
A Save button rendered beneath a list would appear to govern the list.

**⚠️ The card renders only for an actor holding `lesson:view`** (MOTIR-3336). A non-admin does not
see the door — which is what MOTIR-3340's non-admin walk asserts. Hiding is presentation and never
protection: the destination is guarded server-side too (`guardSettingsPage`, and the seam's own
assert in MOTIR-3337).

## L4. What a ROW shows, and why (panels 1–2)

| element                    | why it is on the row                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the **takeaway** (`title`) | The only one of the four text fields on the row. The reader's question here is _do I want to open this_, not _what does it say_. Never truncated with an ellipsis — a half-sentence rule is worse than a long one. |
| **Last seen `<when>`**     | `lastOccurredAt`, as prose. Answers _is this still live_.                                                                                                                                                          |
| **seen `<n>` times**       | `recurrenceCount`, as prose. Answers _how settled is this_ — four times is a pattern, once is an observation. The two numbers are deliberately BOTH shown: they answer different questions.                        |
| the **axes chips**         | `kinds` / `types` / `phases`, each chip carrying its axis NAME (“kind story”), because `story` alone reads as a status. An EMPTY axis is not drawn.                                                                |
| **Applies to every card**  | The chip a lesson with NO axes shows — empty means _unconstrained_ upstream, and three missing chips would read as missing data rather than as universal scope.                                                    |
| the **retire affordance**  | On hover and on focus. A labelled `Button`, never a bare icon: an unlabelled ban glyph beside a rule reads as “this rule is broken”.                                                                               |

Row order is `lastOccurredAt` descending — most recently relevant first, which is what the API
returns. The one filter is the `All · Applied · Not applied` segmented control, because the only
question a reader has about a list of twelve is which ones are live.

## L5. The EMPTY state (panel 5)

The common case for weeks, and the moment the feature explains itself — so it is written as an
explanation, not as a placeholder. It says **what would appear here, when, and where it comes from**,
and its last line names the switch that turns recording off (MOTIR-3331), because a reader who has
just learned that Motir watches their planning should not have to search for that control. It does
**not** say “No lessons yet” and stop: that sentence tells a reader who has never seen this mechanism
nothing at all. Same `.lrows` container as the populated list, so the surface does not change shape
when the first lesson arrives.

## L6. NOT APPLIED — two reasons, drawn apart (panel 3)

The two are different acts and the surface says which:

| state                   | what it is                                                                            | treatment                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Not applied**         | Somebody switched it off (`enabled = false`).                                         | Neutral `--el-muted` badge with a `Ban` glyph. Action inverts to **Apply again**. |
| **Not seen in 90 days** | `lastOccurredAt` fell behind the retention window. **Reverses itself** on recurrence. | `--el-tint-yellow` badge with a `Clock` glyph. Same inverted action.              |

Collapsing them into one greyed row would make a lesson somebody switched off indistinguishable from
one that simply has not come up lately. **Neither is removed from the list** — the whole point of the
surface is to show what the planner has _stopped_ saying, which is why the API deliberately returns
rows the injection path filters out. A not-applied row keeps its full text, loses its emphasis
(`--el-text-tertiary`, chips drop their fill) and is **never struck through**: the lesson is not
wrong, it is just not in force.

## L7. The DETAIL (panel 4)

All four text fields, under labels **in the reader's words** — **What happened · Why it matters ·
How to apply it · Where it came from** — never the column names `body` / `why` / `howToApply` /
`sourceRef`. Reduced to a title in a table, a lesson becomes a rule handed down without
justification, which is the same opacity in a nicer font.

Its own ROUTE rather than a modal, because a lesson is the kind of thing one person sends another.
The status line at the top is the SAME `.callout` box the AI-planning page already uses for its
guardrail sentence — no new primitive. `Where it came from` shows `createdAt`, `lastOccurredAt`,
`recurrenceCount` and the work item the correction came out of (`sourceRef`), which is the provenance
a reader can actually follow.

## L8. Primitives composed — the no-hand-rolling checklist

| Element                  | Primitive                                             | Notes                                                                                 |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The door card            | `SettingsCard`                                        | Identical composition to the three cards above it — icon + title + `hsub`, then body. |
| Card icon                | `GraduationCap` (lucide)                              | Distinct from `Sparkles` (the page) and `Bot` (the planner).                          |
| List container + rows    | `Card` + hairline-divided rows                        | The shipped `--el-border-soft` divider grammar; no new list primitive.                |
| Axis chip                | `Pill` grammar (`--radius-badge`, `--spacing-chip-*`) | Chip fill `--el-chip-bg`, border `--el-chip-border`, ink `--el-text-strong`.          |
| Not-applied badge        | The same chip, in the state role                      | `--el-muted` (switched off) / `--el-tint-yellow` (aged out) + `--el-text-strong`.     |
| Retire / restore action  | `Button` `secondary`, `--height-btn-sm`               | Labelled, with a leading glyph. Never an icon-only button.                            |
| Status callout on detail | The SAME `.callout` box §5 lists                      | Info role (`--el-tint-sky`), `ShieldCheck` glyph.                                     |
| Filter                   | Segmented control from `--el-option-active-bg`        | Existing token roles; no new control.                                                 |
| Empty state              | `EmptyState` grammar                                  | Tinted glyph tile + title + two paragraphs.                                           |
| Back link                | `<a>` + `ChevronLeft`, `--el-link`                    | The shipped drill-down back-link shape.                                               |

**No new primitive is required.** If the implementer finds one is, that is a new `design/` subtask.

## L9. Copy — the exact strings

Door card (on `/settings/project/ai-planning`):

- Title **What Motir has learned** · sub **Corrections this project taught its planner. Motir applies
  them to every plan it drafts here.**
- Link **View all {n} lessons**

List page:

- Title **What Motir has learned**
- Description **Corrections this project taught its planner, most recently relevant first. Motir
  applies each of these to every plan it drafts here — until you stop it.**
- Count line **{n} lessons · {m} applied**
- Filter **All** · **Applied** · **Not applied**
- Row meta **Last seen {when}** · **seen {n} times** (**seen once** / **seen twice** for 1 and 2)
- Axis chips **kind {kind}** · **type {type}** · **phase {phase}** · **Applies to every card**
- Row action **Stop applying** / **Apply again**
- Badges **Not applied** · **Not seen in 90 days**

Detail page:

- Back link **What Motir has learned**
- Status **Motir is applying this.** **It goes into every plan drafted for this project.**
- Section labels **What happened** · **Why it matters** · **How to apply it** · **Where it came from**
- Facts **First recorded** · **Last seen** · **Times seen** · **Recorded from**
- Action **Stop applying this lesson**

Empty state:

- Title **Motir hasn't learned anything here yet**
- Body **When a plan turns out to be wrong — a missing dependency, a card sized past what one run can
  finish — Motir writes down the correction and applies it to every plan it drafts for this project
  afterwards. Those corrections appear here, with what happened and why, so you can read them and
  decide which ones to keep.**
- Second line **Nothing is recorded until a plan is actually corrected. Recording can be switched off
  in AI planning settings.**

**Voice rules applied** (§6's, unchanged): “work item”, never “issue”; “Motir”, never “the AI”. And
one this surface adds: **no implementation noun anywhere** — not “lesson store”, not “retired”, not
“scope”, not “embedding”, not “injection”. The word the product uses to a reader is **apply**: Motir
_applies_ a lesson, and you can _stop applying_ it.

> **Where this copy touches MOTIR-3331's**, they must say the same thing. The setting's explanation
> and this surface both describe one mechanism — Motir writing down a correction and applying it
> afterwards — and a reader meets them minutes apart.

## L10. Token roles

Colour is strictly `--el-*`; shape strictly element-semantic. Roles this asset adds:

- Row ink `--el-text` · row meta `--el-text-secondary` · meta glyphs `--el-icon-muted`.
- A **not-applied** row's ink drops to `--el-text-tertiary` (4.7:1 on the card, AA) — never
  `--el-text-faint`, which clears AA on no surface.
- Axis chip: `--el-chip-bg` / `--el-chip-border` / `--el-text-strong`, with the axis NAME in
  `--el-text-secondary`. The “applies everywhere” chip is transparent-filled.
- Badges: `--el-muted` (switched off) and `--el-tint-yellow` (aged out), both with
  `--el-text-strong` — the hue is in the FILL, the ink stays AA.
- Empty-state glyph tile `--el-tint-lavender` + `--el-text-strong`.
- Shape: `--radius-card` (list container, detail callout, glyph tile) · `--radius-badge` (chips) ·
  `--radius-btn` (row actions) · `--radius-control` (segmented control) · `--spacing-card-padding` ·
  `--spacing-chip-x/y` · `--height-btn-sm` · `--height-control` · `--shadow-card`.

**No invented colour anywhere** — panel 6 renders both surfaces on the dark palette and the palette
flip is the whole change.

## L11. A11y

- The list is a list of **links**, one per lesson; the row's accessible name is the takeaway. The
  chevron is `aria-hidden`.
- The **retire button is a real button inside the row**, labelled **Stop applying {takeaway}** via
  `aria-label` so the name is unambiguous out of context — and it is reachable by keyboard, not only
  on hover (the hover face is a visual reveal, never the only way in).
- The two badges carry their meaning in **words**, never in the fill alone; their glyphs are
  `aria-hidden`.
- The axis chips are plain text, not interactive. Each chip's axis name is part of its text, so a
  screen reader hears “kind story”, not “story”.
- The `·` separators in the meta line are `aria-hidden`.
- The detail's section labels are real headings (`<h2>`), so the page has an outline; the facts are a
  `<dl>`.
- The status callout is `role="status"`.
- Keyboard order: back link → head → filter → rows top-to-bottom, each row's link then its action.

## L12. Out of scope for this asset — stated, not implied

- **Global lessons are NOT shown here, and are not editable here.** The shipped corpus is the
  product's, not the project's; the read is scoped to this project's own rows at the query
  (MOTIR-3335), and this surface has no control that could reach a global row. There is deliberately
  no “show the built-in lessons too” affordance — a customer inspecting _our_ lessons is not asking
  to read Motir's.
- **Editing a lesson's text.** Nothing here is a form. A lesson is a record of what happened; the
  only decision the product offers is whether it is applied.
- **Creating a lesson by hand.** MOTIR-3331's `add_lesson` tool is the write path, and it is an agent
  door, not a screen.
- **The recording switch itself** — MOTIR-3331 owns it; this asset only points at it from the empty
  state, and the two copies must agree.
- **The retire ACTION's behaviour** (optimistic flip, confirm, toast) — MOTIR-3330. This asset draws
  the two states it produces, so the row does not have to be redrawn when it lands.
- **Search across lessons.** Twelve rows do not need one; if a project ever has hundreds, that is its
  own card and its own decision about what is searched.

---

# Amendment — THE DATA-PRACTICE PROMISE (Story MOTIR-3665 · Subtask MOTIR-3666)

**Panel 7.** Two sentences and a link, at the foot of the existing **Planner** card. That is the
whole amendment. The design gate for **MOTIR-3670**, which builds it.

Panels 0–6 and every earlier primitive, copy string and token role above are MOTIR-914's and
MOTIR-1739's, unchanged. This amendment adds **no primitive, no CSS and no new grammar**.

## D1. What this replaces, and why the replacement is so much smaller

An earlier revision of this card drew a **five-control data-policy card** — three policy switches, a
model picker whose excluded rows explained themselves, and an excluded-everything state. It was
withdrawn before it merged. Recorded here because the reasoning is the useful part and a later
reader will otherwise re-propose it:

- **The residency switch was false.** It promised EU residency and its enforcement was the gateway's
  `transfer-basis` group, which holds exactly Anthropic and OpenAI — **both established in the
  USA**. `motir/residency/residency.go` states in its own package doc that the group's membership is
  _"both required, neither geographic"_ and that it is _"deliberately not for a region"_.
- **The control surface belonged to a different KIND of product.** OpenRouter — an LLM router —
  ships `data_collection` and `zdr` as per-request filters, and handles region as a separate
  endpoint at enterprise tier. **Linear**, the nearest competitor to _this_ product, answers the same
  need with a blanket promise, the provider list in its DPA, and a model picker: no data-policy
  filter of any kind. motir-core's settings page is the second kind of product; motir-gateway is the
  first, and the filter stayed there (MOTIR-3669).

The full record is MOTIR-3665's re-scope and the planning bug MOTIR-4752.

## D2. Placement — the foot of the Planner card, and the argument is the placement

A `callout` in the **neutral** role (`--el-surface` + `--el-border`), below the model picker, inside
the card body. Three placements were possible:

| option                                                      | verdict                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Foot of the Planner card, under the picker** — **chosen** | ✓ The promise qualifies the act of _choosing a model_, so it belongs where that choice is made. It also reads in the right order: pick the model, then learn what happens to what you send it.                            |
| Page header, under the title                                | ✗ It would read as a claim about the whole page — including auto-plan and sprint packing, which are cadence settings and not egress. A promise that appears to cover more than it does is worse than one placed narrowly. |
| Its own card                                                | ✗ A card is where a DECISION lives on this page; every one of the four has a control. A card with nothing to change reads as a control whose switch is missing.                                                           |

## D3. The copy, and what each half is allowed to be

> Neither Motir nor its gateway trains on this project's content. What a provider does with a
> request once it reaches them is that provider's own published position.
> **What each provider states →**

**The two sentences are different KINDS of statement and the design depends on the difference.**

- **Sentence one is a COMMITMENT.** It is a fact about moooon B.V.'s own systems, it is ours to
  make, and it is stated in the same words on the public provider page (`content/legal/model-providers.md`
  § _What motir-gateway does with your prompt_, motir-marketing). A reader is entitled to hold us
  to it.
- **Sentence two is a REPORT.** What a provider does is that provider's published position and
  cannot be undertaken on its behalf. It must not be written in a voice that makes it sound like a
  second promise — which is why it ends by handing the reader to the page carrying each provider's
  own answer, rather than summarising any of them.

**⚠️ NO PROVIDER FACT MAY APPEAR IN THE COMPONENT.** No retention window, no "trains: yes", no
provider names. Those live in the gateway (`motir/datapolicy`) and on the provider page. A third
copy in a React component is how this data has already gone stale four times, and MOTIR-3670 carries
a test asserting the absence.

**⚠️ THE LINK TARGET IS NOT A ROUTE THIS REPOSITORY SERVES.** MOTIR-4101 / MOTIR-4103 moved
`content/legal/` **and** `app/(public)/legal/` out of motir-core, so a bare `/legal/model-providers`
resolves against `app.motir.co` and survives only via MOTIR-3884's 301. The mock draws the
destination; **MOTIR-3670 resolves the href through motir-core's existing public-site origin**
(MOTIR-3910 set it, MOTIR-3884's sweep names every absolute-URL reader) rather than hard-coding a
host or introducing a second way to spell it.

## D4. Primitives and tokens — nothing new

| Element                     | Primitive / token                             | Note                                                                                                                                                                    |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The promise box             | the `callout` in its **neutral** role         | `--el-surface` + `--el-border` + `--el-text-secondary`, already defined in §9. Not a tint: this is not a gate, a guardrail or a rationale — it is standing information. |
| Its glyph                   | `Info` (lucide), `--el-icon-*` as §9 gives it | the same glyph the other neutral callouts use                                                                                                                           |
| The link                    | the asset's own **`.clink`**                  | `--el-text-strong` + underline, **not** `--el-link` — §9's existing rule, kept for its recorded AA reason. Reused rather than restyled.                                 |
| Everything else on the card | unchanged                                     | the switch, the hint, the picker and the shared footer are MOTIR-914's                                                                                                  |

**No new primitive, no new CSS rule, no new symbol, no new token.** If the implementer finds one is
needed, that is a new `design/` subtask.

## D5. The non-admin case — NOT drawn, and that is the finding

It is read-only copy. It renders identically for a member who cannot edit the page, so a second
panel would differ from panel 7 by nothing at all, and drawing one would assert a distinction the
implementation must then invent. Panel 5's lock banner and disabled controls are unchanged and still
govern everything above this callout.

## D6. A11y

- The callout is ordinary prose inside the card body — no `role`, no live region. It is present on
  load and never changes, so announcing it would be noise.
- The link is an ordinary `<a>` in the document's tab order, with its own visible text ("What each
  provider states") rather than a bare "learn more" — the destination is legible out of context,
  which is what a screen-reader link list needs.
- It carries an arrow glyph that is decorative; the link text alone names the destination.

## D7. i18n

New copy lands under `settings.aiPlanning.*` with **zh parity in the same PR** (the catalog gate).
The two sentences are **separate keys**: they are different kinds of statement (§D3), a translator
needs to know which is a commitment and which is a report, and a future revision to one must not
silently re-open the other.

## D8. Viewport

**One width, 1200 CSS px** — the width this asset has always been exported at. Unchanged, and this
amendment introduces no second viewport.

## D9. Out of scope for this asset — stated, not implied

- **Any data-policy CONTROL.** Retired with the re-scope; the filter is the gateway's and is
  reached per request (MOTIR-3669), not from this page.
- **The provider table itself** — `motir-marketing/design/legal/` owns it. This asset links to it and
  never restates it.
- **The GA default provider** — MOTIR-4744.
