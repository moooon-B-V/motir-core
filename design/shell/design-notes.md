# `design/shell/` — the app shell

The authed shell: the top bar, the persistent sidebar rail, the off-canvas drawer, and the two
overlays the bar summons. This is the area's first `design-notes.md`; the five `.pen` assets beside it
predate the three-file convention and are indexed below rather than rewritten.

| Surface                                    | Asset                                           | Card             | State                                                                                                |
| ------------------------------------------ | ----------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| Desktop shell @1440 — bar + rail + content | `desktop.pen` / `.png`                          | MOTIR-53 (1.5.1) | Stale in the right cluster only: draws 3 controls of the 8 that ship                                 |
| Desktop shell, rail collapsed              | `desktop-collapsed.pen` / `.png`                | MOTIR-53         | Same                                                                                                 |
| Narrow width — bar closed, drawer open     | `mobile-drawer.pen` / `.png`                    | MOTIR-53         | **Superseded by `top-bar.mock.html`** for the right cluster + the drawer's footer                    |
| ⌘K command palette                         | `cmd-k.pen` / `.png`                            | MOTIR-53         | Current (panels: _Empty query_, _Filtered: 'iss'_)                                                   |
| Shortcuts cheatsheet                       | `shortcuts.pen` / `.png`                        | MOTIR-53         | Current                                                                                              |
| **The top bar's control budget**           | **`top-bar.mock.html` / `top-bar.png`**         | **MOTIR-2374**   | **The design of record for what the bar carries at each width**                                      |
| **The context row — the left cluster**     | **`context-row.mock.html` / `context-row.png`** | **MOTIR-2555**   | **The design of record for the `org › workspace › project` path, the rail head, and the brand tile** |

---

## The top bar's control budget (MOTIR-2374)

The code change is **MOTIR-2373**. This asset decides what it builds.

### Why the area owed this

The right cluster grew from three controls to eight, one story at a time, and each addition was
designed — by the area that introduced it, for the desktop width it cared about. No design owned the
total. `design/shell/` does, and every `.pen` here has been drawing a three-control bar since Story
1.5, so the bar reached eight controls without a single design pass ever seeing the eight together.

### What the render found — the facts this design is built on

Every number below was measured, not estimated: the real `app/(authed)/_components/TopNav.tsx` was
server-rendered inside its real providers with the real `messages/en.json`, then laid out in Chromium
against the build's own compiled Tailwind output. Panel A of the mock IS that render — the markup in
those frames is the app's, not a redraw (`notes.html` #73).

Right-cluster width, by viewport and by which optional slots are live:

| Viewport | Private project + AI          | **Public** project + AI                                 | Self-hosted, no AI, private  |
| -------- | ----------------------------- | ------------------------------------------------------- | ---------------------------- |
| 375px    | **350px** — hamburger covered | **409px** — `<nav>` scrolls to 433px, hamburger covered | 208px — fits, with 0px spare |
| 700px    | **656px** — hamburger covered | **670px** — scrolls to 702px                            | 383px                        |
| 1024px   | 706px                         | 717px                                                   | 383px                        |

Three findings the bug did not have, each of which changes what gets built:

1. **The worst band is `sm`–`md` (640–767px), not `< md`.** At 640px every label switches on at once
   and the cluster jumps 350 → 656px inside a 640px viewport — while the hamburger is still mounted,
   because it is `md:hidden` and therefore lives to 767px. A fix scoped to `< md` leaves a 128px-wide
   band broken in exactly the same way, and a hit-test asserted only at 375×812 passes while it is.
2. **`BuildingInPublicHeaderLink` is the one control whose label was never breakpoint-gated.** Every
   other labelled control carries `hidden sm:inline`; this one carries none, so it contributes
   **117px at 375px** where the CTA it replaces contributes 38px. That asymmetry — not the control
   count — is what makes the public state the widest surface in the product.
3. **The cluster is already squeezing its own controls below their box.** In the public state at
   375px the theme toggle and the avatar measure **28px wide against a 36px height**: the avatar's
   `rounded-full` is rendering as an ellipse. The cluster mixes three box sizes today (28 / 36 / 38).

### The budget

The ceiling is set by the smallest viewport the app supports, **320px**, and by the one element that
must never be covered: the hamburger, which below `md` is the only route to the board, the backlog or
settings.

```
320 − 32 (px-4 gutters) − 36 (hamburger) − 8 − 8 (gaps) − 68 (tier-nav floor) = 168px
168 = 4 × 36 + 3 × 8
```

**Four slots below `md`.** The pixels move with `--height-control` (36px default; 40px under
`soft-playful` and `3d-immersive`, 34px under `swiss-minimal-flat` and `cybercore-y2k`) — the slot
COUNT does not. At the widest style the same sum leaves the tier nav 48px, which is a truncated
project name: legible, and the floor this budget accepts.

| Band                   | Left cluster                   | Right cluster                                                      |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `< md` (0–767px)       | hamburger + tier nav, no brand | **4 slots, icon-only, one `--height-control` square each — 168px** |
| `md`–`lg` (768–1023px) | brand + tier nav, no hamburger | **8 slots, icon-only** (the build-in-public slot keeps its label)  |
| `≥ lg` (1024px)        | brand + tier nav               | **8 slots, labelled**                                              |

**The label breakpoint moves from `sm` to `lg`** — labels and their `<kbd>` hint chips together. That
one change is what closes the 640–767px band: at `md` the full set is back but icon-only, and by then
the brand slot has replaced the hamburger, so there is nothing left to cover. Measured on the mock:
`md` public = 468px right + 183px left, 69px of slack; `lg` public = 733px right + 183px left, 63px of
slack at the narrowest `lg` viewport.

Gating the label without the chip is not a half-measure, it is a defect: an icon beside a bare `⌘K`
chip has no label for the chip to attach to, and the chip overflows the square box it no longer fits.

### Every control's disposition below `md`

