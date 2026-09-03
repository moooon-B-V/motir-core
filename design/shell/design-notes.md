# `design/shell/` — the app shell

The authed shell: the top bar, the persistent sidebar rail, the off-canvas drawer, and the two
overlays the bar summons. This is the area's first `design-notes.md`; the five `.pen` assets beside it
predate the three-file convention and are indexed below rather than rewritten.

| Surface                                    | Asset                                                           | Card                        | State                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Desktop shell @1440 — bar + rail + content | `desktop.pen` / `.png`                                          | MOTIR-53 (1.5.1)            | Stale in the right cluster only: draws 3 controls of the 8 that ship                                 |
| Desktop shell, rail collapsed              | `desktop-collapsed.pen` / `.png`                                | MOTIR-53                    | Same                                                                                                 |
| Narrow width — bar closed, drawer open     | `mobile-drawer.pen` / `.png`                                    | MOTIR-53                    | **Superseded by `top-bar.mock.html`** for the right cluster + the drawer's footer                    |
| ⌘K command palette                         | `cmd-k.pen` / `.png`                                            | MOTIR-53                    | Current (panels: _Empty query_, _Filtered: 'iss'_)                                                   |
| Shortcuts cheatsheet                       | `shortcuts.pen` / `.png`                                        | MOTIR-53                    | Current                                                                                              |
| **The top bar's control budget**           | **`top-bar.mock.html` / `top-bar.png`**                         | **MOTIR-2374**              | **The design of record for what the bar carries at each width**                                      |
| **The context row — the left cluster**     | **`context-row.mock.html` / `context-row.png`**                 | **MOTIR-2555**              | **The design of record for the `org › workspace › project` path, the rail head, and the brand tile** |
| **The navigation-pending grammar**         | **`navigation-pending.mock.html` / `navigation-pending.png`**   | **MOTIR-3431**              | **The design of record for what the content area shows between the click and the arrival**           |
| **The rail's BOTTOM section**              | **`rail-bottom-section.mock.html` / `rail-bottom-section.png`** | **MOTIR-4130** · MOTIR-4167 | **The design of record for every row that section renders, at all three widths, in both arms**       |

---

## The content column reserves the floating orb's footprint (MOTIR-2763)

**The shell's content column pays the clearance for every piece of floating furniture the shell
mounts. A bottom-anchored control on any page must NOT reserve space for the orb itself.**

`PlanWithAIFab` — the "M" AI callout orb — is `fixed right-5 bottom-5 z-40 h-14 w-14`, so it owns the
viewport rect `y ∈ [bottom−76, bottom−20]` on every authed screen where `showPlanWithAi` holds. Being
`position: fixed` it participates in **no page's flow**: it takes viewport space from every page while
appearing in none of their layouts. Nothing catches that — no page imports the orb, so no type, no
grep and no component test connects the two, and a happy-dom test has no layout engine to see it with.

So the reservation is made **once, at the mount that creates the obstruction** — the content wrapper in
`app/(authed)/layout.tsx`, conditional on the same `showPlanWithAi` that decides whether the orb ships
at all. It is carried by a single custom property:

