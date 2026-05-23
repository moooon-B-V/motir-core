# Prodect — DESIGN.md

> Inspired by Notion's color & spacing and Figma's shape language. The
> source DESIGN.md files (fetched via `npx getdesign@latest add notion` /
> `add figma`) live in [`./inspiration/`](./inspiration/). This file
> documents Prodect's own choices — what we actually built, not what we
> took inspiration from verbatim.

## 1. Visual Theme & Atmosphere

Warm minimalism with playful shape energy. Type is editorial — Source Serif 4
serif headlines paired with Inter sans body, plus JetBrains Mono for code,
IDs, and meta labels. The palette is Notion-warm (cream surfaces, charcoal
ink, purple primary, pastel feature tints), avoiding the cold-terminal
aesthetic common to AI tools. The default display style is Notion-sober
(8px button rectangles, modest shadows); an alternate `soft` display style
adopts Figma's pill-shape personality (50px pill buttons, more diffused
shadows, roomier spacing) for projects that want more energy.

**Mood**: thoughtful, warm, technical-but-not-cold, slightly editorial.
**Wrong moods**: terminal, dashboard, cyber.

## 2. Color Palette & Roles

All colors are defined as CSS variables in [`app/globals.css`](../app/globals.css)
under `@theme`. Tailwind v4 exposes them as utility classes automatically
(e.g., `--color-primary` → `bg-primary`, `text-primary`, `border-primary`).

### Brand & primary

| Token                        | Light     | Dark      | Role                                                                                 |
| ---------------------------- | --------- | --------- | ------------------------------------------------------------------------------------ |
| `--color-primary`            | `#5645d4` | `#7b6ce5` | The dominant CTA color. Reserved for the _single_ most important action on any view. |
| `--color-primary-foreground` | `#ffffff` | `#ffffff` | Text/icons on primary surfaces.                                                      |
| `--color-primary-pressed`    | `#4534b3` | `#5645d4` | Active/pressed state of primary buttons.                                             |

### Surfaces

| Token                  | Light     | Dark      | Role                                      |
| ---------------------- | --------- | --------- | ----------------------------------------- |
| `--color-background`   | `#ffffff` | `#0f0f0f` | Page canvas.                              |
| `--color-foreground`   | `#1a1a1a` | `#f3f4f6` | Primary text on the page.                 |
| `--color-surface`      | `#f6f5f4` | `#1a1a1a` | Subtle section backgrounds, tinted cards. |
| `--color-surface-soft` | `#fafaf9` | `#161616` | Quieter section dividers.                 |

### Text scale (the warm-charcoal hierarchy)

Notion's signature: not pure black on white. A graded series of warm grays
that read as editorial-warm rather than tech-cold.

| Token                      | Light     | Dark      | Use                       |
| -------------------------- | --------- | --------- | ------------------------- |
| `--color-ink`              | `#1a1a1a` | `#f3f4f6` | Primary headlines + body. |
| `--color-charcoal`         | `#37352f` | `#e5e5e5` | Body emphasis.            |
| `--color-slate`            | `#5d5b54` | `#a4a097` | Secondary text.           |
| `--color-steel`            | `#787671` | `#787671` | Tertiary / footer links.  |
| `--color-stone`            | `#a4a097` | `#5d5b54` | Muted labels.             |
| `--color-muted-foreground` | `#787671` | `#a4a097` | Disabled / placeholder.   |

### Hairlines (borders)

| Token                     | Light     | Dark      | Use                                     |
| ------------------------- | --------- | --------- | --------------------------------------- |
| `--color-hairline`        | `#e5e3df` | `#2a2a2a` | 1px dividers, card borders.             |
| `--color-hairline-soft`   | `#ede9e4` | `#1f1f1f` | Quieter dividers.                       |
| `--color-hairline-strong` | `#c8c4be` | `#3a3a3a` | Input borders, emphasis edges.          |
| `--color-border`          | `#e5e3df` | `#2a2a2a` | Default `border-border` Tailwind class. |

### Pastel feature tints