| Control                                         | `< md`                     | Where it goes instead                                                                                                                                                        | Why that is safe                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CommandPaletteTrigger`                         | **slot 1**, icon-only      | —                                                                                                                                                                            | The universal find, and the door to three of the four displaced controls: `plan-with-ai`, `create-issue` and `acct-theme` are all actions in `AppCommandPalette`.                           |
| `CreateIssueButton`                             | **slot 2**, icon-only      | —                                                                                                                                                                            | The primary write action. A phone is where a thought gets captured; two taps through ⌘K is the wrong cost for it.                                                                           |
| `NotificationBell`                              | **slot 3**, icon + badge   | —                                                                                                                                                                            | **The only control with no second door.** `/settings/account/notifications` is preferences, not a feed, and a badge inside a closed drawer conveys nothing.                                 |
| `UserMenu`                                      | **slot 4**, avatar         | —                                                                                                                                                                            | The sole path to account settings and sign-out, and the identity anchor of the bar.                                                                                                         |
| `PlanWithAILauncher`                            | **dropped**                | `PlanWithAIFab` — the floating orb, mounted on every authed screen behind the same `showPlanWithAi` gate (`app/(authed)/layout.tsx:279`) — plus the ⌘K `plan-with-ai` action | Two doors already ship at 375px. This is the one control that can leave the bar and cost nothing, which is why it leaves first.                                                             |
| `ThemeToggle`                                   | **drawer strip**           | The drawer's utility strip; also ⌘K `acct-theme` and `/settings/account/appearance`                                                                                          | A preference, changed rarely, with two working second doors.                                                                                                                                |
| `ReportButton` (`display="shell"`)              | **drawer strip**           | The drawer's utility strip                                                                                                                                                   | No ⌘K action exists for it, and `/triage`'s inbox CTA is a different act — reporting from the queue, not about the screen you are on. So it needs a drawn home, not a citation.             |
| the build-in-public slot (CTA **or** indicator) | **drawer strip**, labelled | The drawer's utility strip, keeping its label                                                                                                                                | A status stripped of its label is not a status. The drawer has the width the bar does not — and displacing BOTH of its states is what stops the two-state slot from being a width variable. |

At 375px the private and public bars now measure **identically (168px)**, because the slot that made
them differ is no longer in the bar.

### The rule for the ninth control

> The below-`md` bar is **closed at four slots**. A control added to the right cluster is a
> `md`-and-up control by default. To appear below `md` it must displace one of the four, and the
> displaced one must land in the drawer's utility strip — drawn, not cited. A control whose label is
> not breakpoint-gated does not qualify for the bar at all until it is: that is exactly how the widest
> state in the product came to exist.

This is the sentence `TopNav`'s docstring should record (MOTIR-2373's last acceptance criterion). A
docstring can only record a rule someone decided; this is where it was decided.

### The access path — the drawer's utility strip (Panel D)

The door is the hamburger the bar already carries. The room is a **footer strip** on `SidebarDrawer`,
with the geometry of the drawer's own header, mirrored to the bottom edge:

```
flex h-14 shrink-0 items-center gap-2 border-t border-(--el-sidebar-border) px-3
```

It holds, left to right: the build-in-public slot (labelled, in a `min-w-0 flex-1` wrapper so it
truncates rather than pushing), then `ReportButton`, then `ThemeToggle` as their shipped square icon
buttons. **Nothing in the strip is a new component** — each control is the element that left the bar,
re-homed. That is also why the strip is a horizontal row rather than `SidebarItem` rows: a
`SidebarItem` is an `href` link, and three of these four are buttons or stateful slots.

### Primitives and tokens

Every element names what it composes from. No element in this asset introduces a colour or a shape
value of its own.

| Element                | Primitive / component                                | Colour                                                                        | Shape                                                                               |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| the bar                | `<header data-surface="header">` + `<nav>`           | `--el-page-bg`, bottom hairline `--el-border`                                 | `h-14`, `px-4` / `sm:px-6` gutters, `gap-2`                                         |
| hamburger              | `SidebarToggle variant="hamburger"` → `Button` ghost | `--el-text-muted` → `--el-text` on hover over `--el-surface`                  | `--height-control` square, `--radius-control`                                       |
| brand slot             | `BrandMark variant="mark" size={24}`                 | the mark's own                                                                | `--radius-control`; `hidden md:flex` (design/brand §7a)                             |
| tier nav               | `ShellTierNav`                                       | `--el-text`, separator `--el-text-faint`                                      | `min-w-0`, truncates — the only elastic element in the bar                          |
| search · create        | `CommandPaletteTrigger` · `CreateIssueButton`        | `--el-text-muted` → `--el-text`, hover `--el-surface`, hairline `--el-border` | `--height-control` square below `lg`, `--radius-btn`; `--radius-kbd` chip from `lg` |
| report · theme         | `ReportButton` · `ThemeToggle`                       | same icon-button grammar                                                      | `--height-control` square, `--radius-control`                                       |
| bell                   | `NotificationBell` → `Popover`                       | badge `--el-accent` on `--el-accent-text`, ringed in `--el-page-bg`           | `--height-control` square, `--radius-control`; badge `--radius-badge`               |
| avatar                 | `UserMenu` → `Popover`                               | `--el-text` fill, `--el-text-inverted` initial                                | `--height-control` square, `rounded-full` (genuinely circular)                      |
| Plan-with-AI pill      | `PlanWithAILauncher`                                 | palette-derived `color-mix` over `--el-accent` / `--el-highlight` — unchanged | `--radius-badge`, `--height-btn-md`, `--spacing-btn-x`                              |
| build-in-public slot   | `BuildInPublicButton` / `BuildingInPublicHeaderLink` | `--el-build-bg` fill, `--el-build-text` ink, `--el-build-glyph` megaphone     | `--radius-badge`, `--spacing-chip-x/y`                                              |
| drawer + utility strip | `SidebarDrawer` (Radix Dialog)                       | `--el-sidebar-bg`, `--el-sidebar-border`                                      | `h-14` strip mirroring the drawer header, `--shadow-modal` panel                    |

**One shape correction the code card should carry with the rest.** The controls that today hard-code
`h-9` / `w-9` / `p-(--spacing-icon-btn)` for their own box (`CommandPaletteTrigger`,
`CreateIssueButton`, `ThemeToggle`, `UserMenu`, `ReportButton`, `NotificationBell`) take
`--height-control` instead. That is what makes all four slots one square, what removes the 28/36/38
mixture, and what lets the budget survive a `data-style` swap — a raw `h-9` does not reshape.

### What this design overrides

Three areas made narrow-width claims in passing, while designing something else. Two of them were
never built, and one is contradicted by the render.

1. **`design/ai-chat/design-notes.md:458`** — the pill is _"present on every screen, never covering
   content"_. **Retracted below `md`.** Measured: at 375px the pill's box is `x 24–76` and the
   hamburger's is `x 16–52`; it covers 28 of the hamburger's 36px. Replaced by: the pill is a
   `md`-and-up control, and below `md` the `PlanWithAIFab` orb is the door. The _intent_ of the
   sentence — one universal entrance, always reachable (`notes.html` #83 / #89) — is preserved
   exactly, because the orb ships and is mounted under the same gate.
2. **`design/ai-chat/design-notes.md:786` and `:1015`** — the eight-control order
   `[Plan with AI] [Build in public] [+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]`.
   **Kept unchanged from `md` up**, where all eight are present; superseded below `md` by the
   four-slot set, which preserves the relative order of the controls that remain.
3. **`design/notifications/design-notes.md:44-47`** — the bell _"inside the off-canvas mobile
   `SidebarDrawer` … renders icon-only"_. **Verified unbuilt** — `components/ui/SidebarDrawer.tsx` on
   `origin/main` imports no notification component, so this was prior art, not a fact (`notes.html`
   #45: do not read "shipped" and believe it). **Overruled for the bell**, which stays in the bar: a
   badge inside a closed drawer conveys nothing, and the bell is the one control with no second door.
   The claim's _form_ is adopted and generalised — displaced shell controls do render icon-only inside
   the drawer, in the utility strip, which is now where that promise lives.
4. **`design/public-projects/design-notes.md:596-606`** — the single stateful slot, _"exactly one,
   never both, never empty"_. **Kept**, and extended: the slot is now stateful in two dimensions,
   state × breakpoint. Below `md` both of its states live in the drawer strip. This section also
   records the measured asymmetry that design did not know it had created (finding 2 above).

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The real `TopNav` is rendered through the repo's own vitest + RTL setup inside `CommandPaletteProvider`
   / `CreateIssueProvider` / `ProjectAccessProvider` / `ReportProvider` / `ThemeProvider` and a
   `NextIntlClientProvider` seeded from `messages/en.json`, in three prop states (private+AI,
   public+AI, self-hosted floor); `container.innerHTML` is dumped per state. The shipped
   `SidebarDrawer` + `SidebarNav variant="drawer"` are dumped the same way.
2. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
3. The target bars in Panels C–E are those same shipped elements with only the responsive prefixes
   this design changes — so the markup in the asset is the markup the code card ships.

Two harness artefacts, both corrected in the asset and named here so nobody reads them as design:
happy-dom drops a `background-image` whose value is a `linear-gradient()` over `color-mix()`, so the
pill's fill and its shimmer are restored verbatim from `PlanWithAILauncher.tsx`; and because every
frame shares one document, the compiled `@media (width >= …)` blocks are re-emitted scoped to
`[data-vw="…"]` so each frame resolves its own width. Both are properties of the board, not of the app.

---

## The context row — `org › workspace › project`, the rail head, and the brand tile (MOTIR-2555)

The code changes are **MOTIR-2556** (the move) and **MOTIR-2557** (the brand tile). This asset —
`context-row.mock.html` / `context-row.png` — decides what they build, and it AMENDS the control
budget above: that section decided the RIGHT cluster, this one decides the LEFT.

### What the ask was, and what the measurement made of it

Put the organization, the workspace and the project in one row, most-specific last; keep the
workspace tier hidden when the org has only one; give the brand mark a filled, rounded box with the
glyph in the primary colour.

The first two thirds of that already exist. `ShellTierNav.tsx` renders `OrgControl` always and
`WorkspaceSwitcher` only when `workspaces.length >= 2` — _"below that threshold the middle tier is
implicit and never shown"_ — so `org › project` is not a new rule, it is the rule the middle tier
already follows with a third tier appended behind it. What is genuinely new is that **the row has no
room**, and that is what this design is mostly about.

### The measurement — and a finding the budget above did not have

Every number below was measured, not estimated: the real `OrgControl`, `WorkspaceSwitcher`,
`ProjectSwitcher`, `SidebarHeader`, `ShellTierNav` and `TopNav` were rendered through the repo's own
vitest + RTL harness with the real `messages/en.json`, then laid out in Chromium against the build's
own compiled Tailwind output. `room` is `viewport − gutters − right cluster − the left cluster's
NATURAL (min-content) width`; negative means the elastic tier truncates. `ovf` is real horizontal
overflow and must be zero.

| viewport | ships today: left nat. · right · room · **ovf** | this design: left nat. · right · room · **ovf** |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| 320px    | 351 · 168 · −231 · **47**                       | 166 · 168 · −46 · **0**                         |
| 375px    | 351 · 168 · −176 · **0**                        | 166 · 168 · +9 · **0**                          |
| 768px    | 364 · 468 · −112 · **0**                        | 259 · 468 · −7 · **0**                          |
| 1024px   | 364 · 733 · −121 · **0**                        | 259 · 733 · −16 · **0**                         |
| 1280px   | 364 · 733 · +135 · **0**                        | 486 · 733 · +13 · **0**                         |

Measured in the WIDEST right-cluster state — a public project with AI configured — because that is
the state that sets the budget.

> **⚠️ FINDING — the 68px tier-nav floor was never reachable, and the shipped bar STILL overflows at
> 320px.** The budget above computes the below-`md` slot count from
> `320 − 32 − 36 − 8 − 8 − 68 = 168px`, reserving **68px** for the tier nav. The two shipped tiers
> cannot compress below **112px**: `OrgControl` and `WorkspaceSwitcher` are `inline-flex` ghost
> buttons whose avatar, chevron and padding are all `flex-none`. So at 320px the row needs 348px of
> a 320px viewport and **overflows by 47px** — on `main`, today, after MOTIR-2373. That is Panel A's
> first frame. The arithmetic was right about the right cluster and wrong about the floor, because a
> floor is a claim about what an element can compress TO, and nothing had measured it. This design
> closes it as a side effect; the finding belongs to this pass and is recorded here rather than
> quietly fixed.

### The measurement, re-taken without the marks (MOTIR-2674, 2026-08-11)

The table above was measured with BOTH marks present. `docs/decisions/entity-marks.md` removes the
org's mark entirely and makes the project's optional, so every number in the `this design` column
was re-taken. **The harness is committed as `scripts/measure-context-row.mjs` and is re-runnable**
(`node scripts/measure-context-row.mjs`): it loads THIS asset in Chromium — so it measures the real
component markup against the build's own CSS — and applies each variant as a DOM mutation. Basis:
`scrollWidth` of the bar's left cluster, and the row's overflow against the frame. That basis is
stated because it is not the min-content basis the older table used; the two agree at `xl` (486px)
and diverge at `md`, where min-content reports the truncated width and this reports the laid-out one.

| band (Panel B frame) | today: marks present | marks REMOVED | **org NAME from `md`** (shipped) |
| -------------------- | -------------------- | ------------- | -------------------------------- |
| 320px                | 120px                | 110px         | 110px                            |
| 375px                | 165px                | 136px         | 136px                            |
| 768px (`md`)         | 242px                | 209px         | **244px**                        |
| 1024px (`lg`)        | 233px                | 209px         | **240px**                        |
| 1280px (`xl`)        | 486px                | 428px         | **428px**                        |

> **⚠️ Where the baseline lives now.** The `today: marks present` column was measured against
> **Panel B as it stood before this pass corrected it**. Panel B, C and E have since been amended to
> draw the target (no org mark, no preset chip, org name from `md`) — because an asset that shows the
> old target beside the new one cannot tell a reader which is current. So re-running the harness today
> compares against **Panel A**, which keeps the ships-today row on purpose; the with-marks numbers
> above are reproducible from Panel A and from this file's history, not from Panel B.

Row overflow is **0 at every band, in every variant** — the ladder holds with the marks gone.

> **A second finding, on the SHIPPED bar (Panel A).** Re-measured here at **49px** of overflow at
> 320px, against the 47px recorded above; the 2px is the basis difference just described, not a
> regression. Of that, **28px is the two marks** (351px → 323px with them removed) — so the marks
> were paying more than a quarter of the overflow that finding is about. Removing them does not
> close it on the OLD bar (21px remains); the below-`md` rule in Panel B is still what closes it.

### The ladder — the design

One elastic row, three things that want it. The answer is a LADDER, and it follows the breadcrumb
convention every mature tool uses: **the most specific tier never leaves; ancestors collapse from
the left.**

| band                 | the bar's path                                           | left cluster, measured at the band's narrowest |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `< md` (0–767px)     | **project only** — hamburger + the project tier          | 110px, 0 overflow at 320                       |
| `md`–`xl` (768–1279) | **`org › project`**, the org as its **NAME** (see below) | 244px at 768 · 240px at 1024, 0 overflow       |
| `≥ xl` (1280px)      | **`org › workspace › project`**, the full path           | 428px, 0 overflow at 1280                      |

> **⚠️ AMENDED by MOTIR-2674 (2026-08-11): the `md`–`xl` org tier now shows its NAME, not its mark.**
> The row above used to read _"the org as its MARK (name hidden)"_, and that was correct only while
> the org HAD a mark. `docs/decisions/entity-marks.md` §2 deletes `OrgAvatar`, and a tier whose only
> rendered content was the mark becomes **a ghost button holding a chevron** — focusable, operable
> and mute. Revealing the name is what gives it content again.
>
> **It was measured, not assumed, and it is nearly free:** at 768px the name costs **+2px** against
> today's mark form (244 vs 242) and at 1024px **+7px** (240 vs 233); overflow stays **0** at every
> band. The mark was never buying width — it was buying the _appearance_ of compactness.
>
> Rejected alternatives: dropping the org tier entirely below `xl` (the path then jumps from one tier
> to three, and the org stops being the permanent anchor Story 6.10.5 made it); and capping the name
> harder to save the 2px (a cap that saves 2px is not a cap, it is a truncation nobody asked for).

Three consequences worth stating plainly, because each is a decision and not a fallout:

1. **The full three-tier path starts at `xl`, not at `md`.** At `md` the labelled-at-`lg` right
   cluster leaves the left one about 220px, and `org-mark › workspace › project` needs ~330px. It
   does not fit, and no amount of character-capping makes it fit without making all three names
   unreadable. So the workspace tier — the tier that is ALREADY conditional — is the one that waits.
2. **Below `md` the bar carries the PROJECT, not the org.** This inverts what ships today, and it is
   the right way round: the project is the tier a person consults most, and the ancestors have a
   drawn home at that width — the `SidebarDrawer` header, which renders `ShellTierNav` and keeps
   `org › workspace` at every width. **The drawer header is UNCHANGED by this design.** What changes
   is that the project is no longer _inside_ the drawer body; it is in the bar, one tap closer.
3. **The project tier is the row's elastic element, so it SHRINKS.** `ProjectSwitcher`'s trigger
   drops `w-full` (it is no longer a 216px rail slot) and takes `min-w-0 shrink`, with the name
   `min-w-0 max-w-[22ch] truncate`. Without the `min-w-0` the button refuses to shrink and the label
   is overrun by the next control instead of ellipsizing — which is exactly what the render shows
   happening to today's bar at 768px, and is why this is specified rather than left to the code card.

**The rule for the next tier.** The path is closed at ONE tier below `md`, TWO from `md`, THREE from
`xl`. A tier added to the path is an `xl`-and-up tier by default; to appear earlier it must displace
one, and the displaced one needs a drawn home — which is the drawer header, and the reason that
header keeps the full ancestor path at every width.

### The three states the project tier inherits

`SidebarHeader.tsx` resolves three states no other rail row needs. All three move with the control:

| state            | in the rail today                                    | in the bar                                                                                                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| active project   | `ProjectSwitcher` trigger, `w-full` in a 216px slot  | the same trigger, `min-w-0 shrink`, name capped at 22ch                                                                                   |
| archived project | the same trigger + `Pill tone="archived"`            | unchanged — the pill is `shrink-0`, so the NAME truncates around it, never the pill                                                       |
| **no project**   | a lavender `Card` CTA, full width, opening the modal | the same action in the ghost-button grammar the other tiers use: the accent `+` square + the label, opening the same `CreateProjectModal` |

A full-width tinted card cannot be a tier in a horizontal row; the ghost button can, and it keeps
the door in the same place a person now looks for project context.

### The rail head, after the project leaves

The rail answers _where inside this project can I go_. Its head was answering a different question,
which is why it needed three states nothing else in the rail needs. **The default-area rail head is
REMOVED** — the rail starts at its first nav section — in both the expanded and the collapsed rail
(the collapsed 32px `ProjectAvatar` goes with the rest), and in the drawer body. The settings and
account areas keep their own headers (`SettingsSidebarHeader`, `AccountSidebarHeader`) untouched;
`SidebarNav` still reads `activeProject` for its nav sections and its settings-area swap.

### The brand tile

The 32px box already exists in `TopNav.tsx` and is simply unpainted:
`hidden h-8 w-8 flex-none items-center justify-center rounded-(--radius-control) md:flex`.

| element       | token                                    | measured                                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| the field     | `--el-surface`                           | #f6f5f4 light · #1a1a1a dark                               |
| its edge      | `--el-border` hairline                   | the tile's outline at both themes                          |
| the glyph     | `--el-accent-on-surface` — **unchanged** | #5645d4 light · #7b6ce5 dark                               |
| glyph on fill | —                                        | **6.03:1** light · **4.24:1** dark (WCAG 1.4.11 needs 3:1) |
| the shape     | `--radius-control` — unchanged           | —                                                          |

Three things this pins, each for a reason:

- **The glyph token does NOT change.** `.brand-glyph` in `app/globals.css` is the colour of EVERY
  brand surface — auth, `ExploreTopBar`, `PublicTopBar`, the OG images, the specimen — and that block
  is a verbatim copy of the approved artwork's own CSS. `--el-accent-on-surface` is the token whose
  name is literally this composition, and it clears 1.4.11 on `--el-surface` in both themes, so this
  story touches no other brand surface at all.
- **Not a tint.** `--el-tint-lavender` was the obvious candidate and is wrong here. **The original
  reason was ADJACENCY** — `OrgControl`'s `OrgAvatar` was a 20px `--el-tint-lavender` tile and
  `ProjectAvatar` an `--el-avatar-lavender` one, so a third lavender square 20px away would have read
  as a third tier chip.
  **⚠️ RE-EXAMINED by MOTIR-2674: both of those squares are gone** (the org's is deleted; the
  project's is now an optional photograph), so that argument no longer applies and the conclusion
  cannot rest on it. **It is re-affirmed on a different and simpler ground: the tile is now the ONLY
  boxed element in the left cluster, so the box itself is what marks it as identity rather than as a
  control.** A tint would re-introduce exactly the tier-chip reading the neutral field was chosen to
  avoid, this time with nothing beside it to excuse the resemblance. Same token, same measurement,
  new reason — recorded rather than silently inherited, because a premise that has stopped being
  true is worse than no premise: it reads as checked.
- **The hairline DIVIDER is removed.** §7a introduced it to say the brand sits outside the tier
  hierarchy; the tile's own edge now says that, and dropping it returns 9px to the row.

`design/brand/design-notes.md` §7a is amended in the same PR. **A field BEHIND the mark is not a
recolour OF the mark** — §9's _"one token, never a hex, never a second hue"_ still holds exactly, and
the glyph still takes one token, the same one it took before.

### The target panels were CORRECTED, not supplemented (MOTIR-2674)

The first version of this pass added Panel G and left Panels B, C and E drawing the org mark and the
project's preset chip. That is a worse state than not having amended the asset at all: two targets in
one file, with nothing saying which is authoritative, and the older one appearing first.

**Panels B, C and E now draw the target** — no org mark, no preset chip, the org's name revealed from
`md`. **Panel A deliberately still draws both marks**: it is captioned _"what ships today"_ and is the
before-state the 320px finding is measured against; an asset that erases its own history cannot show
what changed. The correction is applied by `scripts/apply-entity-marks.mjs`, which is idempotent and
committed, so the transformation is auditable rather than a hand-edit nobody can re-check.

### The MARK — pinned once here, applied everywhere (MOTIR-2674)

`docs/decisions/entity-marks.md` decides WHAT a mark is; this pins how it renders, so the
projects-area asset (`MOTIR-2675`) and the two code cards apply ONE specification instead of each
inventing a compatible-looking one. The mark appears in four places — the bar's project tier, the
switcher's open list, the settings-area rail header, and the settings Details row — and they must be
the same object at different sizes.

| property   | value                                                                            | why                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| shape      | **square**, `--radius-control`                                                   | inherits the shipped org chip's deliberate square-vs-round split from the USER avatar (`OrgControl`'s own comment)     |
| size       | **20px** in the bar and the switcher rows · **52px** on the settings Details row | 20px is the slot the ladder is measured against; 52px matches the Account Photo row this composes from                 |
| fit        | `object-fit: cover`, centred                                                     | an uploaded logo is rarely square; cover fills the box without letterboxing, and centre is where a logo's subject sits |
| overflow   | `overflow-hidden` on the box                                                     | the radius must clip the image, not sit behind it                                                                      |
| alt / a11y | decorative (`aria-hidden`) wherever the project NAME is adjacent                 | the name already carries the accessible name; a second one would double-announce the tier                              |

**The EMPTY case, which is the decision's whole visible surface.** When a project has no image:

- **Nothing renders. The box is not reserved** — no placeholder, no dashed outline, no picture glyph,
  no monogram, no generated tint. The tier collapses to its name and the gap closes.
- **In a LIST, rows do not indent to a phantom column.** A project without an image starts at the
  same x as one with an image starts its _box_; the row's text therefore shifts left. Drawn in the
  projects asset (`MOTIR-2675`) at a realistic row count, because a mixed list is the normal case
  once images are optional, not an edge state.
- The rule this encodes: **an empty slot states a true fact** — nobody has set one. A generated tile
  states a false one, in the same visual weight a real logo would use.

### The element split with MOTIR-2546 — WITHDRAWN (MOTIR-2674, 2026-08-11)

This section used to hand the ORG tier's mark to `MOTIR-2546` — _"an uploaded avatar, or nothing at
all, plus the switch-org rows' chips"_ — and keep only the CLUSTER for this asset. **That split is
withdrawn, because the card on the other side of it no longer exists and the thing it was to own no
longer exists either.**

- **`MOTIR-2546` is ARCHIVED**, with the rest of the organization-mark work under `MOTIR-2542`
  (`MOTIR-2544`'s `Organization.image` column, `MOTIR-2547`'s shared upload primitive, `MOTIR-2549`'s
  header control). Verified on `origin/main`, 2026-08-11: there is **no `AvatarUploadField`**, **no
  `Organization.image`**, **no org upload route** and **no org prefix in `lib/blob/referencedUrls.ts`**.
  Those cards reached `in_review` and were never merged.
- **An organization now carries NO mark at all** — `docs/decisions/entity-marks.md` §2. There is no
  uploaded org avatar to draw, so there is no element left to allocate.

**So this asset owns the org tier's presentation outright**, and what it draws there is the NAME (see
the amended ladder). The switch-org rows lose their initial chip with the trigger's — one entity, one
answer; a chip that survives only inside a popover would be the third rendering of a mark the product
has decided not to have.

**Kept as a record rather than deleted:** a reader who finds `MOTIR-2546` cited in an older commit,
or the two-owner sentence in a cached copy of this file, needs to be able to see that the boundary was
retired deliberately and by whom, not wonder which asset is authoritative.

### What this design overrides

Three areas made narrow-width claims in passing, while designing something else. Two of them were
never built, and one is contradicted by the render.

1. **`design/ai-chat/design-notes.md:458`** — the pill is _"present on every screen, never covering
   content"_. **Retracted below `md`.** Measured: at 375px the pill's box is `x 24–76` and the
   hamburger's is `x 16–52`; it covers 28 of the hamburger's 36px. Replaced by: the pill is a
   `md`-and-up control, and below `md` the `PlanWithAIFab` orb is the door. The _intent_ of the
   sentence — one universal entrance, always reachable (`notes.html` #83 / #89) — is preserved
   exactly, because the orb ships and is mounted under the same gate.
2. **`design/ai-chat/design-notes.md:786` and `:1015`** — the eight-control order
   `[Plan with AI] [Build in public] [+ Create ⌘C] [Search ⌘K] [bug] [screen] [bell] [avatar]`.
   **Kept unchanged from `md` up**, where all eight are present; superseded below `md` by the
   four-slot set, which preserves the relative order of the controls that remain.
3. **`design/notifications/design-notes.md:44-47`** — the bell _"inside the off-canvas mobile
   `SidebarDrawer` … renders icon-only"_. **Verified unbuilt** — `components/ui/SidebarDrawer.tsx` on
   `origin/main` imports no notification component, so this was prior art, not a fact (`notes.html`
   #45: do not read "shipped" and believe it). **Overruled for the bell**, which stays in the bar: a
   badge inside a closed drawer conveys nothing, and the bell is the one control with no second door.
   The claim's _form_ is adopted and generalised — displaced shell controls do render icon-only inside
   the drawer, in the utility strip, which is now where that promise lives.
4. **`design/public-projects/design-notes.md:596-606`** — the single stateful slot, _"exactly one,
   never both, never empty"_. **Kept**, and extended: the slot is now stateful in two dimensions,
   state × breakpoint. Below `md` both of its states live in the drawer strip. This section also
   records the measured asymmetry that design did not know it had created (finding 2 above).

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The real `TopNav` is rendered through the repo's own vitest + RTL setup inside `CommandPaletteProvider`
   / `CreateIssueProvider` / `ProjectAccessProvider` / `ReportProvider` / `ThemeProvider` and a
   `NextIntlClientProvider` seeded from `messages/en.json`, in three prop states (private+AI,
   public+AI, self-hosted floor); `container.innerHTML` is dumped per state. The shipped
   `SidebarDrawer` + `SidebarNav variant="drawer"` are dumped the same way.
2. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
3. The target bars in Panels C–E are those same shipped elements with only the responsive prefixes
   this design changes — so the markup in the asset is the markup the code card ships.

Two harness artefacts, both corrected in the asset and named here so nobody reads them as design:
happy-dom drops a `background-image` whose value is a `linear-gradient()` over `color-mix()`, so the
pill's fill and its shimmer are restored verbatim from `PlanWithAILauncher.tsx`; and because every
frame shares one document, the compiled `@media (width >= …)` blocks are re-emitted scoped to
`[data-vw="…"]` so each frame resolves its own width. Both are properties of the board, not of the app.

---

## The context row — `org › workspace › project`, the rail head, and the brand tile (MOTIR-2555)

The code changes are **MOTIR-2556** (the move) and **MOTIR-2557** (the brand tile). This asset —
`context-row.mock.html` / `context-row.png` — decides what they build, and it AMENDS the control
budget above: that section decided the RIGHT cluster, this one decides the LEFT.

### What the ask was, and what the measurement made of it

Put the organization, the workspace and the project in one row, most-specific last; keep the
workspace tier hidden when the org has only one; give the brand mark a filled, rounded box with the
glyph in the primary colour.

The first two thirds of that already exist. `ShellTierNav.tsx` renders `OrgControl` always and
`WorkspaceSwitcher` only when `workspaces.length >= 2` — _"below that threshold the middle tier is
implicit and never shown"_ — so `org › project` is not a new rule, it is the rule the middle tier
already follows with a third tier appended behind it. What is genuinely new is that **the row has no
room**, and that is what this design is mostly about.

### The measurement — and a finding the budget above did not have

Every number below was measured, not estimated: the real `OrgControl`, `WorkspaceSwitcher`,
`ProjectSwitcher`, `SidebarHeader`, `ShellTierNav` and `TopNav` were rendered through the repo's own
vitest + RTL harness with the real `messages/en.json`, then laid out in Chromium against the build's
own compiled Tailwind output. `room` is `viewport − gutters − right cluster − the left cluster's
NATURAL (min-content) width`; negative means the elastic tier truncates. `ovf` is real horizontal
overflow and must be zero.

| viewport | ships today: left nat. · right · room · **ovf** | this design: left nat. · right · room · **ovf** |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| 320px    | 351 · 168 · −231 · **47**                       | 166 · 168 · −46 · **0**                         |
| 375px    | 351 · 168 · −176 · **0**                        | 166 · 168 · +9 · **0**                          |
| 768px    | 364 · 468 · −112 · **0**                        | 259 · 468 · −7 · **0**                          |
| 1024px   | 364 · 733 · −121 · **0**                        | 259 · 733 · −16 · **0**                         |
| 1280px   | 364 · 733 · +135 · **0**                        | 486 · 733 · +13 · **0**                         |

Measured in the WIDEST right-cluster state — a public project with AI configured — because that is
the state that sets the budget.

> **⚠️ FINDING — the 68px tier-nav floor was never reachable, and the shipped bar STILL overflows at
> 320px.** The budget above computes the below-`md` slot count from
> `320 − 32 − 36 − 8 − 8 − 68 = 168px`, reserving **68px** for the tier nav. The two shipped tiers
> cannot compress below **112px**: `OrgControl` and `WorkspaceSwitcher` are `inline-flex` ghost
> buttons whose avatar, chevron and padding are all `flex-none`. So at 320px the row needs 348px of
> a 320px viewport and **overflows by 47px** — on `main`, today, after MOTIR-2373. That is Panel A's
> first frame. The arithmetic was right about the right cluster and wrong about the floor, because a
> floor is a claim about what an element can compress TO, and nothing had measured it. This design
> closes it as a side effect; the finding belongs to this pass and is recorded here rather than
> quietly fixed.

### The measurement, re-taken without the marks (MOTIR-2674, 2026-08-11)

The table above was measured with BOTH marks present. `docs/decisions/entity-marks.md` removes the
org's mark entirely and makes the project's optional, so every number in the `this design` column
was re-taken. **The harness is committed as `scripts/measure-context-row.mjs` and is re-runnable**
(`node scripts/measure-context-row.mjs`): it loads THIS asset in Chromium — so it measures the real
component markup against the build's own CSS — and applies each variant as a DOM mutation. Basis:
`scrollWidth` of the bar's left cluster, and the row's overflow against the frame. That basis is
stated because it is not the min-content basis the older table used; the two agree at `xl` (486px)
and diverge at `md`, where min-content reports the truncated width and this reports the laid-out one.

| band (Panel B frame) | today: marks present | marks REMOVED | **org NAME from `md`** (shipped) |
| -------------------- | -------------------- | ------------- | -------------------------------- |
| 320px                | 120px                | 110px         | 110px                            |
| 375px                | 165px                | 136px         | 136px                            |
| 768px (`md`)         | 242px                | 209px         | **244px**                        |
| 1024px (`lg`)        | 233px                | 209px         | **240px**                        |
| 1280px (`xl`)        | 486px                | 428px         | **428px**                        |

Row overflow is **0 at every band, in every variant** — the ladder holds with the marks gone.

> **A second finding, on the SHIPPED bar (Panel A).** Re-measured here at **49px** of overflow at
> 320px, against the 47px recorded above; the 2px is the basis difference just described, not a
> regression. Of that, **28px is the two marks** (351px → 323px with them removed) — so the marks
> were paying more than a quarter of the overflow that finding is about. Removing them does not
> close it on the OLD bar (21px remains); the below-`md` rule in Panel B is still what closes it.

### The ladder — the design

One elastic row, three things that want it. The answer is a LADDER, and it follows the breadcrumb
convention every mature tool uses: **the most specific tier never leaves; ancestors collapse from
the left.**

| band                 | the bar's path                                           | left cluster, measured at the band's narrowest |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `< md` (0–767px)     | **project only** — hamburger + the project tier          | 110px, 0 overflow at 320                       |
| `md`–`xl` (768–1279) | **`org › project`**, the org as its **NAME** (see below) | 244px at 768 · 240px at 1024, 0 overflow       |
| `≥ xl` (1280px)      | **`org › workspace › project`**, the full path           | 428px, 0 overflow at 1280                      |

> **⚠️ AMENDED by MOTIR-2674 (2026-08-11): the `md`–`xl` org tier now shows its NAME, not its mark.**
> The row above used to read _"the org as its MARK (name hidden)"_, and that was correct only while
> the org HAD a mark. `docs/decisions/entity-marks.md` §2 deletes `OrgAvatar`, and a tier whose only
> rendered content was the mark becomes **a ghost button holding a chevron** — focusable, operable
> and mute. Revealing the name is what gives it content again.
>
> **It was measured, not assumed, and it is nearly free:** at 768px the name costs **+2px** against
> today's mark form (244 vs 242) and at 1024px **+7px** (240 vs 233); overflow stays **0** at every
> band. The mark was never buying width — it was buying the _appearance_ of compactness.
>
> Rejected alternatives: dropping the org tier entirely below `xl` (the path then jumps from one tier
> to three, and the org stops being the permanent anchor Story 6.10.5 made it); and capping the name
> harder to save the 2px (a cap that saves 2px is not a cap, it is a truncation nobody asked for).

Three consequences worth stating plainly, because each is a decision and not a fallout:

1. **The full three-tier path starts at `xl`, not at `md`.** At `md` the labelled-at-`lg` right
   cluster leaves the left one about 220px, and `org-mark › workspace › project` needs ~330px. It
   does not fit, and no amount of character-capping makes it fit without making all three names
   unreadable. So the workspace tier — the tier that is ALREADY conditional — is the one that waits.
2. **Below `md` the bar carries the PROJECT, not the org.** This inverts what ships today, and it is
   the right way round: the project is the tier a person consults most, and the ancestors have a
   drawn home at that width — the `SidebarDrawer` header, which renders `ShellTierNav` and keeps
   `org › workspace` at every width. **The drawer header is UNCHANGED by this design.** What changes
   is that the project is no longer _inside_ the drawer body; it is in the bar, one tap closer.
3. **The project tier is the row's elastic element, so it SHRINKS.** `ProjectSwitcher`'s trigger
   drops `w-full` (it is no longer a 216px rail slot) and takes `min-w-0 shrink`, with the name
   `min-w-0 max-w-[22ch] truncate`. Without the `min-w-0` the button refuses to shrink and the label
   is overrun by the next control instead of ellipsizing — which is exactly what the render shows
   happening to today's bar at 768px, and is why this is specified rather than left to the code card.

**The rule for the next tier.** The path is closed at ONE tier below `md`, TWO from `md`, THREE from
`xl`. A tier added to the path is an `xl`-and-up tier by default; to appear earlier it must displace
one, and the displaced one needs a drawn home — which is the drawer header, and the reason that
header keeps the full ancestor path at every width.

### The three states the project tier inherits

`SidebarHeader.tsx` resolves three states no other rail row needs. All three move with the control:

| state            | in the rail today                                    | in the bar                                                                                                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| active project   | `ProjectSwitcher` trigger, `w-full` in a 216px slot  | the same trigger, `min-w-0 shrink`, name capped at 22ch                                                                                   |
| archived project | the same trigger + `Pill tone="archived"`            | unchanged — the pill is `shrink-0`, so the NAME truncates around it, never the pill                                                       |
| **no project**   | a lavender `Card` CTA, full width, opening the modal | the same action in the ghost-button grammar the other tiers use: the accent `+` square + the label, opening the same `CreateProjectModal` |

A full-width tinted card cannot be a tier in a horizontal row; the ghost button can, and it keeps
the door in the same place a person now looks for project context.

### The rail head, after the project leaves

The rail answers _where inside this project can I go_. Its head was answering a different question,
which is why it needed three states nothing else in the rail needs. **The default-area rail head is
REMOVED** — the rail starts at its first nav section — in both the expanded and the collapsed rail
(the collapsed 32px `ProjectAvatar` goes with the rest), and in the drawer body. The settings and
account areas keep their own headers (`SettingsSidebarHeader`, `AccountSidebarHeader`) untouched;
`SidebarNav` still reads `activeProject` for its nav sections and its settings-area swap.

### The brand tile

The 32px box already exists in `TopNav.tsx` and is simply unpainted:
`hidden h-8 w-8 flex-none items-center justify-center rounded-(--radius-control) md:flex`.

| element       | token                                    | measured                                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| the field     | `--el-surface`                           | #f6f5f4 light · #1a1a1a dark                               |
| its edge      | `--el-border` hairline                   | the tile's outline at both themes                          |
| the glyph     | `--el-accent-on-surface` — **unchanged** | #5645d4 light · #7b6ce5 dark                               |
| glyph on fill | —                                        | **6.03:1** light · **4.24:1** dark (WCAG 1.4.11 needs 3:1) |
| the shape     | `--radius-control` — unchanged           | —                                                          |

Three things this pins, each for a reason:

- **The glyph token does NOT change.** `.brand-glyph` in `app/globals.css` is the colour of EVERY
  brand surface — auth, `ExploreTopBar`, `PublicTopBar`, the OG images, the specimen — and that block
  is a verbatim copy of the approved artwork's own CSS. `--el-accent-on-surface` is the token whose
  name is literally this composition, and it clears 1.4.11 on `--el-surface` in both themes, so this
  story touches no other brand surface at all.
- **Not a tint.** `--el-tint-lavender` was the obvious candidate and is wrong here. **The original
  reason was ADJACENCY** — `OrgControl`'s `OrgAvatar` was a 20px `--el-tint-lavender` tile and
  `ProjectAvatar` an `--el-avatar-lavender` one, so a third lavender square 20px away would have read
  as a third tier chip.
  **⚠️ RE-EXAMINED by MOTIR-2674: both of those squares are gone** (the org's is deleted; the
  project's is now an optional photograph), so that argument no longer applies and the conclusion
  cannot rest on it. **It is re-affirmed on a different and simpler ground: the tile is now the ONLY
  boxed element in the left cluster, so the box itself is what marks it as identity rather than as a
  control.** A tint would re-introduce exactly the tier-chip reading the neutral field was chosen to
  avoid, this time with nothing beside it to excuse the resemblance. Same token, same measurement,
  new reason — recorded rather than silently inherited, because a premise that has stopped being
  true is worse than no premise: it reads as checked.
- **The hairline DIVIDER is removed.** §7a introduced it to say the brand sits outside the tier
  hierarchy; the tile's own edge now says that, and dropping it returns 9px to the row.

`design/brand/design-notes.md` §7a is amended in the same PR. **A field BEHIND the mark is not a
recolour OF the mark** — §9's _"one token, never a hex, never a second hue"_ still holds exactly, and
the glyph still takes one token, the same one it took before.

### The element split with MOTIR-2546

Two designs legitimately touch this row and they own different ELEMENTS.
`MOTIR-2546` owns what the ORG tier's MARK is (an uploaded avatar, or nothing
at all, plus the switch-org rows' chips). This asset owns the CLUSTER around it — how many tiers
there are, their separators, their truncation order, and the project tier. Neither redraws the
other's element. If that card changes the org tier's WIDTH, the budget table above is measured
against the current 20px chip and must be re-measured; whichever asset merges second rebases onto the
first.

### What this design overrides

1. **`design/shell/design-notes.md` § _The top bar's control budget_ (this file, above)** — its
   below-`md` arithmetic reserves a **68px tier-nav floor**. **Amended**: the floor is unreachable by
   the shipped tiers (112px min-content), and the fix is not a bigger floor but ONE tier below `md`.
   The right-cluster half of that budget — four slots, the `lg` label breakpoint, the drawer utility
   strip — is untouched and still binding.
2. **`design/brand/design-notes.md` §7a** — _"mark only, 24px … with a hairline divider separating it
   from `ShellTierNav`"_. **Amended**: the mark keeps its size and its slot, gains a field, and loses
   the divider. Recorded in that file in this PR.
3. **`TopNav.tsx`'s docstring** — _"The project switcher MOVED to the sidebar header in Subtask
   1.5.3 … so the project switcher … is gone from here."_ That decision is deliberately REVERSED
   (Yue, 2026-08-10). MOTIR-2556 rewrites the docstring; it is a deliverable, not a fact to preserve.

### How the render was produced

Same method as the control budget above, so the asset cannot drift from the app:

1. **The dump.** A THROWAWAY vitest file — written under `tests/`, run, and deleted, so nothing in the
   repo cites it — renders `OrgControl`, `WorkspaceSwitcher`, `ProjectSwitcher` (active / archived /
   open popover), `SidebarHeader` (all three states), `ShellTierNav` (one and two workspaces) and
   `TopNav` (every optional slot live) and writes each `container.innerHTML` to a temp directory. To
   reproduce it, the shape is:

   ```tsx
   // @vitest-environment happy-dom
   vi.mock('next-intl/server', () => ({ getTranslations: … })); // resolve from messages/en.json
   vi.mock('next/navigation', () => ({ useRouter: …, usePathname: () => '/dashboard' }));
   // CreateIssueModal / CreateProjectModal / BuildInPublicDialog stubbed to null
   renderWithIntl(
     <ThemeProvider><ToastProvider><CommandPaletteProvider><CreateIssueProvider hasProject canEdit>
       <ProjectAccessProvider permissions={['work_item:edit', 'project:administer']}>
         <ReportProvider projectKey="MOTIR" canEdit>{node}</ReportProvider>
       </ProjectAccessProvider>
     </CreateIssueProvider></CommandPaletteProvider></ToastProvider></ThemeProvider>,
   );
   // TopNav is async: `const bar = await TopNav(props)` first, then render it.
   ```

   Run it with the LOCAL binary (`./node_modules/.bin/vitest run <that file>`) — `pnpm exec` re-runs a
   dependency check that fights the shared pnpm store in a fresh worktree.

2. The TARGET cluster is composed from those dumps: the real buttons, in the arrangement and with the
   responsive prefixes this design decides — which is exactly what MOTIR-2556 ships. The three edits
   are isolated and named in the ladder section above.
3. `app/globals.css` is compiled by the repo's own `@tailwindcss/postcss` over that markup, so the
   mock's stylesheet is the build's output rather than a retyped token block.
4. The frames are laid out and MEASURED in Chromium (`@playwright/test`'s chromium) at 320 / 375 /
   640 / 700 / 768 / 1024 / 1280 / 1440, and the PNG is a full-page `deviceScaleFactor: 2` shot of
   the finished board.

Two harness artefacts, both corrected in the asset and named here so nobody reads them as design:
happy-dom drops a `background-image` whose value is a `linear-gradient()` over `color-mix()`, so the
Plan-with-AI pill's fill is restored verbatim from `PlanWithAILauncher.tsx:61-62`; and because every
frame shares one document, the compiled `@media (width >= …)` blocks are re-emitted scoped to
`[data-vw="…"]` so each frame resolves its OWN width. Both are properties of the board, not of the app.