|                            |                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--shell-bottom-clearance` | `6rem` when the orb mounts, `1.5rem` when it does not. Set on the content wrapper; the wrapper's own `pb-` reads it.                                                                                                                                                        |
| consumers                  | Anything sizing itself against the fold subtracts `var(--shell-bottom-clearance, 1.5rem)` instead of hard-coding the wrapper's bottom padding — `BoardColumn`, `plans/[id]`, `RoadmapView`, and the `3d-immersive` board-column rule in `packages/design-system/theme.css`. |

**Two rules follow, and they are the reason this is written down.**

1. **A new bottom-anchored control adds nothing.** Put the pager, the footer row or the action bar
   last and right-aligned exactly as the design asks; the column already holds the space open. A
   control that reserves its own clearance double-pays it, and creates a rule every future author has
   to remember — there were already five such controls when this was found, and the sixth author would
   not have known.
2. **A surface that hard-codes a viewport-relative height MUST spend the variable, not a constant.**
   `h-[calc(100dvh - <chrome above> - var(--shell-bottom-clearance, 1.5rem))]` — never a single baked
   number that silently encodes today's padding. Four surfaces did bake it in, and all four would have
   been pushed past the fold by the clearance had they not been converted with it.

**And the check is a HIT TEST, not a look.** An overlapped control is still perfectly `toBeVisible()`
— visibility is a property of the element and clickability is a property of the stack above it. The
guard is `tests/e2e/cloud-orb-clearance.spec.ts`, which rides the **cloud** lane because that is the
only lane whose webServer sets `MOTIR_AI_URL`; in the main lane the orb does not mount, so the same
assertion would pass on broken code forever.

**Adding floating furniture to the shell is not additive** — it is a claim on viewport space that every
page in the app now pays. Reserving the space is part of shipping the element, in the same commit.

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

## The navigation-pending grammar (MOTIR-3431 · RE-MOUNTED by MOTIR-3492)

**What the authed content area shows between the click and the arrival.** The area had no drawing for
this state at all — `git grep -in 'loading\|skeleton\|pending\|spinner\|busy' origin/main -- design/shell/design-notes.md`
returned nothing at `dacf711b` — so every surface that has needed one so far invented its own, and
four different pulse compositions now live in four `_components` folders. This section is the one
grammar all of them answer to.

**Asset ·** `navigation-pending.mock.html` / `navigation-pending.png`. **Cards ·** MOTIR-3431 drew it;
MOTIR-3492 re-drew it against the constraint below. The code cards that built the first revision
(MOTIR-3433, MOTIR-3435) were **reverted**; MOTIR-3434 shipped and is untouched by this revision.

### ⚠️ THE CONSTRAINT THIS REVISION EXISTS FOR — a `loading.tsx` cannot sit above a page that 404s

**A `loading.tsx` fallback can render as soon as its ancestor layouts resolve, which is BEFORE the
page function runs. That flushes the response head and fixes the HTTP status at 200, so a
`notFound()` reached later renders the not-found BODY under a 200 and the 404 is gone.** **11 of the
58 `app/(authed)` pages call `notFound()`**, three of those assertions are tenant-isolation
contracts, and `/items/[key]`'s own source calls its 404 a _"no existence leak"_ guarantee. A group
boundary breaks all 11 at once.

Established by A/B with the boundary as the only variable, not by argument — the table is in
`motir-core/CLAUDE.md` § _A `loading.tsx` may NOT sit above a route that decides existence_, which is
the prose home of the rule; `tests/navigation/loading-boundary-guard.test.ts` is the guard. **Hoisting
the `notFound()` into a `layout.tsx` above the page does not help and was built and measured:** a
layout is an ANCESTOR of the boundary, so resolving it is precisely what RELEASES the fallback.

The first revision of this section said _"one `app/(authed)/loading.tsx` is the floor for all 58
pages"_. **That floor cannot exist.** Everything below is what survives, and where the frame goes
instead.

### THE WAIT HAS THREE WINDOWS, AND THE MISTAKE WAS BELIEVING IT HAD ONE

The frame was not the error. The error was giving windows 1 and 2 the same boundary, when only one of
them is the page's to speak for.

| #     | window         | from → to                                 | who can speak                                                                                                            | instrument                                                                                      |
| ----- | -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **1** | the GATE       | the click → the destination's first flush | only the SHELL, which is already mounted. On a HARD navigation nobody can, and that is not a defect — no page exists yet | the shell's pending mark (client-only, below)                                                   |
| **2** | the FRAME      | the first flush → the first content       | the destination page itself                                                                                              | an in-page `<Suspense>` placed AFTER the page's gate                                            |
| **3** | the LATE STACK | the first content → settled               | the page                                                                                                                 | the page's own allocation — `design/work-items/` § _The item page at ARRIVAL_ is the worked one |

**Window 1 is the one a route boundary was buying, and it is the one that cannot be bought that way.**
A gate is by definition the reads that decide whether this reader may see this page at all, so nothing
may be flushed until it has run. What a route boundary offered was to flush anyway — which is exactly
the defect.

**So the design's real instruction is to SHRINK window 1**, and it is not a slogan: a gate is
`getSession` → the active project → the existence read → the permission read, and **anything else in
front of the boundary is a read that could have been behind it**. `app/(authed)/items/[key]/page.tsx`
is the shipped demonstration — twenty-nine serial awaits cut to that gate plus one concurrent group
(MOTIR-3435's surviving half).

### WINDOW 1 — THE SHELL'S PENDING MARK, and why it is a MARK and not a frame

**On a soft navigation the shell is already mounted, so a CLIENT affordance renders with no server
boundary anywhere — and therefore cannot touch a status.** On a document request it does not render at
all: the shell is being produced by the server for the first time and there is no pending navigation
to have. That asymmetry is the whole reason this instrument is safe where a `loading.tsx` is not.

**It is a MARK on the thing the reader clicked, not a skeleton.** The shell does not know the
destination's shape. A skeleton drawn by the shell would be a guess that the page's own frame then
replaces — two frames for one navigation, which is the flicker the reveal delay exists to remove,
wearing a third costume.

|                   | the decision                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **what**          | the clicked `<Link>` marks itself pending — the rail item, the breadcrumb, the table row that navigates                                                                                                                                   |
| **how**           | `useLinkStatus()` from `next/link` (verified exported at `next@16.2.6`), read inside ONE wrapper the shell's nav items and navigating rows compose, never at each call site                                                               |
| **the treatment** | the rail item's OWN hover treatment, HELD — `--el-sidebar-item-bg-hover` behind it and `--el-text` ink, which is what the item already paints under a pointer. No spinner, no new hue, no size change: a mark that resizes moves the rail |
| **when**          | the same `nav-pending-reveal` keyframe and the same 120 ms delay, REFERENCED, never re-declared                                                                                                                                           |
| **a11y**          | `aria-busy="true"` on the marked link; the destination's own frame announces the region, so the mark does not also announce a live region                                                                                                 |

**What it deliberately does NOT cover, said plainly rather than left to be discovered:**

- **A typed URL, a reload, an emailed link.** A hard navigation has no mounted shell. Nothing can speak
  in window 1 for these, at any cost, and the reader's first feedback is window 2's frame. This is
  what makes shrinking the gate the substantive work rather than the frame.
- **A programmatic `router.push`** — `/items`' tree ↔ list, the plans list's status tabs, the item
  page's activity tabs. `useLinkStatus` reads a `<Link>`, and these are not links. Their pending state
  is `useTransition()`'s `isPending` at the call site, wrapped as `startTransition(() => router.push(…))`,
  feeding the SAME mark. Three call sites, named here so the next author does not invent a fourth
  mechanism for them.
- **A `shallowPush` switch** — nothing at all, and that is THE SWITCH RULE below, unchanged.

### WINDOW 2 — THE FRAME, MOUNTED IN THE PAGE

**The drawing is unchanged. Only the mount point moved.** The wrapper, the header block, the toolbar
row, the content region and the whole no-shift mapping below are the first revision's, verbatim —
they were never what was falsified.

The shape a page takes:

```tsx
// the GATE — awaited, with NO boundary above or around it. The status is
// decided here, so nothing may be flushed until it has run.
const session = await getSession();
if (!session) redirect('/sign-in');
const ctx = await getActiveProject();
const item = await …;            // may notFound() — the 404 is still a 404
const held = await …;            // may decide the affordances

