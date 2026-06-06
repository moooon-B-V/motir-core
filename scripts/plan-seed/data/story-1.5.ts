import type { PlanStory } from '../types';

/**
 * Story 1.5 — Web app shell + navigation.
 * Faithful transcription of prodect_plan/story-1.5-app-shell.html (frozen archive).
 */
export const story_1_5: PlanStory = {
  id: '1.5',
  title: 'Web app shell + navigation',
  status: 'done',
  descriptionMd:
    'The chrome every signed-in surface lives inside: a persistent **left sidebar** ' +
    'holding project-scoped navigation (Issues, Boards, Settings), a thinner **top nav** ' +
    'for workspace switching + user menu + theme + cmd-k, and a **main content panel**. ' +
    "Replaces 1.3.4's temporary top-nav project switcher with the durable sidebar-driven IA " +
    'Linear / Jira / GitHub Projects all use. Responsive (collapses to a drawer below the ' +
    '`md` breakpoint), keyboard-navigable end-to-end, theme-aware via the existing two-axis ' +
    'ThemeProvider from Story 1.0.5. No new data layer — every Subtask composes existing ' +
    'primitives + already-shipped services.\n\n' +
    '**Prerequisites:** [Story 1.0.5](story-1.0.5-design-system.html) is the load-bearing ' +
    'dependency — the sidebar, command palette, and theme toggle all compose existing primitives ' +
    '(Button, Dialog, Tooltip, Popover, Toast, the ThemeProvider in `lib/theme/`, the `--el-*` ' +
    'token vocabulary). [Story 1.2](story-1.2-workspaces.html) ships the `WorkspaceSwitcher` ' +
    'the new top-nav consumes; [Story 1.3](story-1.3-projects.html) ships `ProjectSwitcher` + ' +
    '`getActiveProject()`. After 1.5, the top-nav project switcher from 1.3.4 is retired — the ' +
    'sidebar header carries it.',
  verificationRecipeMd:
    '- Pull the merged Story branch; `pnpm install && pnpm dev`.\n' +
    '- Sign in (use the seeded auth-credentials fixture user); confirm landing at `/dashboard` ' +
    'with the sidebar visible on the left and the top-nav across the top.\n' +
    '- Click "Issues" / "Boards" / "Reports" / "Settings" in the sidebar — each navigates and ' +
    'the active item highlights.\n' +
    '- Click the sidebar collapse button → sidebar shrinks; reload → still collapsed. Click ' +
    'again → expands; reload → still expanded.\n' +
    '- Press `⌘K` → palette opens. Type "issues" → highlighted match. `↵` → URL is /issues.\n' +
    "- Press `⌘K` → type the alternate workspace's name → ↵ → workspace switches (cookie + " +
    'sidebar contents reflect it).\n' +
    '- Press `⌘K` → type "theme" → ↵ → the theme toggles (light ↔ dark). Reload → preserved.\n' +
    '- Press `?` → shortcut cheatsheet opens, listing ⌘K / ⌘\\ / ? at minimum. `esc` → closes.\n' +
    '- Resize to a 375×812 viewport → sidebar disappears, hamburger appears in top-nav. Click ' +
    'hamburger → drawer slides in with scrim. Click an item → drawer closes after route change.\n' +
    '- Open the user menu → "Sign out" → redirected to /sign-in. Sign back in.\n' +
    '- Press `⌘K` → "Sign out" → same outcome (palette path).\n' +
    '- Sign in as a user with zero projects in their workspace (or temporarily archive all ' +
    'projects via Settings → Project) → confirm the sidebar header shows the projects ' +
    'empty-state CTA inline and project-scoped nav is hidden.',
  items: [
    {
      id: '1.5.1',
      title:
        'Mockups: app shell (sidebar + top-nav + main) — desktop, collapsed-sidebar, mobile-drawer, cmd-k palette',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.0.5.2', '1.0.5.3'],
      descriptionMd:
        'Produce viewable mockups of the app shell across its three breakpoints + two interaction ' +
        'states, BEFORE any production React lands. Per Principle #13: design-before-code within ' +
        'every Story. The shell is the chrome every Epic-2-through-7 surface renders inside, so ' +
        'getting the IA + visual density right here pays back across the entire build.\n\n' +
        '**Why mockups instead of straight-to-code:** the existing ' +
        '`(authed)/_components/TopNav.tsx` carries a comment that says "Story 1.5 will move ' +
        'project nav into a left sidebar, at which point the top-nav project switcher is demoted ' +
        'or retired" — but the exact division (what stays in top-nav vs. moves to sidebar, what ' +
        'the collapsed-sidebar shape is, how the mobile drawer animates in) was never pinned. The ' +
        'mockup is where that gets pinned, with the design-system primitives (Button, Card, ' +
        'Tooltip, Popover) composed visually so the code Subtask can compose the same primitives ' +
        'in code. Mockup also reveals whether the cmd-k palette fits the existing Dialog primitive ' +
        '(it should) or needs a new wrapper.\n\n' +
        "**What you'll do:** Open `@pencil.dev/cli` (per " +
        '`feedback_pencil_cli_for_design_subtasks` — the desktop MCP has no `save()`). Compose ' +
        'with canonical primitives only — Button, Input, Card, Avatar, Badge, Popover, Dialog ' +
        'from `components/ui/`. Lay out:\n\n' +
        '- **Desktop persistent** (`/design/shell/desktop.pen`): top-nav (workspace switcher · ' +
        'theme toggle · cmd-k trigger · user menu) + left sidebar (project switcher in sidebar ' +
        'header · "Issues" · "Boards" · "Reports" · divider · "Settings" · "Docs" · footer ' +
        'collapse-toggle) + main panel with the dashboard surface. ~240px sidebar width; main ' +
        'panel uses the existing `max-w-6xl mx-auto px-4 sm:px-6` container — sidebar is OUTSIDE ' +
        'the container so it pins to viewport edge.\n' +
        '- **Desktop collapsed-sidebar** (`/design/shell/desktop-collapsed.pen`): sidebar narrows ' +
        'to ~56px, icon-only, with tooltips on hover that show the full label. Same content, same ' +
        'order. The toggle in the sidebar footer (chevron-double-left ↔ chevron-double-right) ' +
        'drives this state; preference is persisted in localStorage.\n' +
        '- **Mobile drawer** (`/design/shell/mobile-drawer.pen`): viewport < `md` (768px). ' +
        'Top-nav adds a hamburger button on the left. Sidebar becomes an off-canvas drawer that ' +
        'slides in from the left with a scrim behind. Drawer header shows the project switcher; ' +
        'drawer body shows the same nav as desktop. Drawer closes via scrim click, escape key, or ' +
        'hamburger.\n' +
        '- **Cmd-K palette** (`/design/shell/cmd-k.pen`): centered Dialog ~640px wide, search ' +
        'input at top, grouped action list below (Navigation / Workspace / Project / Account). ' +
        'Selected row highlighted, kbd hint chips on the right for shortcut keys, footer hint ' +
        'strip ("↑↓ to navigate, ↵ to select, esc to close"). Show with an empty query (all ' +
        'actions visible, grouped) AND with the query "iss" (filtered to "Go to Issues" + ' +
        '"Switch workspace if its name contains \'iss\'").\n' +
        '- **Shortcuts cheatsheet** (`/design/shell/shortcuts.pen`): a Dialog opened by pressing ' +
        '`?`, listing every shortcut the shell registers — ⌘K (palette), ⌘\\ (toggle sidebar), ' +
        '? (this dialog), g→i / g→b / g→r (g-prefix go-to navigation, Linear convention), esc, ' +
        'etc. Two columns: shortcut chip on the left, action label on the right.\n\n' +
        '**Brand-mark deferral** (PRODECT.md): no wordmark / logomark anywhere in these mockups. ' +
        'The top-nav left edge sits empty where a logo would otherwise live; do not invent ' +
        'placeholder branding (mistake #19 + #26). Save `.pen` sources AND PNG exports for each ' +
        'surface.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Five `.pen` files exist under `/design/shell/` with PNG exports alongside (desktop, ' +
        'desktop-collapsed, mobile-drawer, cmd-k, shortcuts).\n' +
        '- Sidebar shows: project switcher in header, "Issues" + "Boards" + "Reports" placeholder ' +
        'links, a hairline divider, "Settings" + "Docs" links, footer collapse-toggle. Active ' +
        'route is visually distinguished (bg + foreground color shift).\n' +
        '- Top-nav after 1.5: workspace switcher · theme toggle (with tri-state icon) · cmd-k ' +
        'trigger (button labeled "Search" with ⌘K hint chip) · user menu. NO project switcher ' +
        '(moved to sidebar). NO wordmark slot.\n' +
        '- Mobile drawer mockup shows the off-canvas position, scrim, hamburger entry point, and ' +
        'the in-drawer header carrying the project switcher.\n' +
        '- Cmd-K mockup shows grouped actions, kbd hint chips, footer hint strip, AND the filtered ' +
        'state for the "iss" query (proves the visual treatment of filtering).\n' +
        '- Shortcuts cheatsheet enumerates ≥6 shortcuts with their action labels.\n' +
        '- All surfaces compose only existing primitives (Button, Input, Card, Avatar, Badge, ' +
        'Popover, Dialog, Tooltip). No new design tokens introduced.\n' +
        '- Mockups respect the brand-mark deferral principle — no wordmark / logomark anywhere.\n' +
        '- Any pattern that does not compose cleanly from existing primitives surfaces as a finding ' +
        'in [PRODECT_FINDINGS.md](PRODECT_FINDINGS.md) before merging (per mistake #27).\n\n' +
        '## Context refs\n\n' +
        '- `/docs/design-system.md` — canonical visual reference\n' +
        '- `/components/ui/Button.tsx, Card.tsx, Dialog.tsx, Popover.tsx, Tooltip.tsx` — ' +
        'primitives to compose from\n' +
        '- `/design/projects/*.pen` from Subtask 1.3.3 — switcher visual grammar\n' +
        '- `/design/work-items/*.pen` from Subtask 1.4.1 — the surfaces this shell will host\n' +
        '- [PRODECT.md](../PRODECT.md) — brand-mark deferral principle, design-system tokens',
    },
    {
      id: '1.5.2',
      title: 'AppLayout + Sidebar primitives (responsive, keyboard-navigable, persistence-aware)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['1.0.5.2', '1.5.1'],
      descriptionMd:
        'Ship the canonical `AppLayout` + `Sidebar` primitives in `components/ui/`. ' +
        'Data-agnostic — accept children + slot props, no knowledge of workspaces / projects / ' +
        'routes. The wiring to the (authed) layout lands in 1.5.3.\n\n' +
        '**API:**\n\n' +
        '- `<AppLayout topNav={...} sidebar={...}>{children}</AppLayout>` — CSS-grid two-column ' +
        'layout (sidebar · main) at ≥md, single-column with the sidebar off-canvas at <md. ' +
        'Persists the collapsed state via the standard localStorage key ' +
        '(`prodect.shell.sidebar.collapsed` — mirrors the 1.0.5.2 theme key naming).\n' +
        '- `<Sidebar header={...} sections={[...]} footer={...} />` — each section is ' +
        '`{ id, label, items: [{ icon, label, href, kbd?, active? }] }`. Renders nav semantics ' +
        '(`<nav aria-label="Primary">`), uses Radix\'s `Collapsible` for any section the ' +
        'consumer marks `collapsible`. Active item gets `aria-current="page"`.\n' +
        '- `<SidebarToggle />` — the collapse / expand button that reads + writes the same ' +
        'localStorage key. Lives in the sidebar footer for desktop, in the top-nav as a hamburger ' +
        "for mobile (the prop `variant: 'footer' | 'hamburger'` picks the affordance).\n" +
        '- `<SidebarDrawer />` — the mobile off-canvas variant, a Radix `Dialog.Root` with a ' +
        'custom scrim + slide-in animation. Closes on route change (consume `usePathname`).\n\n' +
        '**Tokens:** introduce 4 new `--el-*` tokens in `app/globals.css` per the 1.0.5.2 growth ' +
        'principle (minimal tokens, add as needed): `--el-sidebar-bg`, `--el-sidebar-border`, ' +
        '`--el-sidebar-item-bg-hover`, `--el-sidebar-item-bg-active`. Reference them in the new ' +
        "primitive's classes; document each in `/docs/design-system.md`.\n\n" +
        '**`/tokens` specimen:** add an "App shell" section to `app/tokens/page.tsx` rendering ' +
        'the full variant matrix — sidebar expanded, sidebar collapsed (via a local `useState` ' +
        "control on the page), sample sections with active and hover states. Per Story 1.0.5's " +
        'convention every new primitive lands in `/tokens` with its variants.\n\n' +
        "**Keyboard:** `⌘\\` (Mac) / `Ctrl+\\` (Win/Linux) toggles the sidebar's collapsed " +
        'state. Use a single shared keyboard-shortcut hook (`lib/hooks/useShortcut.ts`) so 1.5.4 ' +
        'can register additional shortcuts consistently.\n\n' +
        '**No data wiring** in this Subtask — pure presentational primitives. The (authed) layout ' +
        'migration is 1.5.3.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `components/ui/AppLayout.tsx` + `components/ui/Sidebar.tsx` + ' +
        '`components/ui/SidebarDrawer.tsx` ship with the API above; all props strongly typed; ' +
        '`forwardRef` where the primitive wraps a focusable element.\n' +
        '- Sidebar persists its collapsed state via `localStorage` under ' +
        '`prodect.shell.sidebar.collapsed`; reads the saved value via `useSyncExternalStore` + ' +
        'lazy `useState` initializer (React 19 set-state-in-effect rule, established in 1.0.5.2).\n' +
        '- Below the `md` breakpoint the sidebar mounts as a `SidebarDrawer` (off-canvas Dialog); ' +
        'above `md` it mounts as a persistent column.\n' +
        '- Keyboard: `⌘\\` / `Ctrl+\\` toggles collapse; `esc` closes the mobile drawer; focus ' +
        'is trapped inside the drawer when open (Radix Dialog handles this); skip-link to `#main` ' +
        'rendered at the top of `AppLayout`.\n' +
        '- 4 new `--el-*` tokens added to `app/globals.css` under the existing tier-4 block; each ' +
        'documented in `/docs/design-system.md`.\n' +
        '- `app/tokens/page.tsx` grows an "App shell" section showing the primitive\'s variant ' +
        'matrix (expanded / collapsed / drawer).\n' +
        '- Vitest tests under `tests/components/app-layout.test.tsx` cover: collapse toggle ' +
        'persistence, drawer open/close on route change, keyboard shortcut firing, skip-link target.\n' +
        '- All quality gates green; existing tests + the existing `/tokens` route screenshot ' +
        'regression (if any) still pass.\n\n' +
        '## Context refs\n\n' +
        '- `prodect-core/CLAUDE.md` — 4-layer rule (auto-loaded)\n' +
        '- `/design/shell/*.pen` + PNG exports from 1.5.1 — the visual contract\n' +
        '- `components/ui/Dialog.tsx` + `Tooltip.tsx` + `Popover.tsx` — primitives to compose from\n' +
        '- `lib/theme/` — the existing `useSyncExternalStore` + localStorage pattern (mirror it)\n' +
        '- `app/tokens/page.tsx` — the living-spec route to extend\n' +
        '- `/docs/design-system.md` — token + primitive documentation',
    },
    {
      id: '1.5.3',
      title:
        'Migrate (authed) layout to AppLayout; move project switcher to sidebar; retire top-nav project switcher',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.5.2'],
      descriptionMd:
        'Wire the new `AppLayout` + `Sidebar` primitives into `app/(authed)/layout.tsx`. This is ' +
        'where the shell goes from "primitive that exists in /tokens" to "every signed-in surface ' +
        'renders inside it." Three concrete moves:\n\n' +
        "- **Compose AppLayout**: the (authed) layout's return becomes " +
        '`<AppLayout topNav={...} sidebar={...}>{children}</AppLayout>`. The data fetches already ' +
        'happening in the layout (`listUserWorkspaces`, `listProjects`, `getActiveProject`) stay ' +
        'where they are — just feed the results into the new slot props instead of the old TopNav ' +
        'props.\n' +
        '- **Move ProjectSwitcher into the sidebar header**: the ' +
        '`(authed)/_components/ProjectSwitcher.tsx` currently lives in TopNav. Inside this ' +
        'Subtask: pass it as the `header` prop of `<Sidebar />`. The visual treatment may need a ' +
        'width tweak (the sidebar header is narrower than the top-nav was); land it.\n' +
        '- **Retire the TopNav project switcher**: `TopNav.tsx` now renders only ' +
        '`WorkspaceSwitcher` + (theme toggle slot — empty, filled by 1.5.4) + (cmd-k trigger slot ' +
        '— empty, filled by 1.5.4) + `UserMenu`. The conditional that hides the project switcher ' +
        "when there's no active workspace is preserved (now a no-op because the switcher isn't in " +
        'TopNav anymore; document the empty-state path in the sidebar instead — when the workspace ' +
        'has zero projects, the sidebar header shows the existing `ProjectsEmptyState` CTA inline).\n\n' +
        '**Sidebar sections**: the layout passes the sidebar these sections:\n\n' +
        '- Project-scoped nav (rendered only when there\'s an active project): "Issues" (/issues ' +
        '— placeholder route), "Boards" (/boards — placeholder), "Reports" (/reports — ' +
        'placeholder). Each placeholder route is a stub page `<h1>Coming in Epic N</h1>` so the ' +
        'navigation is functional today and the Epic-2-6 work just replaces the stub bodies.\n' +
        '- Hairline divider\n' +
        '- "Settings" (deep-link to `/settings/project` if active project, else ' +
        '`/settings/workspace`), "Docs" (external link to ' +
        '`https://github.com/moooon-B-V/prodect-core` — placeholder until a real /docs route ships).\n\n' +
        'Active-item detection uses `usePathname()` via a thin client wrapper ' +
        '`(authed)/_components/SidebarNav.tsx` that takes the section list and renders it with ' +
        'the correct `active` flag per item.\n\n' +
        '**Placeholder routes:** add `app/(authed)/issues/page.tsx`, `boards/page.tsx`, ' +
        '`reports/page.tsx` — each ≤10 lines, just an `<h1>` + a "Coming in Epic 2" / Epic 3 / ' +
        'Epic 6 line. These exist so the sidebar links go somewhere real; Epic 2-6 replaces the bodies.\n\n' +
        '**Existing routes** (`/dashboard`, `/settings/workspace`, `/settings/project`, ' +
        '`/tokens`): unchanged code; they render inside the new shell as-is. Smoke test each ' +
        'renders correctly.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `app/(authed)/layout.tsx` renders `<AppLayout>` with the sidebar populated from the ' +
        'same workspace/project data the previous TopNav consumed.\n' +
        '- `TopNav.tsx` renders ONLY `WorkspaceSwitcher` + theme-toggle slot + cmd-k slot + ' +
        '`UserMenu`. The `ProjectSwitcher` import is removed from TopNav.\n' +
        "- The sidebar's header carries the `ProjectSwitcher`; when there's no active workspace, " +
        'the sidebar hides project nav entirely and shows nothing in the header.\n' +
        '- Three placeholder routes exist: `/issues`, `/boards`, `/reports`, each ≤10 lines with ' +
        'a stub `<h1>` + an "Epic N" placeholder line.\n' +
        '- Active-item detection works: navigating to `/issues` highlights the Issues sidebar item ' +
        'with `aria-current="page"`.\n' +
        '- Existing routes (`/dashboard`, `/settings/workspace`, `/settings/project`, `/tokens`) ' +
        'render correctly inside the new shell — the existing Playwright specs (auth-credentials, ' +
        'workspace-flows, projects-flow) stay green without modification.\n' +
        '- Empty-state path preserved: a member with no projects in the active workspace sees the ' +
        '`ProjectsEmptyState` inline in the sidebar header (NOT in the dashboard body — that path ' +
        'moved with the project switcher).\n' +
        '- All quality gates green; existing test suite stays green; existing E2E specs stay green.\n\n' +
        '## Context refs\n\n' +
        '- `components/ui/AppLayout.tsx` + `Sidebar.tsx` from 1.5.2\n' +
        '- `app/(authed)/layout.tsx` — the file being migrated\n' +
        '- `app/(authed)/_components/TopNav.tsx` + `ProjectSwitcher.tsx` + ' +
        '`WorkspaceSwitcher.tsx` + `UserMenu.tsx` + `ProjectsEmptyState.tsx`\n' +
        '- `app/(authed)/dashboard/page.tsx` — the smoke route to verify still renders\n' +
        '- The five 1.5.1 mockup PNGs — the visual contract',
    },
    {
      id: '1.5.4',
      title: 'Theme toggle (tri-state) + cmd-k command palette (navigation actions)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['1.5.3'],
      descriptionMd:
        'Land the two cross-cutting shell features the top-nav reserves slots for: the theme ' +
        'toggle and the cmd-k command palette. Both fill the empty slots 1.5.3 left in TopNav.\n\n' +
        '**Theme toggle** (`(authed)/_components/ThemeToggle.tsx`): tri-state (light → dark → ' +
        'system), reads + writes the existing 1.0.5 ThemeProvider via its `useTheme()` hook. The ' +
        'icon cycles sun ↔ moon ↔ monitor (lucide-react icons). A Tooltip shows the current ' +
        'resolved theme on hover. Placed in TopNav in the slot between the workspace switcher and ' +
        'the cmd-k trigger.\n\n' +
        '**Command palette:**\n\n' +
        '- `components/ui/CommandPalette.tsx` — generic primitive: a Radix `Dialog.Root` with an ' +
        'Input at top, a list of grouped actions below. Props: `open` / `onOpenChange` + ' +
        '`groups: [{ heading, actions: [{ id, label, kbd?, onSelect }] }]`. Keyboard: `↑↓` moves ' +
        'the highlighted row; `↵` invokes `onSelect`; `esc` closes. Filtering: simple substring ' +
        'match against `label` (no fuzz library — over-engineering for v1, document the deferral). ' +
        'Lives in `/tokens` with its variant matrix (empty query, filtered query, empty results).\n' +
        '- `(authed)/_components/AppCommandPalette.tsx` — the application composition: takes the ' +
        'same workspace/project list the layout already fetches, builds the action groups ' +
        '(Navigation: Go to Dashboard/Issues/Boards/Reports/Settings; Workspace: Switch to <name> ' +
        'for each workspace; Project: Switch to <name> for each project in active workspace; ' +
        "Account: Toggle theme, Sign out). Each action's `onSelect` dispatches the corresponding " +
        'router push or Server Action.\n' +
        '- `(authed)/_components/CommandPaletteProvider.tsx` — a tiny client provider that owns ' +
        'the `open` state and registers the global `⌘K` / `Ctrl+K` shortcut via the `useShortcut` ' +
        "hook from 1.5.2. Exposes a context method `openCommandPalette()` for the TopNav's " +
        '"Search" button trigger.\n' +
        '- TopNav\'s cmd-k slot renders a `Button` labeled "Search" with a trailing ' +
        '`<kbd>⌘K</kbd>` hint chip; clicking calls `openCommandPalette()`.\n' +
        '- **Shortcut cheatsheet**: bind `?` globally to open a `ShortcutsCheatsheet` Dialog that ' +
        'lists every shortcut the shell registers (⌘K, ⌘\\, ?, esc). One-column table with a ' +
        'kbd-chip on the left and the action label on the right. Source the list from a single ' +
        "shared module `lib/shortcuts.ts` so the cheatsheet and the actual handlers can't diverge.\n\n" +
        "**What's deliberately NOT in here:** fuzzy search across issues / projects / docs " +
        '(Epic 6\'s Search Story owns that — when search lands, the palette grows a "Search" ' +
        "group fed by the search service; the primitive doesn't change shape). AI / chat " +
        'affordances (Epic 7). Recent-items history (a finding to log: "palette has no ' +
        'recent-items list; add when usage data shows demand").\n\n' +
        '## Acceptance criteria\n\n' +
        '- `(authed)/_components/ThemeToggle.tsx` ships and renders in TopNav; cycles light → ' +
        'dark → system; reads/writes via the existing `useTheme()` hook; an accessible label / ' +
        'tooltip announces the current resolved theme.\n' +
        '- `components/ui/CommandPalette.tsx` ships as a generic primitive (lives in `/tokens` ' +
        'with its variant matrix); takes typed group/action props.\n' +
        '- `AppCommandPalette` assembles navigation + workspace-switch + project-switch + account ' +
        "groups from the layout's already-fetched data; opens via `⌘K` / `Ctrl+K` AND via the " +
        'TopNav "Search" button.\n' +
        '- Filtering: typing into the input narrows the action list by substring match against ' +
        '`label`; empty query shows all actions grouped by heading; no-match state shows "No ' +
        'actions match" hint.\n' +
        '- Keyboard: `↑↓` cycles the highlighted row; `↵` invokes `onSelect`; `esc` closes; ' +
        'focus returns to the trigger on close.\n' +
        '- `?` opens the `ShortcutsCheatsheet` Dialog enumerating every shell shortcut; the list ' +
        'is sourced from `lib/shortcuts.ts` (single source of truth shared with the actual handlers).\n' +
        '- Vitest tests under `tests/components/command-palette.test.tsx` cover: opens on ⌘K, ' +
        'filters on typed input, ↵ invokes the selected action, esc closes; ' +
        '`tests/components/theme-toggle.test.tsx` covers the tri-state cycle.\n' +
        '- All quality gates green; existing suite stays green; bundle-size impact under +10 KB ' +
        'gzipped (the palette is just a Radix Dialog + a controlled Input + a list — no heavy fuzz lib).\n\n' +
        '## Context refs\n\n' +
        '- `lib/theme/` — existing ThemeProvider + `useTheme()` hook\n' +
        '- `components/ui/Dialog.tsx` + `Button.tsx` + `Tooltip.tsx` — primitives to compose\n' +
        '- `app/(authed)/layout.tsx` + `TopNav.tsx` — the slots to fill (1.5.3 left them empty)\n' +
        '- `lib/hooks/useShortcut.ts` from 1.5.2 — the keyboard-shortcut registration hook\n' +
        '- `/design/shell/cmd-k.pen` + `shortcuts.pen` from 1.5.1 — the visual contract',
    },
    {
      id: '1.5.5',
      title: 'Accessibility audit + keyboard-navigation tests + axe-core CI integration',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['1.5.4'],
      descriptionMd:
        'Lock in the accessibility properties of the shell before any Epic-2-7 surfaces inherit ' +
        'them. Two layers of coverage:\n\n' +
        '- **Automated axe-core in Playwright**: install `@axe-core/playwright`; add a new spec ' +
        '`tests/e2e/shell-a11y.spec.ts` that visits each shell-bearing route (`/dashboard`, ' +
        '`/issues`, `/boards`, `/reports`, `/settings/workspace`, `/settings/project`, `/tokens`) ' +
        'and runs `axe.analyze()` with the default WCAG 2.1 AA ruleset. Zero violations expected. ' +
        'Any violation present is either fixed in this Subtask or marked as a finding with an ' +
        'explicit ignore.\n' +
        '- **Keyboard-only navigation spec**: `tests/e2e/shell-keyboard.spec.ts` drives the shell ' +
        'with keyboard only (no `page.click`). Sequence: load dashboard → tab through to skip-link ' +
        '→ activate skip-link → tab into main → press `⌘K` → palette opens → type "iss" → ↓ to ' +
        'first match → ↵ → URL is /issues → press `⌘\\` → sidebar collapses → press `?` → ' +
        'cheatsheet opens → `esc` closes. Every focusable interactive element must be reachable ' +
        'via tab; visible focus ring (the existing 1.0.5 `:focus-visible` ring) must paint on each.\n' +
        '- **aria assertions**: assert `aria-current="page"` on the active sidebar item; ' +
        '`aria-label` on the navigation regions (top-nav, sidebar); `aria-expanded` on the sidebar ' +
        'collapse toggle; `aria-modal="true"` on the cmd-k Dialog. Playwright\'s `role` + ' +
        '`aria-*` selectors are the right tool.\n' +
        '- **Manual-audit log**: produce a short `docs/a11y/shell-audit.md` documenting the manual ' +
        'checks performed (screen-reader smoke with VoiceOver / NVDA on the cheatsheet + palette; ' +
        'tested breakpoints; color contrast spot-checks via the design-system tokens). Future a11y ' +
        'Subtasks for Epic-2-7 surfaces extend this file.\n\n' +
        '**CI wiring:** the new specs run in the existing E2E job (`pnpm test:e2e` + the ' +
        'docker-compose Postgres). Axe results are attached to the Playwright HTML report; on ' +
        'failure, CI surfaces the rule + the element selector that violated it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `@axe-core/playwright` is a dev dependency.\n' +
        '- `tests/e2e/shell-a11y.spec.ts` visits ≥6 shell-bearing routes and asserts zero axe ' +
        'violations on each (WCAG 2.1 AA).\n' +
        '- `tests/e2e/shell-keyboard.spec.ts` drives the full keyboard-only sequence above with ' +
        'no `page.click` / `page.tap` calls.\n' +
        '- aria-assertions in both specs: `aria-current="page"` on active sidebar item; ' +
        '`aria-label`s on nav regions; `aria-expanded` on collapse toggle; `aria-modal="true"` ' +
        'on cmd-k Dialog.\n' +
        '- `docs/a11y/shell-audit.md` exists with a manual-audit log entry for 1.5.5.\n' +
        '- Both new specs run in CI (the existing E2E job picks them up via glob); on failure CI ' +
        'report surfaces violating rule + selector.\n' +
        '- All quality gates green; no regressions in the existing E2E suite.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/multi-tenant-isolation.spec.ts` + `tests/e2e/projects-flow.spec.ts` — ' +
        'existing Playwright patterns to mirror\n' +
        '- `tests/e2e/_helpers/db-reset.ts` — the reset helper\n' +
        '- `app/(authed)/layout.tsx` + `components/ui/AppLayout.tsx` + `Sidebar.tsx` + ' +
        '`CommandPalette.tsx` — the system under test\n' +
        '- [Playwright axe-core docs](https://playwright.dev/docs/accessibility-testing) — ' +
        'integration pattern',
    },
    {
      id: '1.5.6',
      title:
        'Story-level E2E: shell renders across breakpoints; nav + palette + theme + sign-out all flow (closes the Story)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 16,
      dependsOn: ['1.5.4', '1.5.5'],
      descriptionMd:
        'The Story-closing E2E proves the shell holds together end-to-end across realistic user ' +
        'journeys. Same shape as Story 1.2.7 / 1.3.6 / 1.4.8 — a Playwright spec that drives the ' +
        'browser through the full surface. Where 1.5.5 covered keyboard + accessibility in ' +
        'isolation, this spec exercises the chrome AS A USER WOULD use it, with mouse + keyboard ' +
        'interleaved.\n\n' +
        '**Spec at `tests/e2e/shell-flows.spec.ts`** covers:\n\n' +
        '- **Signed-in landing**: sign in (use the existing auth-credentials fixture user) → land ' +
        'on `/dashboard` → assert sidebar visible with project nav, top-nav visible with workspace ' +
        'switcher + theme toggle + "Search" button + user menu.\n' +
        '- **Sidebar navigation**: click "Issues" → URL changes to `/issues` → placeholder page ' +
        'renders → Issues item shows `aria-current="page"`. Repeat for Boards / Reports / Settings.\n' +
        '- **Collapse toggle**: click the sidebar collapse button → sidebar width shrinks; reload ' +
        'the page → sidebar stays collapsed (localStorage persistence). Click again → expands; ' +
        'reload → stays expanded.\n' +
        '- **Cmd-k palette → switch workspace**: press ⌘K → palette opens → type the alternate ' +
        "workspace's name → ↓ → ↵ → URL+cookie reflect the workspace switch → sidebar's project " +
        "switcher refreshes to show the new workspace's projects.\n" +
        '- **Cmd-k palette → toggle theme**: open palette → type "theme" → ↵ → DOM ' +
        '`html[data-theme]` attribute flips → reload → preserved.\n' +
        '- **Mobile drawer flow**: `page.setViewportSize({ width: 375, height: 812 })` → sidebar ' +
        'hides, hamburger appears → click hamburger → drawer slides in with scrim → navigate via ' +
        'drawer item → drawer auto-closes on route change (or click scrim → drawer closes).\n' +
        '- **Sign-out via palette**: open palette → "Sign out" → ↵ → redirected to `/sign-in` → ' +
        'cookie cleared.\n' +
        '- **Sign-out via user menu** (parity path): open user menu → "Sign out" → same outcome.\n' +
        '- **Empty-state path**: sign in as a user whose workspace has zero projects → sidebar ' +
        'header shows the `ProjectsEmptyState` CTA inline (NOT in the main panel); sidebar ' +
        'project-scoped nav is hidden.\n\n' +
        '**Story-level verification recipe** (manual, ≤10 minutes): pull main, ' +
        "`pnpm install && pnpm dev`, sign in, walk the spec's scenarios interactively. Spot-check " +
        "on a real iPad-sized viewport (the only test breakpoint below md the spec doesn't cover " +
        'automatically).\n\n' +
        "**If any scenario fails**: fix the bug in this Subtask if it's a shell-level regression; " +
        'log a finding if it points at a deeper service-layer issue (per mistake #27).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `tests/e2e/shell-flows.spec.ts` covers every bullet in the scenario list above; each ' +
        'scenario is its own `test()` block named for the journey it exercises.\n' +
        '- Mobile-drawer scenario uses `page.setViewportSize` to drop below `md` (768px) and ' +
        'asserts the drawer is the rendered variant.\n' +
        "- Workspace-switch via palette scenario asserts the cookie change AND the sidebar's " +
        'project list refresh.\n' +
        '- Theme-toggle scenario asserts the DOM attribute change AND localStorage persistence ' +
        'across reload.\n' +
        '- Sign-out scenarios cover BOTH the palette path and the user-menu path; both lead to ' +
        '`/sign-in`.\n' +
        '- Story-level verification recipe reproduces locally in <10 min.\n' +
        '- All quality gates green; CI green; existing E2E suite (auth + workspace-flows + ' +
        'projects-flow + work-items-isolation + shell-a11y + shell-keyboard) stays green.\n' +
        '- Any cross-Subtask issue surfaced during verification logged in ' +
        '[PRODECT_FINDINGS.md](PRODECT_FINDINGS.md).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/workspace-flows.spec.ts` + `projects-flow.spec.ts` — existing ' +
        'browser-driven E2E patterns to mirror\n' +
        '- `tests/e2e/_helpers/db-reset.ts` + `email-capture.ts` — the helpers\n' +
        '- The full shell stack (AppLayout / Sidebar / SidebarDrawer / TopNav / ThemeToggle / ' +
        'CommandPalette / AppCommandPalette / ShortcutsCheatsheet)\n' +
        '- The 1.5.5 a11y + keyboard specs — to NOT duplicate; this spec is journey-driven, not ' +
        'invariant-driven',
    },
  ],
};
