# Onboarding entrance — idea-first, with a secondary import path (`design/onboarding-entrance/`)

**Subtask:** MOTIR-1461 · 7.22.3 (`type: design`) · **Story:** MOTIR-1459 (Onboarding entrance — the
new-vs-existing front door & routing) · **Epic 7 · AI Planning Layer.**

The `/onboarding` entrance the user lands on after "Build with AI". It **leads with the idea box** (the
primary path) and offers **importing an existing project** as a first-class but secondary path:

- **Start planning** (primary) — describe an idea → the done 7.3 discovery flow (MOTIR-804).
- **I have an existing project — import it** (secondary) → the 7.15 migrate wizard (MOTIR-815 /
  MOTIR-930) or 7.17 Jira / Linear / Plane import (MOTIR-817).

**Layout decision — idea-first, NOT a symmetric two-option fork (revised after competitive research,
Yue, 2026-07-01).** The first draft split the screen into two co-equal choice cards. Research into how
comparable products onboard (below) showed that split is off-pattern for an **idea-first** product, so
the entrance now leads with one full-width idea box and demotes import to a secondary row. This also
fixes the practical problem that a half-width column can't hold a long first idea.

**Scope (deliberately SLIMMED, per the card):** the ENTRANCE ONLY. It draws the idea box, the carried-over
idea state, and names each destination (with a "How Motir works" link for the full lifecycle) — then hands
off. **It draws NO repo-connect,
source-selection, index, or generate UI**; all of that lives downstream in 7.15 / 7.17 and is owned by
their own designs (MOTIR-930). Re-drawing it here would duplicate 7.15.

**Asset files (three, shared basename):** `design-notes.md` (this file) · `onboarding-entrance.mock.html`
(source of truth, standalone — re-states the real `globals.css` `--el-*` values so it renders without
the Tailwind build, exactly as `design/ai-planning/*.mock.html` does) · `onboarding-entrance.png`
(full-page export, light theme, `deviceScaleFactor: 2`).

---

## Mirror grounding — how idea-first products actually onboard (rung 1; verified 2026-07-01)

- **Idea-first AI builders lead with ONE prompt; import is secondary.** Lovable, Bolt, v0, Replit and
  Firebase Studio all open on a single "describe your app" prompt as the primary entrance and treat
  "import an existing repo" (GitHub/GitLab/Bitbucket) as a secondary affordance. Firebase Studio
  explicitly separates a primary **App Prototyping agent** (text/sketch → build) from a quieter "import
  existing project" path.
  - Anna Arteeva, "Choosing your AI prototyping stack" — https://annaarteeva.medium.com/choosing-your-ai-prototyping-stack-lovable-v0-bolt-replit-cursor-magic-patterns-compared-9a5194f163e9
  - LogRocket, "Comparing AI app builders — Firebase Studio vs Lovable vs Replit" — https://blog.logrocket.com/comparing-ai-app-builders/
  - Firebase Studio, "Get started with an existing project" — https://firebase.google.com/docs/studio/get-started-import
- **Two co-equal option cards is the pattern for SOURCE-picker entrances, not idea entrances.** Vercel and
  Railway "New Project" show _Import Git Repository_ alongside _Deploy a Template_ as parallel options —
  but both sides start from an existing artifact (a repo / a template); neither asks for a long idea.
  - Vercel, "Deploying Git Repositories" — https://vercel.com/docs/git
  - Railway, "Quick Start" — https://docs.railway.com/quick-start
- **PM tools frame it as "start fresh vs import from an existing tool," import via a migration wizard.**
  Linear positions onboarding as import-vs-start-fresh; native importers cover Jira, Asana, Shortcut,
  GitHub, Trello. Plane and Jira behave the same.
  - Linear, "Migration guide" — https://linear.app/switch/migration-guide
  - Plane vs Jira — https://plane.so/plane-vs-jira
- **UX guidance:** a binary opposing choice suits a segmented control / two equal cards, but empty-state
  best practice is "one obvious primary action," and choice copy should state plainly what happens next.

**Conclusion applied here:** Motir's front door is chat/idea-first (Principle #1), so the entrance leads
with the idea (like Lovable/Bolt/Replit) rather than a 50/50 fork — while still giving **import** a
visible, first-class row (like Vercel/Linear expose it), because it is a genuinely different journey for a
genuinely different user (someone with an existing codebase).

