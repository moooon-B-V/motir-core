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

**⚠️ AMENDED 2026-09-04 (MOTIR-4370) — the asymmetry with motir.co is DELIBERATE, and this is the
record of it.** `motir-marketing/design/marketing/design-notes.md` draws the public landing as a
**symmetric fork**: "Start something new" and "I have an existing project" as co-equal doors, with the
`OR` divider deliberately removed. That asset flagged the seam it opened and said plainly that it could
not decide another surface's design. MOTIR-4370 carried the question, and the ruling is: **this entrance
keeps the idea-first shape described above. Neither surface is changed to match the other.**

**Why they differ — the two are met in different moments, by readers who have chosen different amounts.**
The landing meets a visitor who has committed to nothing, and a symmetric fork is the honest thing to show
someone still deciding; that page is also answering _what Motir is_, and the co-equal import door is the
point of the answer. **This entrance is reached by a reader who has already chosen the idea path, by name,
at the door** — the in-app door is a button reading "Plan a new project with AI" (`ProjectSwitcher`,
via `startNewAiProjectAction` — it named `ProjectsEmptyState` as a second door until MOTIR-4872
retired that screen, and the switcher is the only in-app one now), and the cross-origin door carries an idea in the
`motir_pending_idea` cookie and renders **Panel 2, which drops the import row entirely.** Re-offering a
symmetric fork here re-asks a question the reader answered with the click.

**The 2026-07-01 width constraint still holds, and only this surface has it.** This entrance's centred
column is ~660px (~310px a side) — too narrow for a long first idea. The landing's fork sits in a 1080px
container (~510px a side), wider than this entrance's own full-width box. The constraint was about width.

**Import is not demoted out of reach.** It is a first-class secondary row, and a project that already
holds work items never meets this entrance at all — MOTIR-1259 routes it to the migrate wizard.

**What this ruling does NOT settle.** The `intent=import` parameter the landing's import door emits has
no reader on this side, so a visitor who picks that door currently lands on Panel 1 rather than the
import branch. **That is a routing gap, not a design asymmetry**, and MOTIR-3846 owns it. This ruling
assumes it lands; if it is ever abandoned, the asymmetry is worth revisiting, because the import door
would then contradict itself one screen later.

**Scope (deliberately SLIMMED, per the card):** the ENTRANCE ONLY. It draws the idea box, the carried-over
idea state, and names each destination (with a "How Motir works" link for the full lifecycle) — then hands
off. **It draws NO repo-connect,
source-selection, index, or generate UI**; all of that lives downstream in 7.15 / 7.17 and is owned by
their own designs (MOTIR-930). Re-drawing it here would duplicate 7.15.

**Asset files (three, shared basename):** `design-notes.md` (this file) · `onboarding-entrance.mock.html`
(source of truth, standalone — re-states the real `globals.css` `--el-*` values, **under the `--el-*`
names**, so it renders without the Tailwind build, exactly as
`design/ai-planning/plan-revision.mock.html` does) · `onboarding-entrance.png`
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
- **The MOTIR-1022 marketing hero (7.3.14)** — the SOURCE of the idea, and **no longer part of this
  repo**: MOTIR-1457 (commit `37ee7c97`) pointed the root at `/sign-in` and relocated the hero to the
  standalone motir-marketing site (Story 8.3 / MOTIR-1152). Read its markup out of git history at
  `37ee7c97^` if you need it; there is no motir-core file to open. This entrance **continues its exact
  vocabulary**: the `Sparkles` eyebrow chip on `--el-tint-lavender`, the **serif** headline
  (`font-serif`), the idea-capture `Card` + `textarea` + `ArrowRight` primary `Button`, and a
  "See how Motir works" link (the detailed explainer). The surviving in-repo seam is the **"Plan with
  AI" door** on `app/(auth)/sign-in/page.tsx`, which carries the same `Sparkles` mark; the carried-over
  idea (Panel 2) is the hero's typed idea preserved by MOTIR-1458 (`lib/onboarding/pendingIdea.ts`) and
  pre-filled here — so the post-login screen reads as "keep going," not a repeat of the hero.

## Access path (entry + the two exits)

