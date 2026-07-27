# Design notes — AI planning project settings (`design/ai-settings/`)

**Story:** MOTIR-813 · _Cadence — auto-planning + AI sprint planning_ (Epic 7).
**Subtask:** MOTIR-914 (7.13.1) — the design gate for MOTIR-919 (7.13.6), which implements this
asset verbatim.

| File                             | What it is                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `ai-planning-settings.mock.html` | The asset SOURCE — six panels, built from the real design system. Layout source of truth. |
| `ai-planning-settings.png`       | Full-page export (light, `deviceScaleFactor: 2`, viewport 1200) — the reviewable face.    |
| `design-notes.md`                | This spec: placement, primitives, copy, token roles, states, a11y.                        |

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

## 8. States (panels 1 · 2 · 4 · 5)

1. **Default / off.** Every AI setting ships off or at its default, so an existing project is
   untouched until someone opts in. A dependent control is **present but disabled**, never hidden —
   the reader sees what the switch will unlock (the Linear cycle-settings shape). The disabled
   dependent keeps its layout; only its opacity + text tokens drop (`--el-text-faint`).
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

## 9. Colour + shape token roles (per element)

Colour — `--el-*` only; **no Tier-0 `--color-*` in component code, no invented hue** anywhere:

| Element                                            | Token                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Page title · control labels                        | `--el-text`                                                                  |
| Page description · card sub · field hints          | `--el-text-muted` / `--el-text-helper`                                       |
| Disabled dependent label + hint                    | `--el-text-faint`                                                            |
| Card surface · page background                     | `--el-card` / `--el-page-bg`                                                 |
| Card border · inner dividers                       | `--el-border` / `--el-border-soft`                                           |
| Card footer band                                   | `--el-surface-soft`                                                          |
| Switch track ON · knob · track OFF                 | `--el-switch-on` · `--el-switch-knob` · `--el-muted` + `--el-border-strong`  |
| Stepper input border · icon-button border          | `--el-input-border` · `--el-button-border`                                   |
| Combobox trigger border · chevron · secondary text | `--el-input-border` · `--el-icon-field` · `--el-text-identifier`             |
| Combobox option highlight · selected check         | `--el-option-active-bg` · `--el-accent-on-surface`                           |
| Primary button fill / its text                     | `--el-accent` / `--el-accent-text`                                           |
| Secondary button                                   | `--el-page-bg` + `--el-button-border` + `--el-text-secondary`                |
| **Guardrail callout** (approval promise)           | `--el-tint-sky` bg + `--el-text-strong` + `--el-info` icon                   |
| **Rationale callout** (short sprints)              | `--el-tint-lavender` bg + `--el-text-strong` + `--el-accent-on-surface` icon |
| **Not-connected callout**                          | `--el-tint-peach` bg + `--el-text-strong` + `--el-warning` icon              |
| Read-only lock banner                              | `--el-surface` + `--el-border` + `--el-icon-muted` icon                      |
| Validation text + invalid border                   | `--el-danger`                                                                |
| Saved toast icon                                   | `--el-success`                                                               |
| Card-head glyphs                                   | `--el-icon-heading`                                                          |
| Rail active row · its icon                         | `--el-sidebar-item-bg-active` + `--el-sidebar-border` · `--el-icon-active`   |
| Focus ring                                         | `--focus-ring-color`                                                         |

Three tinted callouts use **three distinct tint slots** so they never read as the same message; text
on every tint is `--el-text-strong` (AA, finding #35). No page-level surface is tinted.

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

## 11. i18n

Keys land under the existing **`settings`** namespace as `settings.aiPlanning.*` — the shipped
convention for every settings page (`settings.estimation.*`, `settings.nav.*`), plus
`settings.nav.aiPlanning` for the rail label.

> MOTIR-919's description asks for a new top-level `aiSettings` namespace. Prefer
> `settings.aiPlanning.*`: it matches every sibling settings page, keeps the rail label beside the
> other `nav.*` keys, and avoids a namespace that exists for one page. Every new `en.json` key needs
> its `zh.json` counterpart in the SAME PR (the i18n-catalog parity gate).

## 12. Out of scope for this asset

- The **plan-review surface** a cadence-fired proposal lands in — that is Story 7.4's, already
  designed; this page only decides _when_ a proposal is drafted.
- The **sprint-proposal review** UI (MOTIR-918's persist flow) — its own surface, not a settings pane.
- Usage / spend for the chosen model — `design/ai-usage/` owns that; the hint here only points at
  where billing lands.
- Workspace- or org-level AI settings — every control here is **project-scoped**, matching the
  MOTIR-915 columns on `Project`.