## Designed against shipped reality

Rendered and read the shipped surfaces this entrance sits between before drawing (the mock reuses their
real structure, it does not redraw a stylised stand-in):

- **`app/(onboarding)/layout.tsx`** — the onboarding route group renders **OUTSIDE** the `(authed)`
  `AppLayout` (no top nav, no project sidebar) but is still **authenticated** (gates the session, bounces
  a signed-out visitor to `/sign-in`). So the entrance owns the whole viewport with only a minimal brand
  bar — matched exactly.
- **`app/(onboarding)/onboarding/page.tsx`** — today `/onboarding` renders `DiscoveryOnboarding`
  DIRECTLY. This story inserts the entrance BEFORE that; MOTIR-1462 (the router) makes `/onboarding` render
  this entrance and route start-planning → `DiscoveryOnboarding` (seeded with the preserved idea) / import
  → the 7.15 wizard.
- **`app/_components/PublicFrontDoor.tsx`** (7.3.14 / MOTIR-1022, the marketing hero) — the SOURCE of the
  idea. This entrance **continues its exact vocabulary**: the `Sparkles` eyebrow chip on
  `--el-tint-lavender`, the **serif** headline (`font-serif`), the idea-capture `Card` + `textarea` +
  `ArrowRight` primary `Button`, and a "See how Motir works" link (the detailed explainer). The carried-over idea
  (Panel 2) is the hero's typed idea preserved by MOTIR-1458 (`lib/onboarding/pendingIdea.ts`) and
  pre-filled here — so the post-login screen reads as "keep going," not a repeat of the hero.

## Access path (entry + the two exits)

- **INBOUND (owned by sibling cards — drawn there, not redrawn here):** (a) the first-login / marketing
  door — motir-core root → `/login` → **"Build with AI"** → `/onboarding` (MOTIR-1457); (b) the IN-APP
  door — an authenticated user picks **"Build with AI"** in the create-project modal / switcher /
  empty-project state (design MOTIR-1485, code MOTIR-1486). Both land on THIS entrance.
- **OUTBOUND (drawn here — the point of the card):** each path names its destination in the copy (Start
  planning → the discovery chat; Import → connect a repo, read your code, plan on top). The **full plan →
  build lifecycle** (Motir plans, then **agents** build it — the three-layer product) is conveyed in the
  header PROSE ("…then agents build it") plus a **"See how Motir works" link** that opens the detailed
  explainer. **No on-screen workflow chart** — an earlier draft drew step-chip steppers (Understand ·
  Scope · Plan · Build), but cryptic chips under-explained; Yue's call is to state it plainly + link to the
  full explanation, and remove the chart. (The explainer target is its own page/surface, not drawn here.)