For card variants and feature highlights — never for page-level surfaces.

`--color-tint-peach`, `--color-tint-rose`, `--color-tint-mint`,
`--color-tint-lavender`, `--color-tint-sky`, `--color-tint-yellow`.

### Semantic

| Token                             | Use                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--color-success` (`#1aae39`)     | Confirmation, "saved", positive outcomes.                                                           |
| `--color-warning` (`#dd5b00`)     | Mid-priority alerts. Not yellow — orange.                                                           |
| `--color-destructive` (`#e03131`) | Validation errors, destructive confirms.                                                            |
| `--color-info` (`#0075de`)        | Neutral informational.                                                                              |
| `--color-link` (`#0075de`)        | Inline text links. **Distinct from `--color-primary`** — never use primary purple for inline links. |

## 3. Typography Rules

Three fonts, all variable, all loaded via `next/font/google` in
[`app/layout.tsx`](../app/layout.tsx) with `display: 'swap'` (page shows
fallback fonts immediately, swaps to real fonts on load — minimal CLS
because next/font generates metric-matched fallbacks).

### Families

| Family       | Font           | Use                                                                                            |
| ------------ | -------------- | ---------------------------------------------------------------------------------------------- |
| `font-sans`  | Inter          | Body text, UI controls, navigation, captions. Default.                                         |
| `font-serif` | Source Serif 4 | Headlines, the wordmark, anywhere we want editorial warmth.                                    |
| `font-mono`  | JetBrains Mono | Code blocks, Subtask IDs (e.g., `1.0.5.1`), hex values, file paths, eyebrow/caption microtype. |

### Scale

All scale tokens are defined under `@theme` in `globals.css` as
`--font-size-*`. Tailwind exposes them as `text-*` utilities.

| Class          | Size | Suggested family | Use                                |
| -------------- | ---- | ---------------- | ---------------------------------- |
| `text-xs`      | 12px | mono             | Micro labels, eyebrows, footnotes. |
| `text-sm`      | 14px | sans             | Small body, button labels.         |
| `text-base`    | 16px | sans             | Primary body.                      |
| `text-lg`      | 20px | sans/serif       | h4 / lead paragraph.               |
| `text-xl`      | 24px | serif            | h3 / card titles.                  |
| `text-2xl`     | 32px | serif            | h2 / section headlines.            |
| `text-3xl`     | 48px | serif            | h1 / page titles.                  |
| `text-display` | 80px | serif            | Hero display only.                 |

### Rules

- **Headlines default to `font-serif`** (Source Serif 4) — this is the
  Prodect choice that distinguishes us from Notion's all-sans approach.
- **Body defaults to `font-sans`** (Inter). Don't use serif for body —
  Source Serif 4 isn't optimized for long reading at small sizes.
- **Mono is for character-by-character meaning**: code, IDs, file paths,
  eyebrow microtype. Don't use mono as a decorative choice.
- **No additional fonts**. The three-family system is intentional. More
  fonts dilute identity and bloat page weight.

## 4. Component Stylings

Nine primitives ship in [`components/ui/`](../components/ui/) — each
file is a single primitive with a typed Props interface, `cva` for
variant management, `cn()` (twMerge + clsx) for class composition, and
ref forwarding. All primitives consume the design tokens from §2/§5/§6
exclusively — no hardcoded hex or px values. Live demos render at
[`/tokens`](../app/tokens/page.tsx).

### Button — [`components/ui/Button.tsx`](../components/ui/Button.tsx)

Primary interactive primitive. Variants `primary | secondary | ghost | danger`
× sizes `sm | md | lg`. `loading` prop shows inline `Spinner` and disables
interaction; `leftIcon` / `rightIcon` slots accept ReactNode. Shape responds
to `data-display-style` via `--radius-btn` — Notion-sober rectangles in
`default`, Figma-pill in `soft`. Use `primary` only for the single dominant
CTA per view.

### Input — [`components/ui/Input.tsx`](../components/ui/Input.tsx)

