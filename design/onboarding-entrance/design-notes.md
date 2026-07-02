# Onboarding entrance — the new-vs-existing fork (`design/onboarding-entrance/`)

**Subtask:** MOTIR-1461 · 7.22.3 (`type: design`) · **Story:** MOTIR-1459 (Onboarding entrance — the
new-vs-existing front door & routing) · **Epic 7 · AI Planning Layer.**

The single top-level CHOICE the user makes at `/onboarding`, drawn as one surface:

- **Start fresh — describe your idea** → the done 7.3 discovery flow (MOTIR-804).
- **I have an existing project — import it** → the 7.15 migrate wizard (MOTIR-815 / MOTIR-930) or 7.17
  Jira / Linear / Plane import (MOTIR-817).

**Scope (deliberately SLIMMED, per the card):** the FORK ONLY. This screen draws the choice, the
carried-over idea box, and a legible preview of each destination — then hands off. **It draws NO
repo-connect, source-selection, index, or generate UI**; all of that lives downstream in 7.15 / 7.17
and is owned by their own designs (MOTIR-930). Re-drawing it here would duplicate 7.15.

**Asset files (three, shared basename):** `design-notes.md` (this file) · `onboarding-entrance.mock.html`
(source of truth, standalone — re-states the real `globals.css` `--el-*` values so it renders without
the Tailwind build, exactly as `design/ai-planning/*.mock.html` does) · `onboarding-entrance.png`
(full-page export, light theme, `deviceScaleFactor: 2`).

---

## Designed against shipped reality

Rendered and read the shipped surfaces this fork sits between before drawing (design-against-shipped-
reality; the mock reuses their real structure, it does not redraw a stylised stand-in):

- **`app/(onboarding)/layout.tsx`** — the onboarding route group renders **OUTSIDE** the `(authed)`
  `AppLayout` (no top nav, no project sidebar) but is still **authenticated** (gates the session, bounces
  a signed-out visitor to `/sign-in`). So the fork owns the whole viewport with only a minimal brand bar
  — matched exactly.
- **`app/(onboarding)/onboarding/page.tsx`** — today `/onboarding` renders `DiscoveryOnboarding`
  DIRECTLY (start-fresh). This story inserts the fork BEFORE that; MOTIR-1462 (the router) makes
  `/onboarding` render this fork and route start-fresh → `DiscoveryOnboarding` (seeded with the preserved
  idea) / existing → the 7.15 wizard.
- **`app/_components/PublicFrontDoor.tsx`** (7.3.14 / MOTIR-1022, the marketing hero) — the SOURCE of the
  "Start fresh" idea. This fork **reuses its exact vocabulary**: the `Sparkles` "Plan with AI" eyebrow
  chip on `--el-tint-lavender`, the **serif** headline (`font-serif`), the idea-capture `Card` +
  `textarea` + `ArrowRight` primary `Button`, and the tinted-icon-square + 3-step preview
  (Understand · Scope · Plan). The carried-over idea (Panel 2) is the hero's typed idea preserved by
  MOTIR-1458 (`lib/onboarding/pendingIdea.ts`) and pre-filled here.

## Access path (entry + the two exits)

- **INBOUND (owned by sibling cards — drawn there, not redrawn here):** (a) the first-login / marketing
  door — motir-core root → `/login` → **"Plan with AI"** → `/onboarding` (MOTIR-1457); (b) the IN-APP
  door — an authenticated user picks **"Plan with AI"** in the create-project modal / switcher /
  empty-project state (design MOTIR-1485, code MOTIR-1486). Both land on THIS fork.