- **Terminology (Yue):** say **"agents"**, not "hosted coding agents" — the user can run their **own**
  agent (Claude Code / Cursor / …) as well as a Motir-hosted one, so the copy stays agent-agnostic. And
  the START-FRESH path avoids developer jargon — **no "repo"/"No repo needed"** language (Motir is not a
  developers-only tool; a non-technical founder shouldn't hit the word "repo"). Repo / code / GitHub /
  GitLab language is fine ONLY in the import row, whose audience self-selects as having a codebase.
- **Eyebrow label — "Build with AI", not "Plan with AI" (Yue, misleading).** "Plan with AI" frames Motir
  as plan-only, but the product plans AND builds (idea → plan → agents build it). Idea-first builders
  brand on the outcome — Lovable / Bolt / Replit all say **build**, not "plan". So the badge is **"Build
  with AI"**. **This rename must propagate** for a coherent path: the entry button (MOTIR-1457), the
  in-app entry (MOTIR-1485/1486), and the **shipped marketing-hero badge** (7.3.14 / `en.json`
  `landing.badge`, currently "Plan with AI") should all adopt "Build with AI" — a copy-consistency
  follow-up on those cards (flagged, not redrawn here).

---

## Surfaces / panels (inspect every panel)

### Panel 1 — the entrance, default (arrived without a carried-over idea)

Reached via the in-app "Build with AI" door or a direct `/onboarding` visit (no hero idea in the cookie).

- **Brand bar** — `Motir` wordmark (`Sparkles` logo tile on `--el-tint-lavender`) left; a signed-in
  avatar right. **No "Save & exit"** — nothing is saved on this entrance (the idea box is just an input;
  no project or session exists until the user continues). A save / resume affordance belongs INSIDE an
  in-progress onboarding session (MOTIR-1488), not here.
- **Header** — the **"Build with AI"** eyebrow chip; serif H1 **"How would you like to start?"**; secondary
  subhead _"Describe what you want to build. Motir plans it with you, then agents build it."_ (states the
  full arc — planning is not the end state); then a **"See how Motir works →"** link (an `--el-accent` text
  link) — the detailed explainer, replacing the on-screen workflow chart.
- **PRIMARY — the idea box.** A full-width `Card` with an accent border + elevation: the **"Your idea"**
  label and a **tall textarea** (min-height ~172px, 7 rows — room for a long first idea; placeholder
  invites a full description and reassures _"we'll ask follow-up questions next"_). A footer row holds only
  the primary CTA **"Start planning →"** (bottom-right). Below the card, a hint: _"You can start with a
  rough idea — the discovery chat asks follow-up questions."_ (no "No repo needed" — repo is dev jargon).
- **"OR" divider** — a hairline separator, so the secondary path is clearly an alternative, not a step.
- **SECONDARY — the import row.** A slim, full-width option button: a sky icon tile (`GitBranch`), the
  title **"I have an existing project — import it"**, a one-line description (_"Connect your repository and
  Motir reads your code, then plans on top of what's already there. You can also bring over existing work
  items from Jira, Linear or Plane."_), and an **"Import →"** affordance on the right. Visibly available,
  clearly secondary to the idea box.

### Panel 2 — the entrance with a carried-over idea (MOTIR-1458 / 7.22.2)

The state after the user typed an idea on the motir.co hero and signed in. Header swaps to **"Ready when
you are"** / _"We kept the idea you started with. Add more if you like, then continue."_ The idea box is
**pre-filled** with the preserved (long) idea and carries a **"Carried over from your idea"** accent label
(a `--el-accent` dot + text); its CTA becomes **"Continue with this idea →"**, and the hint reads _"Add or
refine anything before you continue — the discovery chat takes it from here."_ (You **add to / refine** your
own idea — never "edit" it; "edit" reads mechanical for a person's own description.)

**No import option in this panel (Yue).** Arriving with an idea in hand means the user is starting fresh —
so the carried-over panel drops the "OR / import an existing project" affordance entirely and is a single,
focused path (idea box → Continue). Import belongs only on the default entrance (Panel 1), where the
starting point is genuinely open. (Copy elsewhere is stated as a factual situation — "I have an existing
project" — never a preference; importing a codebase you already have is not a matter of taste.)

### Panel 3 — states & behaviour (close-ups)

- **Empty idea + keyboard** — "Start planning" works with an empty idea (the chat opens and asks the first
  question; the box is a head-start, not a gate); the textarea holds focus on load, `⌘/Ctrl + Enter`
  submits. The import row is a focusable secondary control with its own hover/focus ring — not hidden
  behind a menu.
- **No "Save & exit"** — nothing is saved on this entrance (no project/session exists until the user
  continues); save/resume belongs inside an in-progress onboarding session (MOTIR-1488).
- **Reachability — this screen only ROUTES** — Start planning → the 7.3 discovery chat (seeded);
  Import → the 7.15 migrate wizard (or 7.17 for Jira / Linear / Plane), which owns connect →
  source-selection → index → generate. Both end in a reviewed plan that agents then build — the user's own
  agent or a Motir-hosted one (explained via the "See how Motir works" link). Nothing here connects a repo, picks a source,
  generates, or runs an agent.

---

## Primitives composed (no hand-rolling)

| Element                    | Shipped primitive / pattern                                 | Token role                                                                                                     |
| -------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Idea box                   | `Card` + `textarea`, continuing the 7.3.14 hero             | `--el-card` bg on an `--el-accent` border + `--shadow-elevated`; input fill transparent, `--radius-card`       |
| Primary CTA                | `Button` (`variant="primary"`, `rightIcon={<ArrowRight/>}`) | `--el-accent` / `--el-accent-text`; `--radius-btn`, `--height-btn-md`                                          |
| Import row                 | `Card` as a clickable option button (`clickable`)           | `--el-card` bg, `--el-border` (→ `--el-border-strong` on hover), `--radius-card`; accent "Import →" affordance |
| "Build with AI" eyebrow    | badge chip (as on the hero)                                 | `--el-tint-lavender` bg, `--el-text-strong` text, `--radius-badge`, `--spacing-chip-x/y`                       |
| "See how Motir works" link | inline text link                                            | `--el-link` / `--el-accent-on-surface`; underline on hover                                                     |
| Icon tile (import)         | tinted square (as on the hero preview)                      | `--el-tint-sky`; ink `--el-text-strong`; `--radius-control`                                                    |
| "OR" divider               | hairline rule + mono label                                  | `--el-border` rule, `--el-text-faint` label                                                                    |
| Info callout (Panel 3)     | callout box + `Info`/`Code`/`GitBranch` lucide              | `--el-surface-soft`, `--el-border`, `--radius-input`; icon `--el-info`                                         |
| Carried-over label         | inline label + dot                                          | `--el-accent-on-surface` text + dot                                                                            |
| Avatar                     | circular chip                                               | `--el-tint-mint` bg, `--el-text-strong` ink, `rounded-full`                                                    |

Icons are **lucide** (`Sparkles`, `GitBranch`, `Code`, `ArrowRight`, `Info`) at `viewBox="0 0 24 24"`,
stroke 2, round caps — matching the shipped hero.

### Colour + shape rules (mock === component)

- Every colour resolves to an `--el-*` / `--color-*` palette token (the mock re-states their light /
  warm-editorial / motir VALUES). **No invented hues** on any card / pill / state / text — the only raw
  values are non-semantic elevation shadows and the doc-annotation scaffold chrome (panel captions / ref
  chips), which are not product UI.
- Shape flows through element-semantic tokens (`--radius-card`/`-btn`/`-input`/`-badge`/`-control`,
  `--spacing-card-padding`, `--height-btn-md`) — never a raw `rounded-md`/`p-2`/`h-9`, so a `data-style`
  swap re-shapes it.

## Which story owns each destination (connect, don't duplicate)

| Destination shown                                      | Owner (design → build)                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Start-fresh discovery (Understand · Scope · Plan)      | 7.3 / MOTIR-804 (done); entered by MOTIR-1462 seeding `DiscoveryOnboarding` |
| Import wizard (Connect · Read your code · Plan)        | 7.15 / MOTIR-815, wizard design MOTIR-930, orchestration MOTIR-931          |
| External Jira / Linear / Plane import                  | 7.17 / MOTIR-817                                                            |
| The `/onboarding` entrance route + hand-off            | MOTIR-1462 (`blocked_by` this design)                                       |
| The IN-APP "Build with AI" entry that reuses this fork | MOTIR-1485 (design) / MOTIR-1486 (code)                                     |

---

# Resume onboarding — the labeled app-shell re-entry door (MOTIR-1548, for MOTIR-1533)

**Subtask:** MOTIR-1548 · (`type: design`) · **Story:** MOTIR-1459 · **Epic 7 · AI Planning Layer.**
Produced by the `motir run MOTIR-1533` **design gate** (`run.md` guard #3): MOTIR-1533 (the code half)
requires a "clearly-labeled 'Resume onboarding' entry point … placement per the entrance design, NOT
improvised," but no shipped design depicted it — the entrance design above deliberately places NO resume
affordance on the front door, deferring it to the app shell. This section is that placement.

**Asset files (three, shared basename):** this `design-notes.md` (§) · `resume-onboarding-door.mock.html`
(source of truth, standalone — copies the real `app/globals.css` Tier-0 `--color-*` + shape tokens + Tier-3
`--el-*` so it paints without the Tailwind build, exactly as `design/ready/ready.mock.html` does) ·
`resume-onboarding-door.png` (full-page export, light theme, `deviceScaleFactor: 2`).

## The decision (what MOTIR-1533 builds)

A dedicated, clearly-labeled **"Resume onboarding"** entry point in the SIGNED-IN app shell, shown ONLY
when the active project has an **in-progress (un-finished)** onboarding session. It is a `SidebarItem`
(the shipped `components/ui/Sidebar.tsx` primitive) pushed to the **top of the `hasProject` primary
section** in `app/(authed)/_components/SidebarNav.tsx` — above Dashboard — because an interrupted
onboarding is the project's highest-priority next action. A **⌘K twin** action mirrors it in
`AppCommandPalette`. Activating either navigates to **`/onboarding`**, which already resumes to the real
persisted step (MOTIR-1487's "Resuming…" machinery) — the door only supplies the route; it adds NO resume
logic.

- **Label:** `Resume onboarding` (a new `shell.nav.resumeOnboarding` `en.json` key).
- **Glyph:** lucide **`History`** — the SAME glyph the wz-bar's "Save & exit" uses (MOTIR-1488), so the
  save→resume loop reads as one gesture. Deliberately NOT `Sparkles` (the generic planning mark) or
  `RotateCw` (1485's "Continue your plan"), so the three doors stay visually distinct.
- **Treatment:** an accent row — `--el-tint-lavender` fill, `--el-accent-on-surface` icon, `--el-text-strong`
  label, a hairline `color-mix(--el-accent 22%, transparent)` border. Elevated above the plain rows (it is a
  stateful call-to-action) but it does **NOT** take the `PlanWithAILauncher` hero gradient — that stays
  reserved for the generic launcher.
- **In-progress indicator:** a compact **trailing accent status dot** in the rail. A text "In progress"
  chip was rejected: at the shipped **240px** rail width it truncates the 17-char label to "Resu…" (the
  render caught this). The authoritative non-visual signal is the row's **conditional presence** plus
  `aria-label="Resume onboarding (in progress)"` (state not by colour alone — finding #35). The explicit
  "In progress" chip appears only where there is room — the ⌘K palette (460px).
- **Collapsed rail:** the icon-only `History` tile (lavender), an accent dot in the corner (the chip has no
  room), and the label in the shipped `Tooltip` (`side="right"`), exactly as the primitive already does.

## Shown / hidden — the detection seam (so 1533 can implement it)

The row renders IFF the active project's onboarding is in progress:

```
onboardingRanAt == null            (server, cheap — lib/dto/projects.ts; a set value = already materialised)
  AND
GET /api/ai/pre-plan → session != null AND session.status !== 'tiers_complete'
                                   (the live PreplanSession, read via aiPreplanService.getPreplanState)
```

A never-started project (`session: null`) and a finished one (`onboardingRanAt` set → both onboarding
pages already redirect to `/roadmap`) BOTH hide the row. There is **no combined server helper today**.
**Recommended implementation (1533): a small client island** — the row fetches `/api/ai/pre-plan` on mount
(the same seam `useDiscoveryChat` / `preplanClient.fetchPreplanState` already use) and reveals itself only
when in-progress; it degrades gracefully (hidden until known) and avoids a motir-ai round-trip on every
authed server render. (Alternative: a layout-level `aiPreplanService.getPreplanState(ctx)` read in
`app/(authed)/layout.tsx` threaded to `SidebarNav` — simpler data flow, but adds a motir-ai call to every
authed page's server render.) Gate the whole thing behind `isMotirAiConfigured()` (the same mount gate the
launcher uses) — a self-host install with no AI never shows it. `tests` cover the shown/hidden logic.

## Differentiation from "Plan with AI" (they co-exist)

The generic `PlanWithAILauncher` (pill / FAB / ⌘K, `Sparkles`, MOTIR-1299) is the **always-on generative**
entrance — start a plan or re-plan — and also routes to `/onboarding`. "Resume onboarding" is the
**conditional, stateful** "continue what you started" door. They co-exist; the labeled row + `History`
glyph + accent dot + conditional visibility make the resume door unmistakable next to the generic pill.
(The launcher is NOT suppressed while onboarding is in progress — it keeps its own generic purpose.)

## Reconciled with the sibling resume affordances (AC — honour 1461 / 1488 / 1485)

Four resume-adjacent affordances, **mutually exclusive by state**, so the vocabulary stays coherent:

| Affordance             | Glyph      | When it shows                                                                    | Owner                 |
| ---------------------- | ---------- | -------------------------------------------------------------------------------- | --------------------- |
| **Plan with AI**       | `Sparkles` | Always (AI configured + a project). Generic generative entrance. Pill/FAB/⌘K.    | MOTIR-1299            |
| **Save & exit**        | `History`  | INSIDE an onboarding session (the wz-bar). The EXIT half of the loop.            | MOTIR-1488 ✓          |
| **Resume onboarding**  | `History`  | App shell, onboarding **in-progress & un-finished** (`onboardingRanAt == null`). | **MOTIR-1548 → 1533** |
| **Continue your plan** | `RotateCw` | Empty-project state / switcher, project **already has a FINISHED plan**.         | MOTIR-1485 / 1486     |

- **MOTIR-1461** (the entrance) is honoured: NO resume affordance on the `/onboarding` front door itself —
  resume lives in the app shell (here) and in-session (1488), never on the entrance.
- **Resume onboarding** vs **Continue your plan** are split by `onboardingRanAt` (un-finished vs finished),
  so they never collide; they use different glyphs (`History` vs `RotateCw`) and different host surfaces.

## Primitives composed (no hand-rolling)

| Element                                  | Shipped primitive / pattern                                        | Token role                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The rail row                             | `SidebarItem` (`components/ui/Sidebar.tsx`) — accent variant       | `--el-tint-lavender` fill, `--el-accent-on-surface` icon, `--el-text-strong`, `--radius-control`, `--height-control`, `--spacing-control-x` |
| In-progress dot / ⌘K chip                | accent status dot · badge chip (as the `SoonChip` pattern)         | dot `--el-accent`; chip `--el-surface` bg + `--el-text-strong`, `--radius-badge`, `--spacing-chip-x/y`                                      |
| Collapsed row + tooltip                  | icon tile + `Tooltip` (`side="right"`)                             | `--el-tint-lavender` tile; tooltip `--el-text` bubble + `--el-text-inverted`                                                                |
| ⌘K action                                | `AppCommandPalette` `CommandGroup` action (mirrors `plan-with-ai`) | `--el-tint-lavender` selected row, `--el-accent-on-surface` icon, `--radius-control`                                                        |
| "Plan with AI" pill (shown for contrast) | `PlanWithAILauncher` — palette-derived gradient                    | `color-mix()` over `--el-accent`/`--el-accent-text`/`--el-highlight`; `--radius-badge`, `--height-btn-md`                                   |

Icons are **lucide** (`History`, `Sparkles`, `RotateCw`, `Command`, + the existing nav glyphs) at
`viewBox="0 0 24 24"`, stroke 2, round caps — matching the shipped rail + wz-bar.

### Colour + shape rules (mock === component)

- Every colour resolves to an `--el-*` / `--el-tint-*` token, or a `color-mix()` whose inputs are ALL
  tokens (the hover fill, the row border, the pill gradient). **No invented hues.** The only raw values are
  the non-semantic elevation shadows and the doc-scaffold chrome (panel captions / ref chips), which are not
  product UI.
- Shape flows through element-semantic tokens (`--radius-control`/`-badge`/`-card`/`-modal`, `--height-control`/
  `-btn-md`, `--spacing-control-x`/`-chip-x/y`, `--shadow-*`) — never a raw `rounded-md`/`p-2`/`h-9`, so a
  `data-style` swap re-shapes it. `rounded-full` only on the status dot / avatar.

## Which card owns each destination (connect, don't duplicate)

| Destination                                               | Owner (design → build)                           |
| --------------------------------------------------------- | ------------------------------------------------ |
| The "Resume onboarding" rail row + ⌘K twin + shown/hidden | **MOTIR-1548 (this design) → MOTIR-1533 (code)** |
| The `/onboarding` resume route + "Resuming…" real step    | MOTIR-1462 (router) + MOTIR-1487 (done)          |
| The in-session "Save & exit" (wz-bar)                     | MOTIR-1488 (done)                                |
| "Continue your plan" (finished-plan empty state)          | MOTIR-1485 / 1486                                |
| The generic "Plan with AI" launcher                       | MOTIR-1299 (done)                                |