Single-line text field with `label`, `helperText`, `error`, and
`addonStart` / `addonEnd` slots for inline icons or labels (note: not
`prefix`/`suffix` — those names collide with native HTML attrs). Error
state flips border color to `--color-destructive` and sets `aria-invalid`.

### Textarea — [`components/ui/Textarea.tsx`](../components/ui/Textarea.tsx)

Multi-line variant of Input. Same `label` / `helperText` / `error` props.
No prefix/suffix slots (uncommon for textareas). Pass `rows` to size; no
auto-resize in v1.

### Card — [`components/ui/Card.tsx`](../components/ui/Card.tsx)

Content container with optional `header` and `footer` slots. `tint` prop
applies one of six pastel feature tints (`peach | rose | mint | lavender |
sky | yellow`) for tinted card variants — these match Notion's marketing
feature tiles. `clickable` adds keyboard + hover + focus-ring affordances;
wrap children in `<a>` or `<button>` semantically when interactive.

### Modal — [`components/ui/Modal.tsx`](../components/ui/Modal.tsx)

Wraps [`@radix-ui/react-dialog`](https://www.radix-ui.com/docs/primitives/components/dialog).
Sizes `sm | md | lg`. Radix handles focus trap, ESC-to-close,
click-outside-to-close, and focus-return-on-close automatically. Controlled
via `open` + `onOpenChange`. Compose `Modal.Footer` for action buttons;
`Modal.Trigger` is re-exported for declarative open patterns.

### Pill — [`components/ui/Pill.tsx`](../components/ui/Pill.tsx)

Compact status or severity label. Two variant axes (use one or the other):

- `status`: `planned | in-progress | done` — Prodect's Subtask lifecycle.
- `severity`: `info | success | warning | danger` — generic UI states.

Always renders with `--radius-badge` (full pill) regardless of display style
— badges look uniform across the system on purpose.

### Tooltip — [`components/ui/Tooltip.tsx`](../components/ui/Tooltip.tsx)

Wraps [`@radix-ui/react-tooltip`](https://www.radix-ui.com/docs/primitives/components/tooltip).
Appears on hover + keyboard focus. `side` prop picks position
(`top | right | bottom | left`). Self-contained — provides its own
TooltipProvider; safe to use anywhere.

### Toast — [`components/ui/Toast.tsx`](../components/ui/Toast.tsx)

Wraps [`@radix-ui/react-toast`](https://www.radix-ui.com/docs/primitives/components/toast).
Requires `<ToastProvider>` near the app root (already wired in
[`app/layout.tsx`](../app/layout.tsx)). Dispatch imperatively via
`useToast()`:

```tsx
const { toast } = useToast();
toast({ variant: 'success', title: 'Saved', description: 'Changes synced.' });
```

Four variants (`info | success | warning | error`). Stacks, auto-dismisses
after 5s, pauses on hover, dismisses on swipe.

### Spinner — [`components/ui/Spinner.tsx`](../components/ui/Spinner.tsx)

Pure CSS rotation indicator, three sizes (`sm | md | lg`). Inherits color
from parent via `border-current` — useful inside colored Button variants.
Used internally by Button's loading state.

### Patterns

Patterns are composed components — they stack primitives in a fixed
arrangement that encodes how we handle a recurring UX situation. They
exist to prevent two failure modes: (a) every engineer hand-rolling the
same arrangement slightly differently, and (b) someone reinventing an
atom (e.g. a custom card-with-border) instead of reusing the primitive.

**Rule for future patterns**: compose primitives, never reinvent atoms.
If a pattern needs a shape that doesn't exist as a primitive, extend the
primitive (or add a new one), don't bake the new atom into the pattern.

#### EmptyState — [`components/ui/EmptyState.tsx`](../components/ui/EmptyState.tsx)

Use whenever a list, table, board, or detail panel has no data to show.
The common mistake is leaving the screen blank — to a user, blank reads
as broken or still-loading. EmptyState communicates "this is correct,
here's why it's empty, and here's what to do next." Composes
[`Card`](../components/ui/Card.tsx) + a `lucide-react` icon + a
`title`/`description`/`action` stack. Default icon is `<Inbox />`;
override with situation-appropriate alternatives (FolderOpen,
MessageSquareOff, Users, etc.).

#### ErrorState — [`components/ui/ErrorState.tsx`](../components/ui/ErrorState.tsx)

Use whenever a request, mutation, or background job has failed in a way
that prevents the user from progressing. Prefer ErrorState over a silent
toast when the failure blocks the workflow — toasts are for transient,
acknowledge-and-move-on conditions. Composes [`Card`](../components/ui/Card.tsx)

- `<AlertTriangle />` in `--color-destructive` + a "Try again" Button.
  Has `role="alert"` so screen readers announce on mount, and renders
  `error.message` in a mono code block in non-production builds only
  (Next.js dead-code-eliminates the branch from production bundles via
  the static `process.env.NODE_ENV` replacement).

### Architecture notes

- **`--el-*` token layer didn't need to grow** for these 9 primitives. Each
  primitive consumed `--color-*` tokens directly or via Tailwind utility
  classes (`bg-primary`, `text-foreground`). The Tier 3 `--el-*` layer
  remains minimal — to be expanded when a future component needs distinct
  semantics that can't be expressed through the base color tokens.
- **`prefix` reserved-word lesson**: Native HTML `<input>` has a `prefix`
  attribute (string). When we shadowed it with a ReactNode prop, TS errored.
  Renamed to `addonStart` / `addonEnd`. If future primitives wrap native
  elements, check for attribute name collisions early.

## 5. Layout Principles

### Spacing scale

| Token                  | Size  | Suggested use                   |
| ---------------------- | ----- | ------------------------------- |
| `--spacing-xxs`        | 4px   | Tightest gaps; icon-text pairs. |
| `--spacing-xs`         | 8px   | Inside compact components.      |
| `--spacing-sm`         | 12px  | Default content spacing.        |
| `--spacing-md`         | 16px  | Between related elements.       |
| `--spacing-lg`         | 20px  | Between sections of a card.     |
| `--spacing-xl`         | 24px  | Card padding, group gaps.       |
| `--spacing-2xl`        | 32px  | Between unrelated elements.     |
| `--spacing-3xl`        | 40px  | Major content blocks.           |
| `--spacing-section`    | 64px  | Between page sections.          |
| `--spacing-section-lg` | 96px  | Marketing-page section gaps.    |
| `--spacing-hero`       | 120px | Hero band padding.              |

### Grid & whitespace

- **Default max-width**: 1100px for content pages, 1280px for marketing/app.
- **Whitespace philosophy**: generous between feature bands; dense within
  data tables and forms. Apply Notion's "breathing room" to marketing
  surfaces and Figma's tight grid to product/data surfaces.

## 6. Depth & Elevation

| Token                  | Use                                                                           |
| ---------------------- | ----------------------------------------------------------------------------- |
| `--shadow-flat` (none) | Default cards with a hairline border.                                         |
| `--shadow-subtle`      | Hover-elevated tiles, dropdown menus.                                         |
| `--shadow-card`        | Feature cards, raised surfaces.                                               |
| `--shadow-elevated`    | Popovers, important callouts.                                                 |
| `--shadow-modal`       | Modals, dialogs.                                                              |
| `--shadow-hero-mockup` | Deep diffuse shadow for hero-mockup imagery (per Notion's marketing pattern). |

Dark mode keeps shadows but reduces opacity — the contrast in dark mode
comes more from `--color-surface` vs `--color-background` than from
shadow depth.

## 7. Do's and Don'ts

### Do

- Use semantic Tailwind classes (`bg-background`, `text-foreground`,
  `bg-primary`, `text-muted-foreground`, `rounded-card`, `shadow-card`)
  — these resolve to the right CSS variable across themes and display
  styles automatically.
- Reference `--el-*` tokens in components rather than `--color-*`
  directly. The `--el-*` layer is the abstraction that future palettes
  override.
- Use `font-serif` for headlines (h1, h2, h3 above 24px). Use
  `font-sans` for body. Use `font-mono` only for code, IDs, and
  intentional microtype.
- Use `--color-primary` (purple) as the dominant CTA on each view.
  Maximum one per screen — purple is the brand signal.
- Use pastel feature tints (`--color-tint-*`) for tinted card variants —
  emphasize visual hierarchy via background, not via primary purple
  surfaces.
- Test new components in both display styles (`default` and `soft`).
  If a component looks correct in only one, it's tied too tightly to
  one shape language.

### Don't

- **Don't use `--color-primary` for body text or large background
  surfaces.** Purple is the CTA color, not the brand background.
- **Don't use pill-shaped buttons in the default display style.** The
  default is Notion-sober rectangles. Pills are the `soft` display
  style.
- **Don't mix `--color-link` and `--color-primary`** — they have
  distinct roles. Links are blue (informational); primary is purple
  (action).
- **Don't hardcode hex values in components.** Every color must resolve
  through a token. If a hex appears in `/app` or `/components` outside
  of `globals.css`, that's a token gap to fix.
- **Don't add new font families** beyond Inter/Source Serif 4/JetBrains
  Mono. Three is the intentional cap.
- **Don't apply heavy shadows on flat documentation cards** — Notion's
  pattern is hairline borders + zero shadow for content surfaces.

## 8. Responsive Behavior

Tailwind v4's default breakpoints apply: `sm` (640px), `md` (768px),
`lg` (1024px), `xl` (1280px), `2xl` (1536px).

### Touch targets

- Buttons render at 40–48px effective height (sm/md/lg).
- Form inputs render at 44px height by default.
- Pill tabs at 32px desktop, 44px touch.

### Type scale collapsing

| Breakpoint         | h1 size              |
| ------------------ | -------------------- |
| `< sm` (mobile)    | 36px                 |
| `sm`–`md` (tablet) | 48px                 |
| `md`+ (desktop)    | 56–80px (per layout) |

Detailed responsive component behavior will land alongside each primitive
in Story 1.0.5.2+.

## 9. Agent Prompt Guide

**For Prodect's planner (Epic 4) — inject this section into every
design-type Subtask prompt:**

When generating UI for Prodect:

- **Use semantic Tailwind classes** for color and shape: `bg-background`,
  `text-foreground`, `bg-primary`, `text-muted-foreground`,
  `rounded-card`, `shadow-card`, `font-serif`, etc. These resolve
  through the active theme and display style.
- **Never write hex values** in component code. Every color comes from
  a CSS variable. If a hex appears, surface a token gap to fix.
- **Headlines use `font-serif`** (Source Serif 4); body uses
  `font-sans` (Inter); code/IDs use `font-mono` (JetBrains Mono).
- **One primary CTA per screen.** Don't dilute the purple `bg-primary`
  signal with multiple primary buttons.
- **Semantic colors are non-overlapping**: `success` (green) for
  confirmations, `warning` (orange) for mid-priority alerts, `destructive`
  (red) for errors and dangerous actions, `info` and `link` (blue) for
  neutral / informational.
- **For new component primitives**, define a small set of `--el-*`
  element tokens at the top of the component (or in `globals.css`'s
  Tier 3 block) and reference those rather than `--color-*` directly.
  Future palettes will override `--el-*` to reskin without touching
  components.
- **Test in both display styles** (`data-display-style="default"` and
  `data-display-style="soft"`). If a component only looks right in one,
  it's hardcoding shape and should be refactored to use semantic shape
  tokens.

### File references

- [`app/globals.css`](../app/globals.css) — all token definitions across
  four tiers
- [`lib/contexts/theme-context.tsx`](../lib/contexts/theme-context.tsx) —
  ThemeProvider and `useTheme()` hook
- [`app/tokens/page.tsx`](../app/tokens/page.tsx) — live token reference
- [`docs/inspiration/notion.md`](./inspiration/notion.md) — Notion source
- [`docs/inspiration/figma.md`](./inspiration/figma.md) — Figma source