- **INBOUND (owned by sibling cards — drawn there, not redrawn here):** (a) the first-login / marketing
  door — motir-core root → `/sign-in` → **"Build with AI"** → `/onboarding` (MOTIR-1457); (b) the IN-APP
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
| "OR" divider               | hairline rule + mono label                                  | `--el-border` rule, `--el-text-secondary` label                                                                |
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

  > **⚠️ AMENDED 2026-09-03 (MOTIR-4351) — this rule was stated here and NOT held by the asset, in two
  > ways, and neither was measurable until now.**
  >
  > **(a) The names, which are what the guards read.** The mock's `:root` copied the design system's
  > values onto PRIVATELY-NAMED aliases — `--text`, `--muted`, `--faint`, `--page`, `--hub`, `--soft`,
  > `--hair` — and painted through those. `tests/theme/inkContrastMockScan.ts` and
  > `tests/theme/mockStateInkScan.ts` classify ink by reading an `--el-*` name off the declaration AT
  > THE PAINT SITE, so all 73 paint sites in this asset were outside every ink guard in the tree by
  > construction, and their greens said nothing about it. The block now declares the real `--el-*`
  > names and every site consumes them.
  >
  > **(b) "No invented hues" was FALSE — there were four**, and the carve-out above was covering one of
  > them. Each is now a token or a `color-mix()` whose inputs are all tokens:
  >
  > | was                                          | is                                                            | note                                                                                                    |
  > | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  > | `--page: #f4f3f1` (body + `.ob` ground)      | `--el-surface` (`#f6f5f4`)                                    | nearest token by value AND role; a 3-unit shift, and the drawn body/container relationship is unchanged |
  > | `--border-strong: #d3cfc8` (`.import:hover`) | `--el-border-strong` (`#c8c4be`)                              | the semantic role is exact; the asset's value was an invented intermediate                              |
  > | `--accent-soft: #f4f2fd` (`.ref` fill)       | `color-mix(in srgb, var(--el-accent) 7%, var(--el-page-bg))`  | all-token inputs, so it follows a re-skin                                                               |
  > | `#e3def8` inline on `.ref`'s border          | `color-mix(in srgb, var(--el-accent) 17%, var(--el-page-bg))` | a raw hex at the point of use, not even routed through an alias                                         |
  >
  > **And the swap exposed five sub-AA elements the asset had been carrying unmeasured.** Once the ink
  > was declared under its real name, `design-ink-contrast` reported `--el-text-muted` at 4.12–4.34:1
  > on `--el-surface` for three `.note` and two `.hint` elements — under AA, and exactly the pairing
  > `CLAUDE.md`'s measured table forbids ([MOTIR-2455]). Both rules now take **`--el-text-secondary`**
  > (6.18–6.80:1 on all four surfaces in both themes). Separately, `--el-text-faint` — which clears AA
  > on NO surface — carried three active informational labels (`.idea-card .lbl`, the `.or` divider,
  > `.state .st-cap`); all three now take `--el-text-secondary`, and the `.idea-card` placeholder takes
  > `--el-text-muted`, which the guard confirms clears AA on the white card it sits in.
  >
  > **The composition table below was RIGHT and the mock was wrong** — its "OR divider" row already
  > specified an `--el-text-secondary` label, and the asset painted a faint alias. The sweep restores
  > the specification rather than changing it. Nothing else in the drawn design moved: the `.png`
  > re-export reports `EXACT` at 2560×4866.

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
`AppCommandPalette`. Activating either navigates to **`/onboarding/discovery`** (the resume surface),
which already resumes to the real persisted step (MOTIR-1487's "Resuming…" machinery) — the door only
supplies the route; it adds NO resume logic. It does NOT target `/onboarding` — that is the entrance FORK
(idea box + import) and does no AI read, so it can't resume an in-progress session (bug MOTIR-1556).

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
GET /api/ai/pre-plan → session != null
                                   (the live PreplanSession, read via aiPreplanService.getPreplanState)
```

> **MOTIR-1556 correction:** the client signal is simply "a session exists" — do NOT also exclude
> `status === 'tiers_complete'`. A tiers-complete session whose plan hasn't materialised
> (`onboardingRanAt` still null) is still un-finished, resumable onboarding, and the door must show. The
> server gate already excludes genuinely-finished onboarding, so no status check is needed.

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

---

## 2026-10-11 — the vibe layout: the Motir lockup, a full-width hero and section bands (MOTIR-8250)

**Amends:** MOTIR-1461's
entrance (§ _Surfaces / panels_, Panels 1–3, and § _Primitives composed_) and the
MOTIR-4370 2026-09-04 amendment at the top of this file. **Delta mock:**
[`onboarding-entrance--vibe-layout.mock.html`](./onboarding-entrance--vibe-layout.mock.html).
`onboarding-entrance.mock.html` is a record and is **not edited**. Story MOTIR-8238.

**Design system — files read:** `package.json` (root; `"@motir/design-system": "workspace:*"`),
`app/globals.css` (line 13, `@import '@motir/design-system/theme.css'`; line 25,
`@import '@motir/brand/brand.css'`), `node_modules/@motir/design-system/package.json` (→
`packages/design-system`, **`"version": "0.13.0"`**, exports `./mock`), `app/layout.tsx` (the
`data-style` / `data-palette` / `data-type` attributes it stamps on `<html>`), and
`packages/design-system/src/theme/{styles,palettes}.ts` (the defaults). There is no `DESIGN.md`.

**Verdict: ON MOTIR DESIGN — branch (a).** Both checks hold. Version **0.13.0** exports
`@motir/design-system/mock`, so the asset is **built with `renderMock`** from the package's real parts.
The project's axes: `app/layout.tsx` writes each signed-in person's own preference and, with none,
nothing — so the `:root` defaults apply, **`data-style="warm-editorial"` · `data-palette="motir"` ·
`data-type="motir"`**. `motir` is the monochrome palette (MOTIR-6470 / MOTIR-6471); the mock renders
at exactly those axes. Every panel is drawn twice, light and dark, each frame a
`[data-appearance-scope]` subtree carrying `data-theme` and the three axes, so both themes resolve from
the same compiled `theme.css` in one document.

| part                                                | where it comes from                                                        | disposition                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Button` (primary md · loading; secondary lg)       | `@motir/design-system`, rendered by `renderMock`                           | as is; the import and Back links wear `buttonVariants({ variant: 'secondary', size: 'lg' })`       |
| `Spinner`                                           | `@motir/design-system`, inside `<Button loading>`                          | as is                                                                                              |
| `BrandMark` (`lockup`, `default`, 28)               | `@motir/brand` (`packages/brand/src/BrandMark.tsx`) + `brand.css`, inlined | as is — Motir's own brand chrome, deliberately not in the design system                            |
| the idea control (form card + textarea + footer)    | product-local — `components/onboarding/OnboardingEntrance.tsx` today       | restyled, not new: the same control in a wider frame                                               |
| **`OnboardingHero`** (ground, lockup bar, waves)    | NEW                                                                        | **product-local component** — it speaks Motir's own brand and voice; a scaffolded product has none |
| **`HeroWaves`** (the static wave field)             | NEW                                                                        | **product-local component** — built from `WAVE_BAND_PATH`, which lives in `@motir/brand`, not here |
| **`OnboardingSection`** (band + SectionHead + slot) | NEW                                                                        | **product-local component** for now — see finding F5 for why it is not proposed for the package    |

Nothing is proposed as an addition to `@motir/design-system`.

**Shipped reality read**, at the branch head `aad2def` (over `origin/main` `6676b80`): the components
above, `app/(onboarding)/onboarding/how-it-works/page.tsx` (an `EmptyState` placeholder seam with a
`Sparkles` icon in the same `max-w-[41.25rem]` column), `packages/brand/src/{BrandMark,waveBand}.ts`,
`design/brand/design-notes.md` §3, §7, §8, §10, and `messages/en.json` as MOTIR-8248 left it (commit
`35e82f9`). Every string drawn is read from that file by key; none is typed.

**motir.co, read and never imported** — `motir-marketing` at `origin/main` **`0c2e37b`**:
`motir-marketing/app/[locale]/page.tsx` (the hero section, `GUTTER = px-[clamp(16px,3vw,48px)]`, the `H2` scale,
`SectionHead`'s `[1.4fr 1fr]` grid and its `max-w-[44ch]` `--el-text-secondary` body),
`motir-marketing/app/_components/SiteHeader.tsx` (no fill and no rule; `BrandTile size={28}`;
`px-(--spacing-card-padding) py-4`), `motir-marketing/app/_components/BrandTile.tsx` (the lockup on a tile, glyph
decorative, word as the name), and — because the hero cites it — `motir-marketing/app/_components/landing/HeroWaves.tsx`
(46 lines of the mark's top edge, 1 px, `--el-showcase-wave-1..3`, alpha 0.03–0.13 light / 0.06–0.19
dark, gathered on the idea box) and `motir-marketing/app/_components/landing/HeroBrief.tsx` (label · textarea · hint-left / Start-right footer,
`max-w-[700px]`). What is taken is the layout **language**; the parts are motir-core's.

### Panels (light AND dark, every one)

| #   | Panel                                                                                                          | frame      |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Entrance, default — the hero with the empty (focused) idea box, and the import section under it                | 1280 px    |
| 2   | Entrance, carried-over idea — pre-filled long idea, carried label, continue CTA, **no import section**         | 1280 px    |
| 3   | Close-ups — 3a box at rest · 3b focused · 3c long idea · 3d Start rest/hover/focus/pending · 3e import control | 640 px × 2 |
| 4   | How it works, populated — hero (title + body) + three section bands + Back                                     | 1280 px    |
| 5   | Narrow — entrance default, entrance carried, how it works                                                      | 390 px     |
| 6   | Pattern — A the lockup · B the hero with waves · C one section band, each with its tokens and spacing          | 640 px × 2 |

The access path is drawn in place: **Start** (→ `/onboarding/discovery`, seeded), **See how Motir works**
(→ `/onboarding/how-it-works`), **We can vibe it too** (→ `/onboarding/migrate`), **Back to start** (→
`/onboarding`) and the lockup (→ `/`). Inbound — sign-up / sign-in and the in-app project switcher door
— is unchanged and is context only.

### The idea-first ruling, restated (MOTIR-4370 holds)

This design takes motir.co's layout language and **keeps** the 2026-09-04 ruling: the entrance is
**idea-first, not motir.co's symmetric fork**. The idea box is the hero's control; import is ONE section
band below it, visibly secondary (a smaller serif head, a secondary button, the page ground rather than
the hero's). **Panel 2 still drops the import section entirely** — a reader who arrived with an idea
answered the fork at the door. **What changes is one premise of that ruling:** it said the ~660 px
centred column's width constraint "still holds, and only this surface has it". **It no longer applies.**
The centred column is gone; the hero gives the idea box a 760 px slot (wider than motir.co's 700 px
brief), so the constraint that made a two-door fork impossible is not what keeps it idea-first now — the
ruling's other reason, the reader's moment, is. A future revisit of the asymmetry should argue from that
reason alone.

### What stays the same (Panel 3 of MOTIR-1461)

Every behaviour is unchanged; only how each existing state LOOKS moves. An empty idea still starts; the
textarea holds focus on load (`autoFocus`, so Panel 1 is drawn with its focus ring); `⌘/Ctrl+Enter`
submits and a bare Enter is a newline; the import control is a focusable link with its own ring; there
is no "Save & exit". No state is added and none removed. **Two looks are now specified that were not:**

- **A long idea GROWS, then scrolls.** The textarea starts at `min-h 7.5rem` (`10rem` narrow, so the
  placeholder fits), grows with its content (`field-sizing: content`), and caps at **`18rem`**, after
  which it scrolls inside the card. The footer — and Start — never move below the fold. `resize: none`.
- **Pending is the package Button's own `loading`** (3d): the Spinner, `disabled`, `aria-busy`, the label
  unchanged ("Start" / "Continue with this idea"), and the textarea `disabled` beside it. That is what
  `useFormStatus().pending` drives; no new copy (finding F2).

### Primitives composed — the updated table (replaces MOTIR-1461's for this surface)

Colour role is the Tier-3 `--el-*` token; shape is the `[data-style]` element token. Values measured are
the default (`motir`) palette.

| Element                                    | Primitive                                                               | Colour (`--el-*`)                                                                                                                    | Shape / size                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Lockup** (replaces the Sparkles tile)    | `BrandMark variant="lockup" tone="default" size={28}` in a link to `/`  | glyph `--el-accent-on-surface` (`.brand-glyph`); wordmark `--el-text` (`.brand-word`, the Space Grotesk face pin)                    | 28 px glyph, gap `0.33×`, word `0.74×`; link focus outline `--el-accent-on-surface`, `--radius-control`           |
| Lockup bar                                 | header row (motir.co `SiteHeader`)                                      | **no fill, no rule** — sits on the hero ground                                                                                       | `px-(--spacing-card-padding) py-4` (`px-4 py-3` narrow)                                                           |
| ~~Eyebrow chip~~                           | **REMOVED, not relabelled**                                             | —                                                                                                                                    | —                                                                                                                 |
| **Hero ground**                            | `OnboardingHero` section, `relative isolate overflow-hidden`            | `--el-surface`                                                                                                                       | gutter `clamp(16px,3vw,48px)`; `pt clamp(40px,5vw,64px)` · `pb clamp(64px,8vw,104px)`; gap 22 px (18 narrow)      |
| **Wave lines**                             | `HeroWaves` — inline SVG, `aria-hidden`, `pointer-events-none`, `-z-10` | stroke `--el-showcase-wave-1` / `-2` / `-3` in turn; alpha 0.03–0.13 light, 0.06–0.19 dark, highest on the lines through the control | 23 lines of `WAVE_BAND_PATH`'s top contour, 1 px `non-scaling-stroke`, `preserveAspectRatio="xMidYMid slice"`     |
| H1                                         | serif heading                                                           | `--el-text`                                                                                                                          | `--font-serif` 700, `clamp(48px,7.5vw,112px)`, lh 0.94, `-0.035em`, `text-balance`                                |
| Lede                                       | paragraph                                                               | `--el-accent-on-surface` (motir.co's hero lede ink)                                                                                  | 500, `clamp(17px,1.45vw,21px)`, `max-w 62ch`                                                                      |
| "See how Motir works →"                    | inline text link                                                        | `--el-text`, underlined (the lede is already the accent ink); focus outline `--el-accent-on-surface`                                 | 16 px 600 (15 narrow), `ArrowRight` size-4                                                                        |
| Idea control                               | form card                                                               | `--el-card` on `--el-border`; focus-within `ring-2` `--focus-ring-color`, offset 2 px                                                | `--radius-card`, `--spacing-card-padding`, `--shadow-elevated`; slot `max-w 760px` (full width narrow)            |
| Idea label                                 | mono label                                                              | `--el-text-secondary`                                                                                                                | 11 px 600 uppercase, `0.1em`                                                                                      |
| Carried label                              | mono label + dot                                                        | text `--el-accent-on-surface`; dot `--el-accent`                                                                                     | dot `rounded-full` size-1.5                                                                                       |
| Textarea + placeholder                     | `<textarea>`                                                            | value `--el-text`; placeholder `--el-text-secondary` (MOTIR-2475)                                                                    | 18 px (17 narrow); min `7.5rem` / `10rem`, max `18rem`; no own radius                                             |
| Card footer + hint                         | row                                                                     | rule `--el-border-soft`; hint `--el-text-secondary` (moved INTO the card, motir.co's place for it)                                   | `pt-(--spacing-md)`, gap 12, `flex-wrap`; hint `mr-auto`, Start `ml-auto`                                         |
| Start / Continue                           | `Button variant="primary"` + `rightIcon` ArrowRight                     | `--el-accent` / `--el-accent-text`; hover `opacity-90`; focus ring `--focus-ring-color`                                              | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`                                                              |
| ~~"OR" divider~~                           | **REMOVED** — the section band is the separation                        | —                                                                                                                                    | —                                                                                                                 |
| ~~Import option row + sky icon tile~~      | **REPLACED by the import section band**                                 | —                                                                                                                                    | —                                                                                                                 |
| **Section band**                           | `OnboardingSection` — `<section>` + SectionHead grid                    | ground `--el-page-bg`; top rule `--el-border` (first band) / `--el-border-soft` (a band stacked on a band)                           | gutter as the hero; `py clamp(48px,7vw,88px)`; head `[1.4fr 1fr]`, gap-x 56, gap-y 16, `items-start`; 1 col < 768 |
| Section title (H2)                         | serif heading                                                           | `--el-text`                                                                                                                          | `--font-serif` 700, `clamp(34px,4.4vw,56px)`, lh 0.98, `-0.03em`                                                  |
| Section body                               | paragraph                                                               | `--el-text-secondary`                                                                                                                | 18 px (17 narrow), `max-w 44ch`                                                                                   |
| "We can vibe it too →" / "← Back to start" | link styled `buttonVariants('secondary','lg')`                          | `--el-text` on `--el-button-border`; hover `--el-surface`; focus ring `--focus-ring-color`                                           | `--radius-btn`, `--height-btn-lg`; gap 20 above                                                                   |

**Why the sections sit on `--el-page-bg` and the hero on `--el-surface`:** the secondary Button's hover
fill IS `--el-surface`, so on a surface ground its hover would paint nothing. The split also makes the
section read as a different, quieter place than the hero.

**The waves never fail the text over them — measured.** The rule is "never under text at a contrast that
fails", so the worst case was computed: each ink against the hero ground with the brightest line at full
alpha mixed in (light 0.13, dark 0.19), in the mock's computed `motir` values:

| ink                             | light: on surface → over a line | dark: on surface → over a line |
| ------------------------------- | ------------------------------- | ------------------------------ |
| `--el-text` (H1)                | 15.45 → 12.81                   | 15.14 → 10.52                  |
| `--el-text-secondary`           | 5.91 → 4.91                     | 7.81 → 5.42                    |
| `--el-accent-on-surface` (lede) | 5.53 → **4.59**                 | 9.05 → 6.28                    |

The light lede over a blue line is the tight pair (4.59:1, AA by 0.09) and it is a 1 px line. **The
integration gate (MOTIR-8238's contrast run) must re-measure this pair in the other nine palettes** — it
is the one most likely to cross; if it does, the remedy is to lower the line alpha, never to change the
lede ink.

### Narrow (~390 px)

Everything stacks: the head of a section drops to one column, the idea box takes the full width, the
footer wraps (hint above, Start at the right end below it), H1 48 px, section titles 34 px. **The wave
lines are CROPPED, not dropped** — the field is laid out for the desktop hero and sliced to the box
(`xMidYMid slice`), so a phone sees the middle of the same field. It stays decorative, and the contrast
table above holds at every width because it is a per-pixel bound.

### Slot → key (every visible product string in the delta)

| slot                           | key                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| H1, default · carried          | `onboarding.entrance.headingDefault` · `headingCarried`                                                                |
| lede, default · carried        | `onboarding.entrance.subheadDefault` · `subheadCarried`                                                                |
| explainer link                 | `onboarding.entrance.howItWorks`                                                                                       |
| idea label · carried label     | `onboarding.entrance.ideaLabel` · `carriedLabel`                                                                       |
| placeholder                    | `onboarding.entrance.placeholder`                                                                                      |
| hint, default · carried        | `onboarding.entrance.hintDefault` · `hintCarried`                                                                      |
| primary CTA, default · carried | `onboarding.entrance.startCta` · `continueCta`                                                                         |
| section title · body · control | `onboarding.entrance.importTitle` · `importDesc` · `importCta`                                                         |
| how-it-works H1 · lede         | `onboarding.howItWorks.title` · `body`                                                                                 |
| the three sections             | `onboarding.howItWorks.sections.{say,watch,decide}.{title,body}`                                                       |
| back control                   | `onboarding.howItWorks.back`                                                                                           |
| wordmark                       | `BrandMark`'s `label` default, "Motir" (the brand name, not catalogue copy — as every other slot in `design/brand` §7) |

**Not product copy:** the pre-filled idea in Panels 2 / 3c / 5 is a fixture of the person's own text
(what the `motir_pending_idea` cookie carries) and has no key by design. Panel captions, the exits line
and the Pattern panel's spec lists are board chrome.

### Findings

- **F1 — `onboarding.entrance.eyebrow` is REMOVED, not relabelled.** MOTIR-8248 reworded it to "Welcome
  to Motir"; this design has no eyebrow at all, so the entrance code card (MOTIR-8253) **deletes the key**
  (in all eleven catalogues) rather than rendering the new value.
- **F2 — `onboarding.entrance.or` has no slot either.** The section band replaces the "OR" divider, so
  that key is orphaned too; MOTIR-8253 deletes it with the eyebrow. (The card named only the eyebrow; this
  is the same removal one row down.)
- **F3 — no key for a pending announcement.** motir.co's brief announces "submitting" through an
  `aria-live` region (`copy.landing.hero.statusSubmitting`). The entrance has no such key and this design
  does not invent one: the pending state is carried by `aria-busy` + `disabled` on the Button. If
  MOTIR-8253 wants the live announcement, it needs a key from the voice card first — a slot without a key.
- **F4 — `--focus-ring-color` is declared on `:root` only.** It is not in the `[data-appearance-scope]`
  re-emission, so a nested dark scope keeps the LIGHT ring (`#155bc4`) instead of the dark `#7db1ff`. The
  app is unaffected (`<html>` carries the theme), but a mock or the onboarding Design step's preview
  inherits the wrong ring. The delta re-points it to `--el-accent-on-surface` inside each scope so the
  drawn ring is the one the app paints. Out of scope here; worth a one-line fix in `theme.css`.
- **F5 — why the section band is product-local, not a package proposal.** Its shape is generic, but its
  rhythm is motir.co's marketing rhythm, which a scaffolded product should not inherit by default. If a
  second, non-onboarding Motir surface adopts it, promote it then.
- **Chinese-length risks** (the Chinese card, MOTIR-8249, draws the strings; this design flags the slots):
  the **96 px H1** — a CJK headline does not hyphenate and `text-balance` cannot split inside a word, so a
  long `headingCarried` wraps to three lines at 1280 and must be checked at 390 (48 px); the **idea-card
  footer**, where a long `hintCarried` already pushes the CTA to its own row in English (that wrap is the
  designed behaviour, not a defect); the **secondary button `importCta`** (`whitespace-nowrap` — a long
  value widens the button, which is fine at desktop and must stay under ~340 px at 390); and the **mono
  uppercase labels** (`ideaLabel` / `carriedLabel`), where `uppercase` and `0.1em` tracking do nothing for
  CJK and the label will read heavier than in English — acceptable, flagged.

### Allocation sweep — every card the delta and this section name

| card                                       | GIVES / TAKES                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-8253** (entrance code)             | **TAKES** the eyebrow chip (and its `eyebrow` key, F1), the "OR" divider (`or` key, F2) and the centred `max-w-[41.25rem]` column; GIVES it the new layout to render for both screens |
| **MOTIR-8252** (foundation code)           | **GIVES** the primitives: `BrandMark` in the onboarding chrome, `OnboardingHero`, `HeroWaves`, `OnboardingSection` (Pattern panel A–C)                                                |
| **MOTIR-8251** (migrate / importer design) | **GIVES** the pattern (Pattern panel), which it composes and does not redraw                                                                                                          |
| MOTIR-8248 (English voice)                 | TAKES its strings verbatim as the premise; gives back F1–F3                                                                                                                           |
| MOTIR-8249 (Chinese voice)                 | GIVES the Chinese-length risk list above                                                                                                                                              |
| MOTIR-8238 (story)                         | GIVES the integration gate the `--el-*` role of every element and the one tight pair to re-measure across palettes                                                                    |
| MOTIR-1461                                 | amended (this section); its mock stays the record                                                                                                                                     |
| MOTIR-4370                                 | ruling KEPT; its width premise retired                                                                                                                                                |
| MOTIR-1458                                 | premise only — the carried idea and its cookie, unchanged                                                                                                                             |
| MOTIR-2475                                 | premise only — the placeholder ink stays `--el-text-secondary`                                                                                                                        |
| MOTIR-6470 / MOTIR-6471                    | premise only — the default `motir` palette drawn                                                                                                                                      |

### Revision 1 (2026-10-12) — drawings, a new-tab explainer, and the motir.co link-out

**The review (Mo, "Request changes", verdict `revise`, on `b3b534e`):**

> "add some drawing like motir.co/how-it-works in app.motir.co how motir works page, for each section.
> how it works page of app.motir.co should open in a new tab, and add the link section like motir.co
> landing page to link to motir.co/how-it-works"

The version was refused before approval, so the delta mock
[`onboarding-entrance--vibe-layout.mock.html`](./onboarding-entrance--vibe-layout.mock.html) is revised
**in place** (no second delta); `onboarding-entrance.mock.html` is still byte-identical to `main`.
Everything in the 2026-10-11 section above stands except where this subsection says otherwise.

**motir.co read for this revision**, `motir-marketing` `origin/main` **`0c2e37b`** (re-fetched; unchanged):
`motir-marketing/app/[locale]/how-it-works/page.tsx` and
`motir-marketing/app/[locale]/how-it-works/_components/ModuleArt.tsx` (each module beside a flat colour
field holding a small example screen, `aria-hidden`, `h-[300px]`, `--radius-card`, `--shadow-card`); the
landing's closing block in `motir-marketing/app/[locale]/page.tsx` (`data-showcase="field"`, a centred
`H2` + body + buttons on `--el-showcase-field`, the developers' door in the warm
`--el-showcase-decision` fill linking to `https://motir.co/how-it-works`); and the landing's `SayArt` / `WatchArt` /
`DecideArt` in `motir-marketing/app/_components/landing/Art.tsx`, which draw the same three beats.

#### What changed

1. **Each how-it-works section band carries a drawing** (Panels 4 and 5, light and dark). The band
   becomes two columns at desktop (title + body left, drawing right, `items-center`, gap-x 56) and one
   column narrow (drawing under the body). The drawings are motir.co's ModuleArt idiom — a tinted field
   holding a small example screen — with one deliberate departure: **they are wordless.** motir.co's
   pictures carry example copy from its own catalogue (`howItWorks.art.*`); in-app that would be a set
   of strings with no keys, so the screens are drawn with skeleton bars instead, and the heading and
   body beside each one carry the meaning. Each is `aria-hidden="true"`, so no text in them is measured
   and none is rendered.

   | drawing | field                | what it shows                                                                                                                                       | tokens                                                                                                                                                                                                             |
   | ------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | Say     | `--el-tint-sky`      | a few lines typed (with a caret), Motir asking back (the `BrandMark` mark, 14 px), three answer chips, one picked                                   | papers `--el-card` / `--el-border` / `--shadow-subtle`; bars `--el-border-strong`; caret `--el-accent-on-surface`; picked chip `--el-accent`; chips `--radius-badge`                                               |
   | Watch   | `--el-tint-lavender` | a plan tree filling in (Motir's rows `--el-accent-on-surface` squares, the person's row `--el-showcase-decision`), a design frame, a progress strip | ticks `--el-success`; open rows `--el-border-strong` rings; frame block `--el-tint-sky`; track `--el-border`, fill `--el-accent-on-surface`; `--radius-control`                                                    |
   | Decide  | `--el-tint-peach`    | a finished piece back for review: title bar, preview, a secondary and an Approve shape, the decision marker                                         | title bar `--el-text-secondary`; preview `--el-surface`; secondary shape `--el-button-border` on `--el-card`; Approve `--el-accent` + check in `--el-accent-text`, `--radius-btn`; marker `--el-showcase-decision` |

   Every field takes `--radius-card`, `--spacing-card-padding`, `--shadow-card`, `--el-border`; height
   248 px (208 narrow). No hue is invented: every fill is an existing `--el-*` token, and the three
   fields are three different tint slots so they read apart in every palette.

2. **"See how Motir works" opens `/onboarding/how-it-works` in a NEW TAB.** `target="_blank"
rel="noopener"`, the trailing glyph changes from `ArrowRight` to **`ArrowUpRight`** (the new-tab
   affordance motir.co's chrome uses), and a visually hidden `sr-only` span appends "(opens in a new
   tab)" to its accessible name. Drawn in Panels 1, 2 and 5 and in close-up **3f** (rest · hover —
   underline drops · focus-visible — `--el-accent-on-surface` ring). Why a new tab is right here: the
   entrance holds an idea the person may be half-way through typing, and nothing saves it; a new tab
   keeps it on screen.
3. **"Back to start" on a page opened in a new tab — the ruling.** Same label, same `ArrowLeft`, same
   secondary `Button`. **It closes this tab** (`window.close()`), which returns the person to the entrance
   tab with their idea intact; a tab opened by a `target="_blank"` link has a one-entry history and is
   script-closable. **Where the tab cannot be closed** — a direct visit, a reload that grew the history,
   a browser that refuses — it **navigates to `/onboarding`** (its `href`, so it also works without
   script). It is never removed: the page must stay leavable when it was not opened from the entrance.
   Marked `data-closes-tab` in the mock.
4. **A link-out section to motir.co** sits after the three section bands and before Back (Panels 4 and
   5): motir.co's landing closing block, adapted — an inset `--el-showcase-field` card (`--radius-card`,
   `--shadow-card`, padding `2 × --spacing-card-padding`), a centred serif H2 and body in
   `--el-showcase-field-text`, and ONE warm button in `--el-showcase-decision` /
   `--el-showcase-decision-text` (`--radius-btn`, `--height-btn-lg`, `--spacing-btn-x`) linking to
   **`https://motir.co/how-it-works`**, `target="_blank" rel="noopener"`, `ArrowUpRight`, sr-only
   "(opens in a new tab)". Close-up **3g** draws rest · hover (`brightness-105`, motir.co's) · focus
   (`--el-showcase-field-text` ring). Measured in the mock's computed `motir` values: field-text on
   field **6.31:1** light / **6.34:1** dark; decision-text on decision **4.65:1** / **5.89:1**. The
   button's fill against the field is 1.66 / 2.23:1 — under 3:1, and acceptable because the label, not
   the fill edge, identifies the control (motir.co ships the same pair); the integration gate should
   re-measure the 4.65 pair across palettes.

#### Parts table — additions

| part                                                                     | disposition                                                                                                      | built by                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`SectionArt`** (the tinted field + paper + skeleton bar kit)           | **product-local component** — a drawing vocabulary for Motir's own explainer; nothing a scaffolded product needs | **MOTIR-8252** (foundation primitives), with `OnboardingSection` gaining an optional `art` slot |
| **`SayArt` · `WatchArt` · `DecideArt`**                                  | **product-local components** — the three wordless drawings, composed from `SectionArt`                           | **MOTIR-8253** (the screen)                                                                     |
| **`OnboardingLinkOut`** (the showcase-field band + warm external button) | **product-local component** — motir.co's closing-block shape, pointed outward                                    | **MOTIR-8252** (primitive); placed on how-it-works by **MOTIR-8253**                            |
| `BrandMark variant="mark"` (inside Say)                                  | `@motir/brand`, as is                                                                                            | —                                                                                               |

Still nothing is proposed for `@motir/design-system`.

#### Slot → key — what the table now says

The 2026-10-11 table stands (the "See how Motir works" slot keeps `onboarding.entrance.howItWorks`), plus
**five NEW keys this revision specifies**. They are drawn verbatim in the mock and are **not in
`messages/en.json`**: MOTIR-8248 (English) and MOTIR-8249 (Chinese) have already landed without them.
**MOTIR-8253 must add all five in all eleven catalogues** before rendering these slots — or, if the plan
prefers the voice cards to own every string, a correction re-opens MOTIR-8248 / 8249 for them. Either
way this is a finding, not a slot to fill with an ad-hoc literal. The zh suggestions take motir.co's own
zh vocabulary where it has one (`landing.close.developers`, `howItWorks.lede`) and the existing
`platformAdmin.ideas.detail.newTab` wording.

| slot                          | NEW key                                   | en                                                                                                                                                                  | zh (suggestion)                                                                                           |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| entrance link, sr-only hint   | `onboarding.entrance.howItWorksNewTab`    | (opens in a new tab)                                                                                                                                                | （在新标签页中打开）                                                                                      |
| link-out H2                   | `onboarding.howItWorks.developers.title`  | How Motir works, for developers                                                                                                                                     | 面向开发者：Motir 的工作方式                                                                              |
| link-out body                 | `onboarding.howItWorks.developers.body`   | Every Motir project runs through the same instrument: the modules are Motir and its agents, and the switches are yours. motir.co walks through it module by module. | 每个 Motir 项目都运行在同一台“仪器”上：模块是 Motir 和它的智能体，开关属于你。motir.co 会逐个模块讲清楚。 |
| link-out button               | `onboarding.howItWorks.developers.cta`    | Read it on motir.co                                                                                                                                                 | 到 motir.co 阅读                                                                                          |
| link-out button, sr-only hint | `onboarding.howItWorks.developers.newTab` | (opens in a new tab)                                                                                                                                                | （在新标签页中打开）                                                                                      |

The drawings carry no strings. **Chinese-length risk added:** the link-out H2 at 48 px (32 narrow) —
the zh title has a full-width colon and no break opportunity before it; check it wraps cleanly at 390.

#### GIVES / TAKES — what the sweep now says

| card                    | now                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-8253**          | TAKES as before (eyebrow, OR divider, centred column). **GIVES additionally:** the three drawings on how-it-works, the new-tab entrance link, the Back-to-start close-or-navigate ruling, the link-out placement, and the five NEW keys to add (all eleven catalogues) |
| **MOTIR-8252**          | GIVES as before, **plus** `SectionArt` (and `OnboardingSection`'s `art` slot) and `OnboardingLinkOut`                                                                                                                                                                  |
| **MOTIR-8251**          | GIVES the pattern as before; the `art` slot and the link-out band are now part of it, available to the migrate wizard and importer if they want them                                                                                                                   |
| MOTIR-8248 / MOTIR-8249 | premise unchanged; they do **not** carry the five new keys — a correction is needed only if the plan wants the voice cards to own them rather than MOTIR-8253                                                                                                          |
| MOTIR-8238              | GIVES the integration gate one more pair to re-measure across palettes: `--el-showcase-decision-text` on `--el-showcase-decision` (4.65:1 in light `motir`)                                                                                                            |

### Revision 2 (2026-10-12) — the language control in the brand bar (MOTIR-8286)

**The request.** Xing (project owner): put a language control on the onboarding brand bar. That is
a new code card, **MOTIR-8286**. The control is the one the signed-out frame already ships:
`AuthLanguageControl` (`components/i18n/AuthLanguageControl.tsx`, moved there by MOTIR-8253), drawn in
`design/auth/auth-frame--language-control.mock.html` and specified in `design/auth/design-notes.md`
§ _The language control on the signed-out frame_. **This revision invents nothing.** The anatomy,
the tokens, the copy and the behaviour are that control's. The mock is revised in place again
(this version is unapproved), and `onboarding-entrance.mock.html` is untouched.

#### Placement

The control goes at the **trailing end of the hero brand bar, opposite the `BrandMark` lockup**.
The bar is already `flex items-center justify-between`: the lockup is its first child and the
control is its second. It is in the DOM and the tab order directly after the lockup, before the
heading, and it is on screen at first paint. It appears on every screen that carries the bar:

- the entrance, default (Panel 1) and carried-over (Panel 2);
- how-it-works (Panel 4);
- the 390 px panels (Panel 5).

Every panel is drawn in light and dark. Pattern A now specifies the bar with the control in it.
**Close-up 3h** draws the four states side by side with the auth mock: rest, pending, failed, and
open with the eleven endonyms.

The control carries its own `--el-page-bg` fill, so no ink sits on the hero's `--el-surface` ground.
This is the same argument the auth notes make for the wash. `--el-text-muted` and `--el-text-faint`
are used nowhere in the control.

**At 390 px nothing collapses.** I measured in Chromium against this mock's 390 px entrance frame:

| item                           | figure                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| lockup                         | ends at x 104.8                                                                            |
| trigger, "English"             | 117.7 × 36, the same 117.7 the auth notes measured; starts at x 255.3, 17 px from the edge |
| gap between lockup and trigger | 150 px                                                                                     |
| trigger, longest endonym       | 146.4 px wide with "Nederlands" (Português 138.0, 日本語 112.0)                            |
| gap at the longest endonym     | still about 122 px                                                                         |

So the full control fits beside the lockup at 390 px: the `Languages` glyph, the endonym and the
chevrons. **The label does not need to collapse to glyph plus endonym.** It already is the glyph
plus the endonym: the accessible name `auth.language.label` is never visible text. The failed line
hangs under the trigger exactly as on the auth frame (`absolute top-full right-0`, it wraps below
`sm`), over the hero's top padding, and it moves nothing.

#### Behaviour — `AuthLanguageControl`'s, unchanged

A choice runs `setLocale` (`lib/i18n/actions.ts`) inside a transition, then **`router.refresh()` —
never a push, a replace, a redirect or a reload.** The refresh re-renders the server components in
the new language and keeps every client component mounted. **That is what keeps the idea the
person has typed.** `OnboardingEntrance` is a client component, and its textarea is uncontrolled
(`defaultValue`), so the typed text lives in the mounted DOM node, and a refresh does not remount
it. The carried-over idea and every query parameter survive the same way. A remount would lose
the typed text.

Pending, failed and superseded choices behave exactly as on the auth frame:

- **Pending:** `aria-busy`, a spinner in the chevron's slot, and a polite sr-only "Switching to
  {language}…". Nothing is disabled and nothing moves.
- **Superseded:** a newer choice is guarded by a sequence number, so an older response cannot
  repaint over it.
- **Failed:** no refresh, the page stays in its current language, and a quiet line offers Try
  again.

**One difference in context, none in code.** Onboarding is signed in: the `(onboarding)` layout
redirects a signed-out visitor to `/sign-in`. So here `setLocale` also **saves the account
language**, as it already does on the auth frame's signed-in routes (re-consent, 2FA-required,
OAuth consent). That is correct: the person is choosing the language of the product they are about
to use. The control does not read the session and does not branch on it.

#### Parts table — addition

| part                                                                         | disposition                                                                                                                                                                                                                                                                                                                                                                                                     | built by       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **the language control** — `AuthLanguageControl` over the package `Combobox` | **reuse, unchanged.** It is placed in the trailing end of `OnboardingHero`'s brand bar on the entrance and on how-it-works. It currently lives in the `(auth)` route group's private `_components/` folder. Whether MOTIR-8286 imports it across groups or lifts it to a shared home first (one component, two mounts) is a build decision. The design only requires that it be the same component, not a copy. | **MOTIR-8286** |
| `Combobox` (`w-auto`, `align="end"`, `busy`, `triggerIcon`)                  | `@motir/design-system`, as is                                                                                                                                                                                                                                                                                                                                                                                   | —              |

**MOTIR-8251 draws the same control in `OnboardingTopBar`.** The migrate wizard's and the
importer's top bar carries it at the same trailing end, opposite the lockup. It has the same states
and the same refresh-not-navigate behaviour, so every page-shaped onboarding screen offers the
language in the same place. Still nothing is proposed for `@motir/design-system`.

#### Slot → key — the rows this revision adds

All of these are existing `auth.language.*` keys and the `localeLabel` endonyms, reused verbatim.
**No new key is needed.**

| slot                                                          | key                                                   | en                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| trigger's accessible name, and the listbox's                  | `auth.language.label`                                 | Language: {language}                                                                                         |
| pending sr-only status                                        | `auth.language.switching`                             | Switching to {language}…                                                                                     |
| failed line                                                   | `auth.language.failed`                                | Couldn’t change the language.                                                                                |
| failed line's button                                          | `auth.language.retry`                                 | Try again                                                                                                    |
| trigger value and the eleven options (each in its own `lang`) | `localeLabel` (`lib/i18n/locales.ts`), not translated | English · 中文 · 日本語 · 한국어 · Deutsch · Français · Español · Italiano · Nederlands · Polski · Português |

**Findings on the keys.** No string reads wrong in onboarding: none of the four mentions signing in
or the signed-out pages. The only oddity is the namespace. An `auth.*` key now renders on a
signed-in surface. That is harmless, because the root layout passes the whole catalogue to
`NextIntlClientProvider`, so no message pruning hides it. A rename to a neutral namespace would
churn eleven catalogues and the auth frame's tests for no change a reader sees. **Recommendation:
keep the keys.** If MOTIR-8286 lifts the component to a shared home, it may move the keys with it,
as its own call.

**A drafting note against the auth notes.** Their per-element table gives the active option an
inset `--focus-ring-color` ring, but the shipped `Combobox` paints only `--el-option-active-bg`.
This mock follows the shipped primitive. That is a stale line in the auth notes, not a change to
the control.

#### GIVES — what the sweep now says

| card           | now                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-8286** | **GIVES:** mount `AuthLanguageControl` (the same component; import it or lift it) at the trailing end of the brand bar on `/onboarding` and `/onboarding/how-it-works`. Keep its `setLocale` → `router.refresh()` behaviour, and assert in a test that an idea typed in the box survives a switch. It needs no new keys, and it does not need to collapse at 390 px. |
| **MOTIR-8251** | **GIVES additionally:** the same control at the same trailing end of `OnboardingTopBar`, for the migrate wizard and the importer                                                                                                                                                                                                                                     |
| MOTIR-8252     | unchanged. The brand bar's second slot is a plain child of `OnboardingHero`'s header, not a new primitive.                                                                                                                                                                                                                                                           |

## 2026-10-21 — onboarding refinements: an Import project button, no idea-box highlight, a coloured way back (MOTIR-8934)

**Design system — files read:** `package.json` (`"@motir/design-system": "workspace:*"`),
`app/globals.css` (`@import '@motir/design-system/theme.css'`), `app/layout.tsx` (stamps `data-style` /
`data-palette` / `data-type`), `packages/design-system/package.json` (version 0.15.1, which exports
`@motir/design-system/mock`). **Verdict: ON MOTIR DESIGN — branch (a).** Axes drawn: `warm-editorial` ·
`motir` · `motir`, the same axes the two amended mocks wear. The mock is built with `renderMock`: the
unchanged surfaces are the shipped vibe-layout panels, the Import project link and the pending Start
are the package's own `buttonVariants` / `Button` (`loading`), and Tailwind is compiled over the
markup. No part is proposed for `@motir/design-system` and nothing new is product-local.

**Amends:** § _2026-10-11 — the vibe layout_ above (`onboarding-entrance--vibe-layout.mock.html`,
panels 1, 2 and 5) and `design/onboarding-migrate/design-notes.md` § _2026-10-12_ (the wizard bar in
`onboarding-migrate--vibe-layout.mock.html`, panels 1a and 10). Both older mocks are records and are
not edited. **Delta mock:**
[`onboarding-entrance--refinements.mock.html`](./onboarding-entrance--refinements.mock.html). Story
MOTIR-8933; build card MOTIR-8935, which waits on this design.

**Answers the sent-back draft.** The 2026-10-18 draft (refused: _"I don't see the import project button
added, the design doesn't show the button location"_) tucked a small button into the brand bar and drew
the entrance as a hand-made sketch. This draft draws the whole shipped page with the import door in
place in panels 1, 2 and 6, as a row inside the idea card (Revision 1 under Change 1).

**Shipped reality read:** `components/onboarding/OnboardingEntrance.tsx` (the import
`OnboardingSection`, the form's `focus-within:ring-2 … ring-offset-2` and the textarea's `autoFocus`),
`components/onboarding/layout/OnboardingWizardBar.tsx` (`BAR_SECONDARY_HOVER`),
`app/(onboarding)/onboarding/migrate/_components/MigrateWizard.tsx` (the `secondary` `sm` link carrying
`brandBar.planAi`), and `messages/en.json` (`onboarding.entrance.import{Title,Desc,Cta}`,
`onboardingMigrate.brandBar.planAi`).

### Change 1 — `/onboarding`: the "Already have a project?" band becomes an import row inside the idea card

**Revision 1 (Yue, 2026-10-21, on the gate):** _"Add a row under the "Start" button, make it a part of
the panel, add text "Already have a project" and "Import project" button, give import project button a
color like motir.co."_ The first version of this section put a plain secondary button under the card;
this replaces it.

- **Removed:** the whole import `OnboardingSection` band below the hero: its head, its lede and its "We
  can vibe it too" button. The page now ends with the hero. Keys `importDesc` and `importCta` become
  unused (MOTIR-8935 removes them); `importTitle` ("Already have a project?") is reused by the row.
- **Placement:** a new LAST row of the idea card (the `<form data-surface="card">`), directly under the
  hint + Start footer, divided from it by the same `border-t border-(--el-border-soft) pt-3` hairline
  the footer uses. It is part of the card, not a sibling of it.
- **Leading:** the text **"Already have a project?"** (`onboarding.entrance.importTitle`), 15 px,
  semibold, `--el-text-strong` (15.59:1 light / 13.76:1 dark on `--el-card`).
- **Trailing, right-aligned under Start (`ml-auto`):** an **"Import project"** `Link` to
  `/onboarding/migrate` (new key `onboarding.entrance.importProject`), `buttonVariants({ size: 'md' })`,
  the same size as Start, with a trailing `ArrowRight` `size-4` (`aria-hidden`).
- **Colour, as motir.co:** the motir.co hero's own "Already have a project? · Import project" door
  (the motir-marketing repository's landing page, its `data-hero-existing` paragraph) wears the palette's warm decision
  fill. The same classes: `border-transparent bg-(--el-showcase-decision)
text-(--el-showcase-decision-text) hover:bg-(--el-showcase-decision) hover:brightness-105`. Label
  contrast on the fill: **4.65:1** light, **5.89:1** dark. It is the entrance's one warm element (Start
  stays the ink primary), the same split motir.co draws.
- **Focus-visible:** the package's 2 px `--focus-ring-color` ring, unchanged.
- **Narrow (390 px):** the row wraps like the footer above it, the text on its own line and the button
  under it at the trailing edge.
- **States:** at rest, while the idea box is focused, and while Start is pending (panel 2c: Start shows
  its spinner and is disabled, the box dims, the import row stays enabled, since leaving to import
  is fine mid-submit).
- **Carried-idea panel (3): no import row**, unchanged. An idea in hand means starting fresh (the
  MOTIR-4370 ruling).

### Change 2 — `/onboarding`: the idea box loses its highlight

The highlight is the form's `focus-within:ring-2 ring-(--focus-ring-color) ring-offset-2`, shown from
page load because the textarea has `autoFocus`.

- **No ring at rest and none on focus.** The card keeps what already made it the primary control: the
  hero's only raised surface (`--el-card` on `--el-surface`, a 1 px `--el-border` hairline,
  `--shadow-elevated`) with the page's one primary button, Start, inside it.
- **`autoFocus` stays.** With nothing lighting up, focusing the box on load costs nothing visually and
  keeps "land and type".
- **Keyboard focus:** when the TEXTAREA has focus the card's border steps from `--el-border` to
  `--el-border-strong` (key it on the textarea, e.g. `has-[textarea:focus]:`, not on `focus-within`,
  because the import row's button now sits inside the same form), and the caret blinks in the box.
  That is the only focus cue on this control.
- **Accessibility trade-off, recorded:** the border step measures 1.27:1 → 1.61:1 against the card in
  light (1.78:1 in dark), so it is not a 3:1 focus outline. The control meets WCAG 2.4.7 (focus
  visible) through the caret and the border change, not the stricter 2.4.13 focus-appearance bar
  (AAA). Every other control on the page keeps its focus ring.

### Change 3 — `/onboarding/migrate`: "Start from an idea instead" gets a colour

- **Position unchanged:** the wizard bar's trailing group, the first control after the flow name and
  before Save & exit (at 390 px, the bar's third row, before Save & exit). Panels 4 and 6 draw the
  whole first screen around it.
- **Shape unchanged:** `secondary` `sm`, label and trailing `ArrowRight` `size-3.5` as today.
- **Colour:** ink AND border `--el-accent-on-surface`, the accent ink the lockup and the hero lede
  already wear on this screen. Save & exit stays a plain ghost, so this is the one coloured control in
  the bar.
- **Hover:** fill `--el-tint-sky` (the accent's own tint), ink and border unchanged. This replaces
  `BAR_SECONDARY_HOVER` on this one link. **Focus-visible:** the package's 2 px `--focus-ring-color`
  ring with its 2 px offset, unchanged.
- **Contrast, measured** in the rendered mock (`motir` palette): `--el-accent-on-surface` is
  **5.53:1** on the hero's `--el-surface` and **6.31:1** on the page ground in light, **9.05:1** and
  **10.01:1** in dark. On the hover fill `--el-tint-sky` it is **5.13:1** light and **8.11:1** dark.
  All clear 4.5:1.

### Per-element tokens (changed elements only)

| Element                       | Colour (`--el-*`)                                                                                              | Shape                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Already have a project? (row) | ink `--el-text-strong`; row rule `--el-border-soft`                                                            | card row, `pt-3`                                               |
| Import project                | fill `--el-showcase-decision`, ink `--el-showcase-decision-text`, `border-transparent`; hover `brightness-105` | `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`           |
| Idea card, rest → focused     | `--el-card`, border `--el-border` → `--el-border-strong`, **no ring**                                          | `--radius-card`, `--spacing-card-padding`, `--shadow-elevated` |
| Start from an idea instead    | ink + border `--el-accent-on-surface`; hover fill `--el-tint-sky`; ring `--focus-ring-color`                   | `--radius-btn`, `--height-btn-sm`                              |

### Panels

1 `/onboarding` default, light and dark, 1280 px · 2 the idea card at rest, focused (typing) and Start
pending, light | dark · 3 `/onboarding` carried idea, light and dark, 1280 px (unchanged, no Import
project) · 4 `/onboarding/migrate` first screen, light and dark, 1280 px · 5 "Start from an idea
instead" at rest, hover and focus-visible, light | dark · 6 narrow 390 px, both pages, light | dark.