- **OUTBOUND (drawn here — the point of the card):** each option's destination is made legible with a
  "NEXT:" caption + a chip stepper, so the reader SEES where the door leads before choosing:
  - Start fresh → **Understand · Scope · Plan** (the discovery conversation; MOTIR-804 / 7.3.5).
  - Existing → **Connect repo · Read your code · Plan** (the guided import wizard; a simplified preview of
    MOTIR-930's step rail — NOT the wizard itself).

---

## Surfaces / panels (inspect every panel)

### Panel 1 — the fork, default (arrived without a carried-over idea)

Reached via the in-app "Plan with AI" door or a direct `/onboarding` visit (no hero idea in the cookie).

- **Brand bar** — `Motir` wordmark (`Sparkles` logo tile on `--el-tint-lavender`) left; a **"Save & exit"**
  ghost link + a signed-in avatar right. _(The exit/resume affordance is formalised by MOTIR-1488; drawn
  here as realistic authenticated-shell chrome, not implemented by this card.)_
- **Header** — the "Plan with AI" eyebrow chip; serif H1 **"How would you like to start?"**; secondary
  subhead _"Motir can plan a brand-new idea from scratch, or read an existing codebase and plan on top of
  what you already have. Pick a starting point — you can switch later."_
- **Two choice cards** — an ASYMMETRIC grid (`1.55fr 1fr`): **Start-fresh is the wider, primary column**
  because it carries the idea box, which is **generously sized (min-height ~156px, 6 rows) for a long
  first message** — a first idea is often several sentences, so the input must give it real room.
  Existing is the narrower secondary card (no input). Start-fresh carries the default selection ring.
  - **A — Start fresh — describe your idea.** Lavender icon square (`Sparkles`); lede _"Tell Motir what
    you want to build in a sentence or two. We'll turn it into a reviewed, dispatchable backlog."_; the
    tall **idea box** (empty, focused — placeholder invites a full description, e.g. a hair-salon booking
    app, and reassures _"we'll ask follow-up questions next"_); the destination stepper; primary CTA
    **"Start planning →"**.
  - **B — I have an existing project — import it.** Sky icon square (`GitBranch`); lede _"Connect your
    repository and Motir reads your code, then plans on top of what's already there. You can also bring
    over existing work items from Jira, Linear or Plane."_; the destination stepper; subnote _"GitHub or
    GitLab · optionally import existing work items from Jira, Linear or Plane."_; secondary CTA
    **"Import a project →"**.
- **Footer microcopy** — _"Not sure? Start fresh is the quickest way in — you can connect a repo to any
  project later."_

### Panel 2 — the fork with a carried-over idea (MOTIR-1458 / 7.22.2)

The state after the user typed an idea on the motir.co hero and signed in. Header swaps to **"Ready when
you are"** / _"We kept the idea you started with. Edit it here, or import an existing project instead."_
The Start-fresh idea box is **pre-filled** with the preserved idea and carries a **"Carried over from your
idea"** accent label (a `--el-accent` dot + text). Its CTA becomes **"Continue with this idea →"**. Option
B is unchanged except its lede acknowledges the saved idea (_"…your idea stays saved if you switch
back."_).

### Panel 3 — states & behaviour (close-ups)

- **Selection & keyboard** — each option is a focusable control; the chosen one carries the `--el-accent`
  ring, the idea box shows its own focus ring. _"Tab moves between the two options and the idea box · Enter
  / Space activates the CTA."_
- **Empty idea + reachability** — two info callouts: (1) **"Start planning" works with an empty idea** —
  the discovery chat opens and asks the first question; the idea box is a head-start, not a gate. (2) **This
  screen only ROUTES** — start-fresh → the 7.3 discovery chat (seeded); existing → the 7.15 migrate wizard
  (or 7.17), which owns connect → source-selection → index → generate. Nothing here connects a repo.

---

## Primitives composed (no hand-rolling)

| Element                 | Shipped primitive / pattern                                                 | Token role                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Choice card             | `Card` (`components/ui/Card.tsx`)                                           | `--el-card` bg, `--el-border`, `--radius-card`, `--spacing-card-padding`; selected = `--el-accent` ring + `--shadow-elevated` |
| Idea input              | `textarea` in a `Card`, reused from the 7.3.14 hero                         | `--el-surface-soft` fill, `--radius-input`, focus `--focus-ring-color`                                                        |
| Primary / secondary CTA | `Button` (`variant="primary"` / `"secondary"`, `rightIcon={<ArrowRight/>}`) | primary `--el-accent` / `--el-accent-text`; secondary `--el-button-border` + `--el-text`; `--radius-btn`, `--height-btn-md`   |
| "Plan with AI" eyebrow  | badge chip (as on the hero)                                                 | `--el-tint-lavender` bg, `--el-text-strong` text, `--radius-badge`, `--spacing-chip-x/y`                                      |
| Destination step chip   | inline pill                                                                 | `--el-surface-soft`/`--el-muted` bg, `--el-border`, `--el-text-secondary`; icon `--el-text-muted`; `--radius-badge`           |
| Icon tile (per option)  | tinted square (as on the hero preview)                                      | A: `--el-tint-lavender`; B: `--el-tint-sky`; ink `--el-text-strong`; `--radius-control`                                       |
| Info callout (Panel 3)  | callout box + `Info`/`GitBranch` lucide                                     | `--el-surface-soft`, `--el-border`, `--radius-input`; icon `--el-info`                                                        |
| Carried-over label      | inline label + dot                                                          | `--el-accent-on-surface` text + dot                                                                                           |
| Avatar                  | circular chip                                                               | `--el-tint-mint` bg, `--el-text-strong` ink, `rounded-full`                                                                   |

Icons are **lucide** (`Sparkles`, `Search`, `Shapes`, `Network`, `GitBranch`, `Code`, `ArrowRight`,
`Info`, `GitBranch`) at `viewBox="0 0 24 24"`, stroke 2, round caps — matching the shipped hero.

### Colour + shape rules (mock === component)

- Every colour resolves to an `--el-*` / `--color-*` palette token (the mock re-states their light /
  warm-editorial / motir VALUES). **No invented hues** on any card / pill / state / text — the only raw
  values are non-semantic elevation shadows and the doc-annotation scaffold chrome (panel captions / ref
  chips), which are not product UI.
- Shape flows through element-semantic tokens (`--radius-card`/`-btn`/`-input`/`-badge`/`-control`,
  `--spacing-card-padding`, `--height-btn-md`) — never a raw `rounded-md`/`p-2`/`h-9`, so a `data-style`
  swap re-shapes it.

## Which story owns each destination (connect, don't duplicate)

| Destination shown                                     | Owner (design → build)                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Start-fresh discovery (Understand · Scope · Plan)     | 7.3 / MOTIR-804 (done); entered by MOTIR-1462 seeding `DiscoveryOnboarding` |
| Import wizard (Connect · Read your code · Plan)       | 7.15 / MOTIR-815, wizard design MOTIR-930, orchestration MOTIR-931          |
| External Jira / Linear / Plane import                 | 7.17 / MOTIR-817                                                            |
| The `/onboarding` fork route + hand-off               | MOTIR-1462 (`blocked_by` this design)                                       |
| The IN-APP "Plan with AI" entry that reuses this fork | MOTIR-1485 (design) / MOTIR-1486 (code)                                     |

## Mirror grounding

The "choose your path" fork is the standard onboarding entry for tools that serve both new and existing
projects: **Vercel** ("Start with a template" vs "Import Git Repository"), **Linear / Jira** ("Start from
scratch" vs "Import issues"), **Railway / Netlify** ("Deploy a template" vs "Import an existing project").
Two peer cards with a legible destination preview each is that pattern; the start-fresh side leads with an
idea box because Motir's front door is chat-first (Principle #1).
