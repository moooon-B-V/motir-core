# App-shell accessibility audit

This file is the running accessibility log for Prodect's app shell and the
surfaces that render inside it. Automated coverage lives in
`tests/e2e/shell-a11y.spec.ts` (axe-core, WCAG 2.1 AA) and
`tests/e2e/shell-keyboard.spec.ts` (keyboard-only navigation); this document
records the **manual** checks that automation can't fully assert — screen-reader
smoke tests, breakpoint sweeps, and contrast spot-checks — plus the a11y
decisions baked into the shell.

Each Story that adds a new shell-bearing surface (Epics 2–7) appends an entry
here and extends the route list in `shell-a11y.spec.ts`.

---

## 1.5.5 — App shell (Story 1.5)

**Date:** Story 1.5 close-out.
**Scope:** the shell wired across Subtasks 1.5.1–1.5.4 — `AppLayout` (skip-link,
top-nav, sidebar rail / off-canvas drawer, content region), the `⌘K` command
palette, the tri-state theme toggle, and the `?` shortcuts cheatsheet.

### Automated coverage (CI)

- **axe-core (WCAG 2.1 A + AA)** runs against every shell-bearing route —
  `/dashboard`, `/issues`, `/boards`, `/reports`, `/settings/workspace`,
  `/settings/project` — plus the public `/tokens` design-system specimen. Zero
  violations required; a failure prints the rule id, help URL, and offending
  selector(s).
- **Keyboard-only journey**: Tab → skip-link → activate → Tab into `<main>` →
  `⌘K` palette → type-filter → `↓` / `↵` to navigate → `⌘\` collapse rail →
  `?` cheatsheet → `Esc` close. No pointer events used.

### Structural a11y contract (asserted in the specs)

- **Two named `<nav>` landmarks**: the global top bar (`aria-label="Global"`)
  and the primary rail (`aria-label="Primary"`). Distinct names satisfy axe's
  `landmark-unique` rule and let AT users jump between them.
- **`aria-current="page"`** on the active sidebar item; absent on the rest.
- **Skip-link first**: `AppLayout`'s first focusable element is an
  `href="#main"` skip-link (`sr-only` until focused), and `<main id="main"
tabIndex={-1}>` is its programmatically-focusable target.
- **Collapse toggle = disclosure**: the rail's collapse control carries
  `aria-expanded` reflecting the rail state (W3C APG _Disclosure_ pattern).
  Changed from `aria-pressed` in this Subtask — a show/hide region control is a
  disclosure, not a toggle button.
- **Command palette = modal dialog**: Radix `Dialog` renders `role="dialog"` +
  `aria-modal="true"`, named "Command palette"; the search input has
  `aria-label="Search commands"`, the listbox uses `role="listbox"` /
  `role="option"` with `aria-activedescendant` tracking the highlighted row.

### Manual checks performed

- **Screen-reader smoke (VoiceOver / macOS, NVDA / Windows):**
  - Landmark rotor announces "Global navigation" and "Primary navigation" as
    distinct regions; main content reachable via the skip-link as the first
    stop.
  - Opening `⌘K` announces the dialog and moves the virtual cursor into it;
    `↑`/`↓` announce each option's label and selected state; `Esc` returns focus
    to the trigger.
  - The `?` cheatsheet announces its title and the shortcut rows (label + key
    chips) in reading order.
  - The collapse control announces its name ("Collapse sidebar" / "Expand
    sidebar") and expanded/collapsed state.
- **Breakpoints:** verified the shell at 375px (mobile — rail becomes the
  off-canvas drawer opened by the top-nav hamburger), 768px (`md` — persistent
  rail appears), and 1280px (desktop). Drawer focus is trapped while open and
  `Esc` closes it.
- **Color contrast:** spot-checked sidebar item text (active + idle), top-nav
  controls, command-palette rows, and the `:focus-visible` ring against their
  backgrounds across both color modes (light/dark) and both display styles
  (default/soft) using the design-system `--el-*` tokens. axe's
  `color-contrast` rule covers the rendered routes; the manual pass covered the
  collapsed rail's icon-only rows (which only appear after a runtime toggle).

### Violations found + dispositions

The axe sweep surfaced real issues; each was fixed or tracked:

- **`Pill` colored tones fail WCAG AA contrast** (light mode): the
  `severity` (info/success/warning/danger) and `status` (in-progress/done) tones
  render a saturated hue on its own light tint (e.g. `--color-info` #0075de on
  `--color-tint-sky` #dcecfa = 3.78:1, below 4.5:1). This is a **systemic
  design-system issue** needing a reviewed color pass, not a shell-test fix —
  logged as **PRODECT_FINDINGS #35**. The one place a colored tone reached a
  shell surface (the workspace **member-count + role badges**, plus the
  workspace/project switcher chips) was a _misuse_ — counts, roles, and an
  "Archived" state are metadata, not severities — so those switched to a new
  AA-safe **`Pill tone="neutral"`** (dark slate text on `--color-surface`).
  Shell routes are now strictly clean; the `/tokens` specimen still renders the
  full colored matrix, so its `color-contrast` rule is explicitly excluded with
  a reference to #35.
- **`aria-prohibited-attr` on `/tokens` color swatches**: the decorative chip
  `<div aria-label=…>` is invalid (a bare div can't take `aria-label`) and
  redundant (the label is visible text below). Fixed — the chip is now
  `aria-hidden`.
- **No `aria-modal` on the `⌘K` dialog**: Radix Dialog v1.1.15 is modal-by-
  default but doesn't emit `aria-modal`; set explicitly on the palette content.
- **`aria-expanded` on the collapse toggle**: was `aria-pressed` (toggle-button
  semantics); switched to `aria-expanded` (disclosure semantics — the control
  shows/hides a region).
- **Unnamed top-nav landmark**: added `aria-label="Global"` so the two `<nav>`s
  have distinct names.

### Notes / deferrals

- The `g`-prefix go-to-nav chips from the 1.5.1 mockup remain deferred
  (PRODECT_FINDINGS #32 — `useShortcut` has no two-key-sequence support); they
  are not part of this audit.
- `/tokens` is a dev-only specimen, not a production shell surface, but is
  scanned because it renders every primitive together — a useful early-warning
  for token-level contrast/aria regressions.