// the FRAME — the first flush carries it, and the status is already committed
return (
  <Suspense fallback={<PageSkeleton … />}>
    <Body … />                    {/* every non-gate read lives in here */}
  </Suspense>
);
```

**Why this is safe and a `loading.tsx` is not, in one sentence:** the boundary is BELOW the gate
rather than above it, so the flush it releases happens after the status is settled instead of before.

**`/items` already ships exactly this** — its header and `[Filter] · [Tree ▾] · [+ New]` toolbar render
from the gate, and only the table sits behind `<Suspense fallback={<IssueTreeSkeleton/>}>`. Under the
first revision `/items` was the story's stated EXCEPTION, the one page a sweep would damage. **Under
this revision it is the worked example.** That inversion is the clearest single test of whether the
new grammar is the right one.

### WHICH SURFACES EARN A FRAME — the rule, replacing _what a nearer boundary owes this one_

1. **Every page may have one; no page inherits one.** There is no group frame and there cannot be one.
   A page without a frame is a page that has not been given one — not a page that opted out.
2. **A frame only ever covers a region that has NOTHING to show yet.** Whatever the gate alone can
   paint — a header, a static toolbar, a tab strip — is painted, and the boundary goes below it. A
   frame drawn over a control the reader can already click is a page made worse by being swept.
3. **Its SHAPE is chosen from three, in this order.** The page's OWN body shape where the page has one
   worth standing in for; the FAMILY shape where a set of routes share a body — the 31 `settings/*`
   routes' rail-and-pane is the one such family, and it is `design/settings/`'s to draw; the GENERIC
   block frame (Panel B) otherwise.
4. **The shared parts still live in ONE primitive.** `PageSkeleton` owns the wrapper, the header block
   and the reveal; a page passes its body in. A frame that COPIES those three instead of composing
   them is the drift that put `IssueTreeSkeleton` three columns and 272 px behind the table it stands
   in for, for eighty days, with its own comment promising it was in sync (MOTIR-3452).
5. **No `loading.tsx` is added anywhere under `app/(authed)`.** It stays legal above a subtree where no
   page decides existence — 47 of the 58 qualify — and this design still declines it, for the locator
   cost below. **One mechanism, not two.** (`app/(planning)/loading.tsx` and the two under
   `settings/project/` predate this and are out of scope; the guard rules on the shape, not on this
   preference.)

### ⚠️ THE THIRD INSTRUMENT — a ROUTE GROUP, weighed and declined FOR THIS GROUP (MOTIR-3491, merged 2026-08-26 while this asset was in review)

**This asset was drawn on the premise that a decider-containing subtree has two options: drop the
boundary, or move the frame in-page. There is a third, it shipped on `main` mid-review, and naming it
is owed** — a design that presents two options where the codebase has three is wrong in the way a
reader cannot detect.

**A route group adds no URL segment and owns its own boundary.** So the fix is not always to remove a
boundary from above a decider — it can be to move the SAFE routes and the `loading.tsx` together into
a `(group)`, leaving the deciding sibling outside it and above the boundary rather than beneath it.
`/explore` keeps its frame from `app/(public)/explore/(square)/loading.tsx` while
`explore/topic/[slug]` keeps its 404, verified in the built loader trees: `(square)/page.js` carries
the loading chunk and `topic/[slug]/page.js` carries none. `motir-core/CLAUDE.md` § _What to use
instead_ carries it as a fourth ✅.

**It changes rule 5's REASON and not rule 5.** The rule was never _a route boundary is impossible
here_; it is _a route boundary is declined here_. Three things decide it, and only the third is about
this group specifically:

|                                           |                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **it is still a ROUTE boundary**          | so it carries the locator cost below **in full** — React retains the previous route's subtree either way. A group scopes which routes are beneath a boundary; it does not change what a boundary does to the DOM                                                                                                                                            |
| **it does not reach window 1**            | the gate still runs before anything is flushed, and a group does not change when. Only the shell's mark reaches that window                                                                                                                                                                                                                                 |
| **the shape of THIS group is against it** | `/explore` is two routes and one boundary. `app/(authed)` is **58 routes with 11 deciders scattered across `settings/`, `items/`, `plans/`, `sprints/`, `dashboard/` and `direction/`** — six separate group carve-outs, each moving pages between directories, to buy a frame an in-page `<Suspense>` gives one page at a time with no tree surgery at all |

**So: correct instrument, wrong group — and that is a judgement to re-take, not a rule to inherit.**
A future authed subtree that is genuinely uniform — several routes, none deciding, one frame worth
sharing, no spec asserting unscoped against them — is the `/explore` shape, and the group is right
there. What must not happen is a carve-out justified by _the design says no `loading.tsx`_ when the
real reasons are the two rows above.

**The 24 heavy surfaces MOTIR-3440 sweeps, by whether a route boundary was ever available to them** —
measured at `origin/main` `4fd55464` with
`grep -rl 'notFound()' 'app/(authed)' --include=page.tsx`:

| family                       | surfaces                                                                                                                                                                                                                    | deciders among them                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| project settings (10)        | `settings/project`, and under it the board, workflow, automation, repositories, AI-planning and lesson-list panes, `settings/project/ai-planning/lessons/[lessonId]`, `settings/project/roles/[roleKey]` and its edit route | **3** — the lesson, the role, the role's edit         |
| workspace + organization (4) | `settings/workspace/jobs` · `settings/workspace/gitlab` · `settings/organization` · `settings/organization/billing`                                                                                                         | **1** — billing, the self-host 404 the A/B was run on |
| work-item lists (2)          | `items/archived` · `items/[key]/edit`                                                                                                                                                                                       | **1** — the edit route                                |
| canvases (4)                 | `roadmap` · `plans` · `plans/[id]` · `boards`                                                                                                                                                                               | **1** — `plans/[id]`                                  |
| its own card (1)             | `code-health`                                                                                                                                                                                                               | 0                                                     |
| reports + one-shots (3)      | `reports/burndown` · `sprints/[id]/report` · `invite/accept`                                                                                                                                                                | **1** — the sprint report                             |
| the non-regression (1)       | `items`                                                                                                                                                                                                                     | 0 — and it already streams                            |

**Seven of the 24, and five of the eleven deciders sit under `settings/`** — so the settings family,
the one place a shared boundary looked most obviously right, is the one place it is most obviously
wrong. The family's shared frame survives as a shared COMPONENT that all 31 routes render in-page; it
does not survive as `app/(authed)/settings/loading.tsx`.

### THE LOCATOR COST — decided, and the decision is not to incur it

**The cost belongs to the ROUTE boundary, not to the frame.** A route-level fallback makes React
retain the previous route's subtree mounted-and-hidden while the new one streams, so both are in the
DOM; Playwright resolves locators before filtering on visibility, so an unscoped `getByText` /
`getByTestId` / `getByLabel` matches both and fails strict mode. One group boundary turned **30
assertions across 17 spec files** red at once, and exactly zero of the 30 used `getByRole`, which is
immune because the accessibility tree excludes the hidden copy.

**An in-page `<Suspense>` renders INSIDE the destination page, so the previous route is already gone
and there is one subtree in the DOM.** Measured on the same file rather than argued:

| `tests/e2e/issue-detail-flow.spec.ts`                                   | result             |
| ----------------------------------------------------------------------- | ------------------ |
| with the `(authed)` group boundary                                      | **8 of 16 failed** |
| boundary removed, nothing else changed                                  | **16 passed**      |
| with the two in-page boundaries `/items/[key]` ships today (MOTIR-3436) | **16 passed**      |

and that file still contains **23** unscoped `page.getByText` / `getByTestId` / `getByLabel` calls
against 76 `getByRole` ones (counted at `origin/main` `4fd55464`). It is the spec most exposed to the
collision and it is green.

**So the decision is (b) of the two MOTIR-3492 offered — scope the boundaries, not the assertions.**
No spec is rewritten by this design and none needs to be; scoping the 30 to `getByRole` stays good
practice on its own merits and is a prerequisite of nothing here. **The standing rule this leaves:
a route-level boundary is a suite-wide change and an in-page one is a local change.** If a route
boundary is ever reintroduced, the 30 come back with it, and that is the number to weigh at the
moment of reintroducing it.

### THE REVEAL DELAY — 120 ms

**Unchanged, and it now governs both reveals** — the shell's mark in window 1 and the page's frame in
window 2. One declaration, referenced twice; two reveals at two times is the flicker this design
exists to remove.

```css
@keyframes nav-pending-reveal {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.nav-pending {
  animation: nav-pending-reveal 90ms ease-out 120ms both;
}
```

**Why the affordance is MOUNTED at 0 and not at 120.** Once the reader has committed to a
destination, the previous surface is lying. Mounting immediately is what makes the pending state the
thing on screen; the delay governs only whether the reader is shown it.

**Why 120, argued from the two states a reader can be in — the only two there are:**

| the window resolves                                                              | what the reader sees                                                                        | why the number holds                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **in under 120 ms** — a cached segment, an empty settings pane                   | the previous surface, then the destination. **Nothing pending is ever visible.** One paint. | 0.1 s is the classical ceiling for a response that reads as _instantaneous_. Inside it the navigation has already succeeded, and a state placed there is an interruption the reader has to parse and discard. 120 ms is that ceiling plus one 60 Hz frame of slack, so a route landing one frame late is still treated as instant. |
| **in longer than 120 ms** — Work Items, the item page, anything with a real read | the mark, then the frame, before their eye has finished travelling                          | the navigation has ALREADY failed to feel instantaneous, so a pending state is not an interruption — it is the only evidence the click landed. A saccade to the content region lands around 150–200 ms after the click, so a reveal begun at 120 ms is in place before the reader looks at it and they never see it arrive.        |

**It is an animation, not a timer, and that is load-bearing.** No `useEffect`, no `setTimeout`, no
client state, nothing to clean up when a navigation is abandoned: the element is removed and the
animation goes with it. A window that closes in 40 ms unmounts its affordance 80 ms before it would
have become visible, and no code had to decide that.

**Under `prefers-reduced-motion: reduce` the delay stays and the motion goes** — the reveal becomes a
step at 120 ms with no fade, and the pulse stops, leaving static blocks. The delay is not an animation
preference: it is what stops a fast route showing a state it does not need, and a reader who asked for
less motion asked for fewer flashes, not more.

### THE NO-SHIFT CLAIM — heights and gaps, never widths

**A layout shift on settle is VERTICAL.** The frame and the arriving page both fill `<main>`'s width,
so a placeholder bar being a different _width_ from the title it stands in for moves nothing — a
block-level line box occupies its whole line either way. What moves the page is a block whose
**height**, or the **gap above it**, differs from the region that replaces it. So the frame matches
heights and gaps exactly and takes its widths from what reads as a page.

| #   | block          | its box                                                                 | the region it becomes                                   | why the pair cannot shift                                                                                                                                                                                        |
| --- | -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Title          | `h-8` (32px) · `w-56`                                                   | the page's `<h1>` — `font-serif text-2xl font-semibold` | `text-2xl` is 1.5rem on a 2rem line box = **32px**. Same box, so the row below starts at the same y.                                                                                                             |
| 2   | Subtitle       | `h-4` (16px) · `w-80`                                                   | the optional `<p>` under the heading                    | present on Roadmap, Reports and every settings pane; **absent** on Work Items. See the compromise below.                                                                                                         |
| 3   | Toolbar        | `h-(--height-control)` · three chips                                    | the page's control row                                  | the real controls are all `--height-control`, so the frame inherits the height rather than restating it — and flips with the style axis for the same reason.                                                     |
| 4   | Content        | `rounded-(--radius-card)` bordered region · 40px header + 8 × 40px rows | the table, list or board the page renders               | 40px is the shipped table's own row height. Eight rows is a screenful and is deliberately not a count of anything.                                                                                               |
| —   | the column gap | `gap-6` (24px) on the outer flex column                                 | the `gap-6` every authed page already uses              | Work Items, Roadmap and both shipped settings `loading.tsx` files all open `flex flex-col gap-6`. The frame **is** that wrapper, so the vertical rhythm is not a copy of the pages — it is the same declaration. |

**At what widths.** All of it, and that is the point of measuring vertically. The frame adds **no
horizontal gutter of its own** — `app/(authed)/layout.tsx` already wraps `{children}` in
`px-4 pt-6 pb-(--shell-bottom-clearance) sm:px-6 lg:px-8`, and the frame renders inside that wrapper
exactly as a page does. A frame that re-applied the gutter would double it at every breakpoint. The
blocks' widths are `w-56` / `w-80` / fixed chip widths, which never reach the column's edge at any
authed width, so nothing reflows between breakpoints and there is no width at which the claim is
weaker.

**The subtitle block is the one honest compromise, and it is stated rather than hidden.** A frame that
draws a subtitle settles **20px UP** on a page that has none; a frame that omits it settles 20px DOWN
on the majority that do. Drawing it is the better half — an upward settle pulls content toward the
reader's eye rather than away from it, and the pages carrying no subtitle (Work Items, Boards) are
also the fast ones, which under the reveal delay usually never show the frame at all. **A route that
both carries no subtitle AND reads slowly should pass its own body to `PageSkeleton` rather than take
the generic one** — which under this revision is a prop, not a second boundary.

### THE SWITCH RULE — a client-only view switch shows NO pending state

**Unchanged by this revision, and it is the one part of the first one that shipped.** When a toggle's
target body needs no new server data, there is nothing to wait for. Draw no spinner, disable no
segment, show no skeleton, dim nothing. The body is simply there, in the same frame as the click. A
pending affordance on such a switch is a **defect**, not a courtesy: it manufactures a wait the reader
would not otherwise have had, and it is the complaint this story was reported for, reintroduced as a
feature.

**The three call sites it governs** — drawn at rest in both positions in Panel E, re-pointed at the
lifted helper by MOTIR-3434, and guarded by `tests/navigation/loading-boundary-guard.test.ts`:

| call site                                             | param                    | why the server has nothing to say                                                                                            |
| ----------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `components/planning/PlanDetail.tsx`                  | `?view=list\|canvas`     | both bodies render from the `review` the island already holds in `useState`                                                  |
| `app/(authed)/items/[key]/_components/ChildPanel.tsx` | `?children=list\|graph`  | the list body IS the already-rendered `children` prop; the graph mounts a client canvas that fetches its own level           |
| `components/planning/RoadmapView.tsx`                 | `?scope=project\|sprint` | the canvas refetches on its `key={scope}` remount — the file's own comment already says the navigation is not what drives it |

**Three switches are NOT governed by it and keep their `router.push`:** Work Items' tree ↔ list, the
plans list's status tabs, and the item page's activity tabs. Each changes what the server must fetch,
so each is a real navigation — and under this revision each is entitled to the shell's MARK (via
`startTransition`, above) and to its destination's own frame. **The discriminator is not the control**
— all six are the same `Segmented` — **it is whether the target body needs data the browser does not
have.**

### Primitives and tokens

| element                     | primitive / token                                                                         | note                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the frame's wrapper         | `flex flex-col gap-6`                                                                     | the same wrapper an authed page opens with; no gutter — the layout's `{children}` wrapper already pays it                                                                                                                                                                                                                                                            |
| every placeholder block     | `bg-(--el-muted)` fill · `rounded-(--radius-control)`                                     | the shipped pulse vocabulary — `IssueTreeSkeleton`, `BacklogSkeleton`, `BoardSkeleton` and `PlanningWorkspaceSkeleton`. **This design does not redraw any of them**; `components/settings/SettingsPaneFrame.tsx` is the closest existing composition and is the reference (it carries what the two settings `loading.tsx` files drew before MOTIR-3558 deleted them) |
| the pulse                   | `animate-pulse` on the inner wrapper                                                      | one animation for the whole frame, so the blocks pulse in phase rather than as a field of independent flickers                                                                                                                                                                                                                                                       |
| the content region's chrome | `rounded-(--radius-card)` · `border-(--el-border)` · header band `bg-(--el-surface-soft)` | mirrors the shipped table container, which is what makes block 4 a stand-in rather than a rectangle                                                                                                                                                                                                                                                                  |
| the toolbar chips           | `h-(--height-control)`                                                                    | the height every real toolbar control already takes                                                                                                                                                                                                                                                                                                                  |
| status-pill placeholders    | `rounded-full`                                                                            | genuinely circular ends; the shape rule's carve-out, matching the shipped `Pill`                                                                                                                                                                                                                                                                                     |
| the shell's pending mark    | `--el-sidebar-item-bg-hover` fill · `--el-text` ink                                       | the rail item's own hover pair, HELD. It exists in the build only as a `hover:` variant, so the treatment is a state the component already owns rather than a new one — no new hue, and no size change, because a mark that resizes moves the rail                                                                                                                   |
| the announced state         | `aria-busy="true"` on the frame and on the marked link; blocks are decorative             | the reader of a screen reader is told the region is busy once, not eight times                                                                                                                                                                                                                                                                                       |
| the reveal                  | `nav-pending-reveal` keyframe, `120ms` delay, `90ms ease-out`, `both`                     | the one declaration; window 1 and window 2 both reference it                                                                                                                                                                                                                                                                                                         |

**No Tier-0 anything.** No `--color-*`, no `rounded-md`/`p-2`/`h-9`, no invented hue. The board's own
chrome takes `--el-text-secondary` for annotation ink rather than `--el-text-muted`, which fails AA on
`--el-surface-soft` and on `--el-muted` — the two surfaces this board's tables and rule blocks paint
on (`docs/decisions/design-board-chrome-aa.md`).

### The access path

**This state has no menu entry: its entrance is every navigation in the group.** That is why the asset
opens with a TRANSITION rather than a screen — Panel A draws the surface being left, the window in
which deliberately nothing happens, the gate window with the shell's mark on it, the page's own frame
after the flush, and the arrival, with the shell held identical throughout. A single still of a
skeleton could not show the reveal delay, the three windows or the no-shift claim at all; the
sequence is what makes them readable.

### The design-allocation sweep — what this asset GIVES and TAKES

| card                                                   | GIVES / TAKES | what                                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-3434** — `shallowUrl` and the three call sites | **GIVES**     | the switch rule, unchanged from the first revision and already shipped. This revision takes nothing back from it                                                                                                 |
| **MOTIR-3440** — the remaining-surfaces story          | **GIVES**     | the three windows, the in-page mount point, the earn-a-frame rule, the per-family decider count, and the locator decision. **TAKES** its "settings gets a frame of its own" premise, which named a `loading.tsx` |
| **MOTIR-3441** — the settings family's arrival frame   | **GIVES**     | that the family shape survives as a shared COMPONENT rendered in-page by all 31 routes, and that five of the eleven deciders are inside that family                                                              |
| **MOTIR-3442** — the earn-your-own-frame rule          | **GIVES**     | the rule in full, above. **TAKES** its "instead of the group's" framing: there is no group's frame to be an alternative to                                                                                       |
| **MOTIR-3492** — this card                             | **TAKES**     | everything the first revision said about a route-group boundary                                                                                                                                                  |
| **MOTIR-3491** — the `/explore` 404 fix                | **TAKES**     | the two-option framing. It shipped the ROUTE-GROUP instrument mid-review and proved it on a live surface, so rule 5 now reads _declined for this group_ with its reasons, rather than _there is no other way_    |

### ⚠️ What this asset SPECIFIES that no card owns

Named here rather than left to be inferred, because all three are things the first revision's code
cards built and the revert removed. **This asset does not create them, and it is not a plan:**

1. **`PageSkeleton`** — the shared primitive owning the wrapper, header block and reveal. Built by
   MOTIR-3433, reverted with it. Every in-page frame composes it, so nothing above can be built first.
2. **The shell's pending mark** (window 1) — the `useLinkStatus` wrapper and its adoption by the rail.
   MOTIR-3433 spent this window on the group boundary instead, so it has never been built.
3. **`/items/[key]`'s own frame** (window 2) — MOTIR-3435's boundary half was reverted, so the page
   today flushes nothing until its tier-2 group resolves. Its concurrency half shipped and stands.

### What this design overrides

**Its own first revision, MOTIR-3431's, and only in the mount point.** (And it was itself amended
once before merging, by MOTIR-3491 landing on `main` mid-review — the third-instrument section above.
The amendment is recorded there rather than folded in silently, because a reader who meets a route
group in this codebase should find the moment this asset learned about it.) The frame's composition, the
reveal delay, the no-shift mapping and the switch rule are carried forward verbatim; what is withdrawn
is the route-group boundary that mounted them, the sentence _"one `app/(authed)/loading.tsx` is the
floor for all 58 pages"_, and the nearer-boundary table that read `the group frame` against
`a route-shaped frame`. Two adjacent facts it still does **not** change, named so a reader does not
infer them:

- **`app/(planning)/loading.tsx` stays as it is** (MOTIR-2069), and the two under `settings/project/`
  stay as they are. They sit above no page that calls `notFound()`, so the rule does not reach them;
  rule 5 above is a preference for new work, not a sweep of existing files.
- **The four existing `_components` skeletons stay as they are.** They are `<Suspense>` fallbacks
  INSIDE a page — which is now the sanctioned shape rather than the tolerated one — and this design
  supplies the vocabulary they already speak and takes nothing from them.

### How the render was produced

The asset is generated, not hand-drawn, so it cannot drift from the app:

1. The top bar in every frame is the real `app/(authed)/_components/TopNav.tsx`, taken from this area's
   own `context-row.mock.html` Panel A — captioned there as _"what ships today, rendered"_.
2. The rail is the real `SidebarNav variant="rail"`, and the settled Work Items page is the real
   `IssueTreeStaticTable` over the real `buildIssueColumns` registry — both dumped from the repo's own
   vitest + RTL setup with the real `messages/en.json`. The three switches are the real `Segmented`, in
   the exact option sets its three call sites pass it.
3. Tailwind compiles `app/globals.css`'s layers over that markup, so the mock's stylesheet is the
   build's own output rather than a retyped token block.
4. **This revision re-uses those renders unchanged and edits only what the constraint falsified** —
   the sequence's captions and mechanism, the rule panel, and the two panels added for the shell mark
   and the locator decision. Re-generating the shipped-component regions would have changed pixels
   that no finding touched, and made the diff unreadable for the reviewer who has to check the part
   that did change. The PNG is re-exported with `node scripts/render-design-mock.mjs`.

The only markup here that is **not** already shipped is the pending frame, the shell's mark, and the
keyframe beside them — which is what this card exists to decide.

Two board artefacts, named here so nobody reads them as design: the shell stages are held at a fixed
**560px** so the sequence reads as one, where the app's shell is `h-dvh`; and the frames that show a
revealed state force the animation's end state, because a board is a still and a time-based state has
to be frozen at the moment it is being drawn.

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
- **⚠️ AMENDED by MOTIR-2675 (2026-08-11), after drawing it: in a LIST the NAME keeps one left
  edge.** This clause used to read _"rows do not indent to a phantom column … the row's text
  therefore shifts left"_, and it was written without a list in front of it. `MOTIR-2675` drew the
  switcher at four rows, two imaged and two not, and **the ragged name edge reads noticeably worse
  than this predicted** — the un-imaged names hang left of the imaged ones and the list stops
  scanning as a column.
  **The corrected rule: a LIST row holds the 24px slot open; the BAR does not.** Nothing is drawn in
  that slot — no border, no fill, no glyph — so the no-mark rule holds exactly; what is preserved is
  ALIGNMENT, which is a property of the list rather than a mark. A single BAR tier has no column to
  align to, so there the gap simply closes. Measured after the fix: all four names start at the same
  x. Recorded here rather than only in the projects asset, because a spec that two assets disagree
  about is worse than either answer.
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

## The rail's bottom section — every row it renders (MOTIR-4130)

`rail-bottom-section.mock.html` / `.png` is **the design of record for the authed rail's bottom
section**: the six rows it carries, at all three widths the shell draws, in both arms of every
conditional row.

### Why the area owed this

The section grew one row at a time, and every row was added by a card that was about the
DESTINATION rather than about the rail — a documentation index, a legal document set, an operator's
job-runs surface, a workspace security policy. Adding a row to a nav is a two-line change at the end
of such a card, and nothing in any of their worlds pointed back at an asset in a different area. So
each asset stayed correct about the day it was drawn and quietly wrong about every day since.

**The measurement, at `8d80ac8db`.** Fourteen rails across six assets draw this section, and **not one
of them drew the `Legal` row or the `Security` row**:

| Asset                          | Rails | The bottom section it draws             | Short by |
| ------------------------------ | ----- | --------------------------------------- | -------- |
| `desktop.pen`                  | 1     | Settings · Docs                         | **4**    |
| `desktop-collapsed.pen`        | 1     | `settings` · `book-open` (icon-only)    | **4**    |
| `mobile-drawer.pen`            | 1     | Settings · Docs                         | **4**    |
| `navigation-pending.mock.html` | 4     | Settings · Job runs · Git · Docs        | **2**    |
| `top-bar.mock.html`            | 1     | Settings · Job runs · Git · Docs        | **2**    |
| `design/home/home.mock.html`   | 6     | Job runs · Git · Docs (Settings on one) | **2–3**  |

Method: parse each `.pen` as JSON and walk to its `Nav Section Bottom` frame; load each `.mock.html`
in Chromium and enumerate every `[data-surface="sidebar"]`'s rows. **The count is the section's, not
a list of the rows anyone had in mind** — the card that filed this defect enumerated three rows where
six ship, because it inventoried the rows whose provenance it already held rather than reading the
section (MOTIR-4163).

### What the section actually carries

Declaration order, from `app/(authed)/_components/SidebarNav.tsx`'s `sections.push({ id: 'bottom' })`:

| #   | Row          | Glyph          | Destination                                         | Rendered                                  |
| --- | ------------ | -------------- | --------------------------------------------------- | ----------------------------------------- |
| 1   | **Settings** | `settings`     | `/settings/project`, else the settings home         | CONDITIONAL — `showSettingsDoor`          |
| 2   | **Security** | `shield-check` | `/settings/workspace/security`                      | CONDITIONAL — `workspaceTierRevealed`     |
| 3   | **Job runs** | `list-checks`  | `/settings/workspace/jobs`                          | always                                    |
| 4   | **Git**      | `git-branch`   | `/settings/workspace/github`                        | always                                    |
| 5   | **Docs**     | `book-open`    | the operator's own ABSOLUTE url — `docsIndexUrl()`  | CONDITIONAL — `docsIndexUrl` is non-null  |
| 6   | **Legal**    | `scale`        | the operator's own ABSOLUTE url — `legalIndexUrl()` | CONDITIONAL — `legalIndexUrl` is non-null |

**Four of the six are conditional, and the section's FLOOR is two rows** — Job runs · Git. That
floor is the open product's common case, not an edge state, which is why the asset draws it beside
the complete arm at every width rather than describing it. (It was three rows in this asset's first
revision, when the `Docs` row was unconditional and dead — see MOTIR-4167 below.)

**Nothing marks an absent row.** The rows close up and the section is shorter; there is no disabled
row, no tooltip and no empty state. `SidebarNav.tsx`'s own comment carries the reason and it is the
rule for the whole section: _an entry point is a promise about a room, and a disabled row is a promise
the product then refuses._

**The `Legal` row's absent arm has TWO causes, and the second is easy to miss.** `legalIndexUrl()`
derives the index from the configured documents' own urls: if every one is `<base>/<slug>` the index
is `<base>`. An operator publishing at unrelated addresses (`acme.com/terms-of-service`,
`legal.acme.com/privacy`) has no index for the row to point at, so **the row is absent rather than
guessed** — sign-up and the re-consent rows still link each document directly, so nothing becomes
unreachable. A row pointing at the base of SOME of the documents would be worse than no row.

### The `Docs` row reads configuration — MOTIR-4167

The row used to carry a hard-coded app-relative path to the documentation index, and that page left
this repository when MOTIR-3932 moved the public reading surface to `motir-marketing`; the row was
not moved with it. Verified at `8d80ac8db`: no route under `app/**`, no redirect source for the docs
path in `next.config.ts` (`DOCS_REDIRECTS` makes it a DESTINATION, never a source), no `rewrites()`,
nothing in `middleware.ts` — so `app.motir.co/docs` answered **404** while `motir.co/docs` answered
**200**. This asset's first revision drew the dead href anyway, because it is the design of record
for what the rail DOES, and parked the address in `tests/design-asset-addresses.test.ts`'s `KNOWN`
table with a reason naming the defect — distinct from that table's seven other entries for the same
address, which are point-in-time records of assets drawn before the move and are left alone.

**The row beside it was the fix, and it is now the same row.** `Legal` lost its destination to the
same split and was rebuilt around `legalIndexUrl()` — a resolver returning `string | null`, resolved
in `app/(authed)/layout.tsx` and threaded to the client component as a prop, with the row spread in
conditionally. `Docs` takes exactly that shape: `lib/docs/links.ts`'s `docsIndexUrl()` reads
**`MOTIR_DOCS_URL`**, the operator's own ABSOLUTE url of the published documentation
(`https://motir.co/docs` on the hosted deployment), and answers `null` when it is unset — or when the
value is not an absolute `http(s)` url, because a relative path is precisely the defect, so it is
refused and logged rather than rendered. **When it is `null` the row is absent**, not disabled and not
dead. `docs/decisions/public-surface-hosts.md` AMENDMENT 2 §D (its MOTIR-4167 amendment) is the
record, with the alternatives it rejected; `tests/components/SidebarNav-docs-door.test.tsx` pins both
arms of the row and `tests/docs/docsLinks.test.ts` both arms of the resolver plus the refusal.

**So the floor moved.** With four conditional rows the section's floor is **two** — Job runs · Git —
and that is what the floor arms now draw at all three widths; the complete arms draw the row at its
configured absolute url. The two `KNOWN` entries this asset and these notes carried for the dead
address went with the defect.

### The divergence ledger — which source wins for this element

| #   | The older assets say                                                                                          | This asset says                                                                                                                                                                                                                                       | Since      |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `desktop.pen` · `desktop-collapsed.pen` · `mobile-drawer.pen` draw **Settings · Docs** and nothing else       | **Six rows**, three of them conditional. **This asset WINS for the bottom section**; those three keep the PRIMARY section, the rail head, the top bar and the drawer chrome, which this asset does not draw.                                          | MOTIR-4130 |
| 2   | The three `.pen` sources cannot be corrected in place                                                         | **They are not edited.** Pencil is not in this tree, so a `.pen` edit produces a source disagreeing with the `.png` every consumer opens — a second divergence, not a fix. The same call `design/auth/` made for its own legacy artboards.            | MOTIR-4130 |
| 3   | `navigation-pending.mock.html`, `top-bar.mock.html` and `design/home/home.mock.html` draw four rows, or three | Those rails are **context for something else** — a pending grammar, a control budget, a landing surface — and are not the source for this section. They are re-exportable and may be swept, but a reader asking _what belongs here_ reads THIS asset. | MOTIR-4130 |

**The toolchain question this card had to answer first, and its evidence.** No `.pen` renderer or
exporter exists anywhere in the repository: the only files naming `.pen` are two guards, `CLAUDE.md`
and `scripts/plan-seed/` data, and `package.json` carries no Pencil dependency and no design-export
script. The one renderer present is `scripts/render-design-mock.mjs`, which takes `*.mock.html`. So
the `.mock.html` route was not a preference — it was the only route with a working export.

### Primitives and tokens

The asset composes **no new primitive**. Every rail is `components/ui/Sidebar.tsx` — `SidebarNavItem`
for a row (`--height-control`, `--radius-control`, `--spacing-control-x`, `--el-text-secondary` ink,
`--el-icon-muted` glyph, `--el-sidebar-item-bg-hover`), the `role="separator"` div between sections
(`--el-sidebar-border`), and the rail itself (`--el-sidebar-bg`, `data-surface="sidebar"` so a
material style can frost it). The drawer chrome is `components/ui/SidebarDrawer.tsx`'s header row
verbatim. Widths are the shipped ones: `AppLayout`'s grid column is **240px** expanded and **56px**
collapsed, and `SidebarDrawer`'s default width is **300px**.

Board chrome routes every colour through `--el-*` and takes `--el-text-secondary` for body ink rather
than `--el-text-muted`, which fails AA on three of the four surfaces it could land on
(`docs/decisions/design-board-chrome-aa.md`).

### The access path

The section has no entrance to draw: it IS an entrance, and it is always on screen wherever the
authed shell is — beneath the primary section, above the collapse toggle. Below `md` it is reached
through the hamburger, which opens the drawer the asset's Panel C draws.

### How the render was produced

Generated, not hand-drawn, so it cannot drift from the app:

1. The real `Sidebar` is rendered through the repo's own vitest setup with `renderToStaticMarkup`, in
   six states — expanded / collapsed / drawer × complete / floor. **Only the SECTION DATA is
   authored**, and it is the six entries `SidebarNav.tsx` pushes, with the real `messages/en.json`
   labels, the real hrefs and the real lucide glyphs.
2. `tailwindcss`'s own `compile()` API runs `app/globals.css` over that markup, so the stylesheet is
   the build's output rather than a retyped token block.
3. The frames are measured after rendering: every row's box is asserted inside its frame, so no row
   is clipped or scrolled out of view. **This caught a real defect** — at the first frame height the
   `Legal` row, the one the card is named after, was scrolled out of all three complete arms and the
   asset looked finished.

One board property, named here so nobody reads it as design: the frames give the rail a fixed height
so all ten rows fit, where the real rail is `h-full` in a viewport-height grid column.

**Revised by MOTIR-4167 without re-running the generator.** The generator was a temporary harness
(deleted with MOTIR-4130's run, as the design lane's own rule requires), and the revision changes
only the SECTION DATA it would have been fed: the `Docs` row's `href` in the three complete arms, and
the row's absence from the three floor arms. Those are the two edits made to the generated markup,
so every rail is still the real `Sidebar` output; `prettier --write` then
`scripts/render-design-mock.mjs` re-exported the `.png`.

### What this asset does NOT draw

The **primary** section (`desktop.pen` still owns it — the four rows above the separator are
abbreviated context, not a specification), the rail **head** (`context-row.mock.html`), the collapse
**toggle** in the footer, and the drawer's **utility strip** (`top-bar.mock.html` Panel D, MOTIR-2374).
