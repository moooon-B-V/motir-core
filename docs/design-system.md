# Prodect — Design System Reference

> The canonical "how to use the design system" doc. Tokens, primitives,
> patterns, voice & tone, and the don'ts. Every design-type Subtask prompt
> injects this file as context — its quality directly determines the visual
> consistency of every later UI.
>
> Companion to [`DESIGN.md`](./DESIGN.md) (the architectural spec —
> _what exists_) and [`/tokens`](../app/tokens/page.tsx) (the live spec —
> _how it looks_). DESIGN.md describes the system; this file teaches how
> to wield it.

## Table of contents

1. [Tokens](#tokens) — palette, type, spacing, radius, shadow
2. [Primitives](#primitives) — the components in `components/ui/` (incl. the App shell)
3. [Patterns](#patterns) — `EmptyState` and `ErrorState`
4. [Voice & tone](#voice--tone) — how Prodect's copy reads
5. [Don'ts](#donts) — the anti-patterns that break the system

---

## Tokens

All tokens live in [`app/globals.css`](../app/globals.css) under a 4-tier
architecture. Components reference semantic Tailwind utilities
(`bg-primary`, `text-foreground`, `rounded-card`) or CSS variables
(`--color-hairline`, `--spacing-md`) — never hardcoded hex or px.

### Color palette

| Token                      | Tailwind                    | When to use                                                                         |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `--color-primary`          | `bg-primary`                | The dominant CTA color (purple). **One per screen, max** — the brand action signal. |
| `--color-background`       | `bg-background`             | Page canvas.                                                                        |
| `--color-foreground`       | `text-foreground`           | Primary text.                                                                       |
| `--color-surface`          | `bg-surface`                | Subtle section backgrounds, tinted cards.                                           |
| `--color-muted-foreground` | `text-muted-foreground`     | Secondary text, placeholders, descriptions.                                         |
| `--color-hairline`         | `border-(--color-hairline)` | 1px card borders and dividers — the structural workhorse.                           |
| `--color-hairline-strong`  | —                           | Input borders, emphasis edges.                                                      |
| `--color-success`          | `bg-(--color-success)`      | Confirmations, "saved", positive outcomes.                                          |
| `--color-warning`          | `bg-(--color-warning)`      | Mid-priority alerts. **Orange, not yellow.**                                        |
| `--color-destructive`      | `bg-(--color-destructive)`  | Validation errors, destructive confirms.                                            |
| `--color-info`             | `bg-(--color-info)`         | Neutral informational.                                                              |
| `--color-link`             | `text-(--color-link)`       | Inline text links — blue. **Never use `--color-primary` purple for links.**         |

Hex values + full dark-mode pairings live in [`DESIGN.md` §2](./DESIGN.md#2-color-palette--roles).
Pastel feature tints (`--color-tint-peach | rose | mint | lavender | sky | yellow`)
are for tinted card variants only — never page-level surfaces. See
[`Card`](#card) for variants.

### Type scale

Three families, defined in [`app/layout.tsx`](../app/layout.tsx) via
`next/font/google` with `display: 'swap'`:

| Family       | Font           | Use                                                           |
| ------------ | -------------- | ------------------------------------------------------------- |
| `font-sans`  | Inter          | Body, UI controls, navigation. Default.                       |
| `font-serif` | Source Serif 4 | Headlines (`text-xl`+), the wordmark, editorial warmth.       |
| `font-mono`  | JetBrains Mono | Code, Subtask IDs, hex values, file paths, eyebrow microtype. |

| Class          | Size | Suggested family | When to use                          |
| -------------- | ---- | ---------------- | ------------------------------------ |
| `text-xs`      | 12px | mono             | Eyebrows, footnotes, mono labels.    |
| `text-sm`      | 14px | sans             | Small body, button labels, captions. |
| `text-base`    | 16px | sans             | Primary body.                        |
| `text-lg`      | 20px | sans/serif       | h4, lead paragraph.                  |
| `text-xl`      | 24px | serif            | h3, card titles.                     |
| `text-2xl`     | 32px | serif            | h2, section headlines.               |
| `text-3xl`     | 48px | serif            | h1, page titles.                     |
| `text-display` | 80px | serif            | Hero display only.                   |

### Spacing, radius, shadows

Eight spacing tokens (`--spacing-xxs`/4px through `--spacing-3xl`/40px, plus
`--spacing-section`/64px). Five semantic radius tokens
(`--radius-btn | input | card | modal | badge`) that flip with display style
— `default` is Notion-sober (8-12px), `soft` is Figma-pill (24-32px,
`--radius-btn` becomes a full pill). Five shadow tiers
(`--shadow-flat | subtle | card | elevated | modal`) that soften further in
`soft`. Full table in [`DESIGN.md` §5–6](./DESIGN.md#5-layout-principles).

**Rule**: components reference the semantic shape tokens, not the raw
`--radius-md` / `--shadow-card`. That's what lets display-style flips
cascade cleanly without component changes.

### App shell element tokens

The navigation rail owns four tier-3 `--el-*` element tokens (Subtask
1.5.2). The mockup paints the rail on `--color-surface` and the content area
on `--color-background`; the active row inverts that contrast so the current
page reads as inset into the canvas.

| Token                         | Resolves to                      | When to use                                                              |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `--el-sidebar-bg`             | `--color-surface`                | The rail background — distinct from the page canvas.                     |
| `--el-sidebar-border`         | `--color-hairline`               | The seam between rail and content; dividers and the active-row outline.  |
| `--el-sidebar-item-bg-hover`  | `#eeede9` light / `#222222` dark | Hover lift on a nav row (one shade off the surface; concrete hex).       |
| `--el-sidebar-item-bg-active` | `--color-background`             | The active row — canvas inset into the rail, paired with `aria-current`. |

Three of the four flow through `--color-*` vars that the dark block already
flips; only the hover shade is a concrete hex, so it carries its own
`[data-theme='dark']` value.

---

## Primitives

The primitives in [`components/ui/`](../components/ui/) each ship with `cva`
for variant management (where they vary), `cn()` (twMerge + clsx) for class
composition, and ref forwarding where they wrap a focusable element. See
[`/tokens`](../app/tokens/page.tsx) for the live variant matrix. Below: the
core controls, then [Popover](#popover), then the [App shell](#app-shell)
family (AppLayout / Sidebar / SidebarToggle / SidebarDrawer / SectionLabel).

### Button

```tsx
<Button variant="primary" size="md">Save</Button>
<Button variant="secondary" leftIcon={<Plus />}>New project</Button>
<Button variant="ghost" loading>Saving…</Button>
<Button variant="danger" onClick={confirmDelete}>Delete</Button>
```

`primary | secondary | ghost | danger` × `sm | md | lg`. `loading` swaps
the left icon for a `Spinner` and disables. `leftIcon` / `rightIcon` slots.

**When to use which variant**: `primary` for the one dominant CTA on a view
(reserve purple — multiple primaries dilute the signal). `secondary` for
peer actions ("Cancel"). `ghost` for tertiary/repeated (toolbar buttons,
"Add another"). `danger` for destructive confirms only ("Delete") — not as
a generic "warning" (that's `Pill severity="warning"`).

### Input

```tsx
<Input label="Email" type="email" helperText="We'll never share it." />
<Input label="Workspace URL" addonStart={<Globe />} addonEnd=".prodect.dev" />
<Input label="Name" error="Required." />
```

`label`, `helperText`, `error`, `addonStart`, `addonEnd`. `error` sets
`aria-invalid` and flips the border. Use `addonStart`/`addonEnd` for inline
icons or fixed labels — not `prefix`/`suffix` (those collide with native
HTML attrs). **When to use**: single-line text. For multi-line, `Textarea`.

### Textarea

```tsx
<Textarea label="Description" rows={4} helperText="Max 500 characters." />
```

Multi-line variant of `Input`, same `label`/`helperText`/`error` props, no
addon slots. Pass `rows` to size; no auto-resize in v1. **When to use**:
free-form text the user might write more than one line of.

### Card

```tsx
<Card header={<h3 className="font-serif text-lg">Title</h3>}>Body</Card>
<Card tint="lavender" clickable onClick={open}>Pastel feature card</Card>
<Card footer={<p className="text-sm text-muted-foreground">2m ago</p>}>Body</Card>
```

`tint: none | peach | rose | mint | lavender | sky | yellow` (use sparingly
— never on page surfaces). `clickable` adds focus/hover/`role="button"`;
wire `onClick`. `header` / `footer` slots have built-in spacing.
**When to use**: any rectangular content container — form sections, list
items, feature tiles, settings rows.

### Modal

```tsx
<Modal open={open} onOpenChange={setOpen} title="Confirm" size="md">
  <p>This action can't be undone.</p>
  <Modal.Footer>
    <Button variant="ghost" onClick={() => setOpen(false)}>
      Cancel
    </Button>
    <Button variant="danger" onClick={confirm}>
      Delete
    </Button>
  </Modal.Footer>
</Modal>
```

`size: sm | md | lg`. Wraps `@radix-ui/react-dialog` — focus trap, ESC,
click-outside, focus-return all handled. Controlled via `open` +
`onOpenChange`. Sub-components: `Modal.Footer`, `Modal.Trigger`.
**When to use**: confirmations, single-purpose forms, full-context dialogs.
Not for transient notifications (`Toast`) or inline editing (popover).

**a11y contract (`title` / `description`).** Radix associates a dialog with
a _labelling_ element (`Dialog.Title`) and a _describing_ element
(`Dialog.Description`) and warns in dev if either is absent without an
explicit opt-out. The `Modal` primitive handles both for you:

- `title` omitted → a visually-hidden `Dialog.Title` is rendered so the
  dialog is still labelled. Prefer passing a real `title`; omit it only when
  you render your own heading row inside the body (e.g. an icon + custom
  text), and rely on the sr-only fallback for the accessible name.
- `description` omitted → the primitive sets `aria-describedby={undefined}`
  on the content to declare "no description" (the explicit opt-out), so no
  warning fires. When you do pass `description`, Radix auto-wires
  `aria-describedby` to it. Pass a `description` whenever the dialog's
  purpose isn't obvious from its title + first line of body.

### Popover

```tsx
<Popover open={open} onOpenChange={setOpen}>
  <Popover.Trigger asChild>
    <Button variant="ghost" rightIcon={<ChevronDown />}>
      Menu
    </Button>
  </Popover.Trigger>
  <Popover.Content align="start" width={320}>
    {items}
  </Popover.Content>
</Popover>
```

Anchored, click-outside-dismissable, focus-managed floating panel wrapping
`@radix-ui/react-popover` (shipped 1.2.6). Same controlled-`open` shape as
`Modal`, but anchored to a trigger with no overlay. Sub-components:
`Popover.Trigger`, `Popover.Content` (`align`, `sideOffset`, `width` —
default 320px), `Popover.Close`, `Popover.Anchor`. Reuses
`--radius-card` / `--shadow-elevated` / `--color-hairline` — no new tokens.
**When to use**: menus and dropdowns whose panel holds free-form content —
the workspace switcher's membership rows, the user menu. For centered,
overlay-backed dialogs use `Modal`; for hover hints use `Tooltip`.

### Pill

```tsx
<Pill status="in-progress">In progress</Pill>
<Pill severity="danger">Validation failed</Pill>
```

Two variant axes (one or the other, never both):

- `status: planned | in-progress | done` — Prodect's Subtask lifecycle.
- `severity: info | success | warning | danger` — generic UI states.

Always full-pill regardless of display style. **When to use**: short status
or severity labels. Not for navigation (use ghost `Button`) or free-form
tags.

### Tooltip

```tsx
<Tooltip content="Send message">
  <Button variant="ghost">
    <Send />
  </Button>
</Tooltip>
```

`content`, `side: top | right | bottom | left`, `delayMs` (700 default).
Self-contained — own `TooltipProvider`, safe anywhere.
**When to use**: explain icon-only buttons, surface meta on a status dot,
clarify a truncated label. Not for content needed on first contact.

### Toast

```tsx
const { toast } = useToast();
toast({ variant: 'success', title: 'Saved', description: 'Changes synced.' });
```

`info | success | warning | error`. Wrap the app in `<ToastProvider>` once
(already wired in [`app/layout.tsx`](../app/layout.tsx)). Stacks,
auto-dismisses after 5s, pauses on hover, dismisses on swipe.
**When to use**: transient feedback the user can ignore. Not for blocking
failures (`ErrorState`) or required confirmations (`Modal`).

### Spinner

```tsx
<Spinner size="md" aria-label="Loading workspace" />
```

`size: sm | md | lg`. Inherits color from parent via `border-current` —
useful inside colored `Button` variants. **When to use**: indeterminate
loading inside a contained surface. For full-page loading, prefer a
skeleton or `EmptyState`.

_`FormField` is an internal helper used by Input and Textarea — not part
of the public surface._

### App shell

The frame every signed-in surface renders inside (Subtask 1.5.2). Five
primitives compose to the `design/shell/` contract; 1.5.3 wires them into
`app/(authed)/layout.tsx`. All are **data-agnostic** — they render the
header/footer/section JSX you hand them and know nothing about projects,
workspaces, or routes (per PRODECT_FINDINGS #29 those states are the
consumer's job).

```tsx
<AppLayout
  topNav={<TopNav />} // contains <SidebarToggle variant="hamburger" /> + <SidebarDrawer> for <md
  sidebar={
    <Sidebar
      header={<ProjectSwitcher />}
      sections={[
        { id: 'primary', items: [{ icon: <LayoutDashboard />, label: 'Dashboard', href: '/' }] },
        { id: 'meta', items: [{ icon: <Settings />, label: 'Settings', href: '/settings' }] },
      ]}
      footer={<SidebarToggle variant="footer" />}
    />
  }
>
  <DashboardPage />
</AppLayout>
```

**`AppLayout`** — `topNav`, `sidebar`, `children`. Two-row shell: full-width
top nav, then a content region that is a two-column CSS grid `≥md`
(persistent rail · main) and a single column below `md` (the rail goes
off-canvas — surface it via the hamburger + drawer in `topNav`). The rail
column tracks `useSidebarCollapsed` (`240px` ↔ `56px`). Renders a skip-link
to `#main` as the first focusable element; `<main id="main" tabIndex={-1}>`.
Registers the only global shortcut this story ships: **`Mod+\`** (⌘\ / Ctrl+\)
toggles the rail.

**`Sidebar`** — `header?`, `sections`, `footer?`, `collapsed?`, `aria-label?`
(default `"Primary"`). Renders `<nav>`. `SidebarSection` is
`{ id, label?, items, collapsible?, defaultOpen? }`; `SidebarItem` is
`{ icon, label, href, kbd?, active? }`. The active item gets
`aria-current="page"` + the inset active treatment. Reads the shared
`useSidebarCollapsed` store unless the `collapsed` prop overrides it (the
drawer passes `collapsed={false}` to always render expanded). In collapsed
mode rows are icon-only, each wrapped in a `Tooltip` (`side="right"`) so the
label surfaces on hover/focus. A section with `collapsible: true` (expanded
mode, with a `label`) becomes a Radix Collapsible disclosure. Sections are
separated by a hairline `<hr>`.

**`SidebarToggle`** — `variant: 'footer' | 'hamburger'`. Both are a
`<Button variant="ghost">` (not a new shape). `footer` is the desktop
collapse control — a `Tooltip`-wrapped button with `ChevronsLeft` (expanded)
/ `ChevronsRight` (collapsed) that toggles `useSidebarCollapsed`; pass it as
the `Sidebar` `footer`. `hamburger` is the mobile trigger — a `Menu` button
that opens the drawer via `useSidebarDrawer`; wrap it in `md:hidden` at the
call site.

**`SidebarDrawer`** — `header?`, `children`, `width?` (default 300px). The
`<md` off-canvas drawer: a left-anchored `@radix-ui/react-dialog` that slides
in (`translate-x-[-100%]` → `translate-x-0`, driven by Radix `data-state`)
over a ~70%-opacity scrim. It reuses Radix Dialog directly rather than
`Modal` because `Modal`'s centered geometry can't express the left slide.
Open state lives in the shared `useSidebarDrawer` store; it **auto-closes on
route change** (`usePathname`) and on ESC (Radix + the shared `useShortcut`
registry). Pass a `<Sidebar collapsed={false} … />` as `children`.

**`SectionLabel`** — `label?` / `children`. The small uppercase-mono caption
(mono · 11px · semibold · 0.06em tracking · muted-foreground), lifted to one
primitive (PRODECT_FINDINGS #28) so the sidebar's section labels and 1.5.4's
cmd-K `CommandGroupHeader` share one source of truth.

**Supporting hooks** (`lib/hooks/`): `useSidebarCollapsed()` →
`[collapsed, setCollapsed, toggleCollapsed]`, a persisted
(`prodect.shell.sidebar.collapsed`) external store mirroring `lib/theme/`'s
lazy-read + `useSyncExternalStore` recipe; `useSidebarDrawer()` →
`[open, setOpen]`, an ephemeral (not persisted) shared store;
`useShortcut(combo, handler, opts?)`, the one shared keyboard-shortcut
primitive (`Mod` resolves to ⌘/Ctrl at bind time; `whenInputFocused` guards
typing). 1.5.4 registers `Mod+K` / `?` against the same hook.

---

## Patterns

Patterns are composed components that stack primitives in a fixed
arrangement to handle a recurring UX situation. Two patterns ship today:
`EmptyState` and `ErrorState`. Both compose `Card` + a `lucide-react` icon +
optional action — they reuse primitives, never reinvent atoms. See
[`/tokens`](../app/tokens/page.tsx) for the live samples — the canonical
preview is the specimen route, not embedded screenshots.

### EmptyState

```tsx
<EmptyState
  title="No projects yet"
  description="Create your first project to get started."
  action={<Button leftIcon={<Plus />}>New project</Button>}
/>
```

`title` (required), `description`, `icon`, `action`. Default icon is
`<Inbox />`; override with situation-fitting alternatives (`<FolderOpen />`,
`<MessageSquareOff />`, `<Users />`).

**Use whenever a list, table, board, or panel has no data.** Blank screens
read as broken. `EmptyState` says "this is correct, here's why, here's
what to do."

### ErrorState

```tsx
<ErrorState
  title="Couldn't load workspace"
  description="We couldn't reach the server. Check your connection and try again."
  error={err}
  retry={() => refetch()}
/>
```

`title` (required), `description`, `error` (real `Error` object), `retry`
(callback — when set, renders a "Try again" Button).

**Use whenever a failure blocks the user from progressing.** Prefer
`ErrorState` over `Toast` when the failure blocks the workflow — toasts are
for acknowledge-and-move-on conditions.

Root has `role="alert"` so screen readers announce assertively on mount.
When `error` is set, `error.message` renders in a mono code block — but
only in non-production builds (Next.js dead-code-eliminates the branch via
the static `process.env.NODE_ENV` replacement, so real error details never
leak to end users).

### Rule for future patterns

**Compose primitives. Never reinvent atoms.** If a pattern needs a shape
that doesn't exist as a primitive, extend the primitive — don't bake the
new atom into the pattern.

---

## Voice & tone

The visual system is half the design. The other half is how copy reads.
Six principles for every string the user sees — error messages, button
labels, empty-state copy, confirmations, headlines.

### 1. Confident, not corporate

State what is, then what to do. No hedging ("might", "please consider"),
no passive ("an error has occurred"), no unsolicited disclaimers.

- ✅ "We couldn't reach the server. Check your connection and try again."
- ❌ "An error may have occurred while attempting to communicate with our servers."

### 2. Warm, not cute

Editorial-warm, like a thoughtful colleague's PR comment. No exclamation
spam, no emoji, no "Whoops!".

- ✅ "No projects yet. Create your first to get started."
- ❌ "No projects yet! 🎉 Time to create one — woohoo!"

### 3. Specific, not vague

Name the thing that happened, name the next step. Polite-but-generic is
still unhelpful.

- ✅ "Couldn't save: workspace name is already taken."
- ❌ "Something went wrong. Please try again later."

### 4. Honest about AI

Prodect ships an AI planner. When it guessed or doesn't know, say so —
don't pretend agents are oracles.

- ✅ "Prodect picked Next.js based on 'React + Postgres' in your description.
  Wrong stack? Edit the discovery doc."
- ❌ "Based on our advanced AI analysis, we determined Next.js is optimal."

### 5. Plain language, not jargon

Names users already know. It's "delete", not "decommission"; "save", not
"persist". Reserve domain words (Epic, Story, Subtask) for the actual
Prodect data model.

- ✅ "Delete project — this can't be undone."
- ❌ "Decommission project — initiate irreversible removal flow."

### 6. Errors and empty states offer a path forward

Every error includes (a) what failed and (b) what to do. Every empty state
includes (a) what would appear and (b) how to fill it. Never leave the
user reading bad news with no exit.

- ✅ Empty: "No comments. Be the first to comment." + "Add comment" button.
- ✅ Error: "Webhook failed to deliver." + "Try again" button.
- ❌ A centered "🤷" emoji and nothing else.
- ❌ "Error 500" with a stack trace screenshot.

---

## Don'ts

Anti-patterns that quietly break the system. Each looks reasonable in
isolation; each propagates drift.

1. **Don't introduce new colors outside the palette.** Every color resolves
   through a token in [`app/globals.css`](../app/globals.css). Hex in
   `/app` or `/components` is a token gap — fix by adding a token, not by
   pasting a hex.

2. **Don't use `--color-primary` for body text or large backgrounds.**
   Purple is the CTA action color. It belongs on the one primary button
   per screen. Purple body / backgrounds / dividers dilute the signal.

3. **Don't conflate `--color-link` and `--color-primary`.** Link blue is
   for inline text links (informational). Primary purple is for action
   buttons. Different intents, different colors.

4. **Don't put primary buttons in destructive places.** "Delete account"
   is `variant="danger"`, not `variant="primary"`. Primary purple signals
   "we recommend this action"; destructive actions are the opposite.

5. **Don't add new font families.** Inter / Source Serif 4 / JetBrains Mono
   is the intentional cap. Wanting a fourth usually means you want a
   different weight or style of one of the three.

6. **Don't apply heavy shadows on documentation cards.** Hairline border +
   zero shadow for content surfaces (Notion pattern). Reserve `--shadow-*`
   tiers for surfaces that are physically raised (popovers, toasts, modals).

7. **Don't pill-shape buttons in the default display style.** Default is
   8px rectangles; pills are `soft`. Hardcoding `rounded-full` on Button
   bypasses the shape system and breaks display-style switching.

8. **Don't reinvent atoms inside patterns.** If a pattern needs a special
   card or button shape, that's a primitives gap — extend the primitive,
   don't bake the new atom into the pattern.

---

_Companion to [`DESIGN.md`](./DESIGN.md) (the architectural spec) and
[`/tokens`](../app/tokens/page.tsx) (the live spec). When a string in this
doc disagrees with the code, the code wins — file a fix._
