# @motir/design-system

Motir's **3-axis design system** (Colour · Style · Type), extracted from
`motir-core` into a distributable package so the same tokens + primitives that
skin the Motir app can skin planner-scaffolded products — and the design choice
a user makes in onboarding can be re-applied by the coding agent at scaffold
time. One source, no vendored copies (the drift `notes.html` #18 warns of).

See the keystone decision: [`docs/decisions/design-system-package.md`](../../docs/decisions/design-system-package.md).

> **Scope of this package (Subtask MOTIR-1526).** This package is _created and
> verifiable in isolation_ here. Rewiring `motir-core` to consume it (replacing
> its inline `lib/theme/*` + `components/ui/*` with thin re-exports of this
> package) is the **next** subtask (MOTIR-1527), and the base-starter port is
> MOTIR-1528 — so each lands as its own reviewable PR. `motir-core`'s own files
> are untouched by this PR.

## What it ships

- **`@motir/design-system/theme.css`** — the full token layer as a distributable
  stylesheet: the Tailwind v4 `@theme` block, `@custom-variant dark`, the Tier-3
  `--el-*` element tokens, and every `[data-palette]` / `[data-style]` /
  `[data-type]` / `[data-surface]` override + surface-material block.
- **`@motir/design-system`** (JS entry) — the axis **registries**
  (`STYLE_IDS` / `PALETTE_IDS` / `TYPE_IDS`, `resolve*`, `is*Id`,
  `STYLE_DEFAULT_TYPE`), the **theme-apply API** (`buildThemeInitScript`,
  `resolveAxesToApplied`, `resolveAppliedAppearance`, `THEME_STORAGE_KEYS`,
  `THEME_DEFAULTS`), the applied-appearance **types**
  (`AppliedAppearanceDto`, `AppearancePreferenceDto`, `ThemePattern`, `StyleId`,
  `PaletteId`, `TypeId`), the `cn` helper, the **theme provider** (`ThemeProvider`
  / `useTheme`), the axis **pickers** (`StylePicker` / `PalettePicker` /
  `TypePicker` / `ThemeSegmentedControl`, from `AppearancePickers`) + the
  `StyleVignette` live preview, and the framework-agnostic **UI primitives**.

## Usage

Compose the tokens in your `globals.css` (Tailwind v4 reads `@theme` from the
imported CSS, so utilities generate with no extra config):

```css
@import 'tailwindcss';
@import '@motir/design-system/theme.css';
```

Apply a stored `{styleId, paletteId, typeId}` choice before hydration (FOUC-safe):

```tsx
import { buildThemeInitScript, resolveAxesToApplied } from '@motir/design-system';

const applied = resolveAxesToApplied(storedChoice);
// render <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript(applied) }} /> in <head>
```

Use the primitives + provider as normal React components:

```tsx
import { ThemeProvider, Button, Card } from '@motir/design-system';
```

## Boundary notes (how the extraction applied the ADR's rule)

The ADR's boundary rule: a file moves in **iff** its only imports are other
package files, framework peers, or `cn`. Applying it to the ADR's known lists
turned up three cases the audit's frozen list didn't fully reconcile — resolved
here, per the ADR's explicit delegation to this subtask:

- **`StyleVignette`** used the domain `IssueTypeIcon` for a single decorative
  glyph. Kept in the package, decoupled by inlining that glyph
  (`BookOpen` + `--el-type-story`) — pixel-identical, boundary-clean.
- **`Modal` / `Toast` / `ErrorState`** used `next-intl` for one aria/label string
  each. Kept in, decoupled via optional label props (`closeLabel` /
  `dialogLabel` / `retryLabel`) defaulting to the current English strings — so the
  package carries no `next-intl` dependency (§5 "framework-agnostic where it
  can"). motir-core will pass its translated labels when it consumes them (1527).
- **`DatePicker`** is genuinely coupled to the app's i18n (`useLocale` +
  `@/lib/i18n/locales` + locale-aware date formatting). Per the ADR §1 escape
  hatch ("a primitive that turns out to have a domain import the audit missed
  stays out"), it is **excluded** from this extraction; decoupling it (inject a
  formatter/locale) is a follow-up for the consume/port work.
- The token CSS ships as **`theme.css`** (the ADR §2 name; the card's provisional
  `tokens.css` was reconciled to this).

## Development

```bash
pnpm --filter @motir/design-system build      # tsup → dist (ESM + d.ts, 'use client' preserved)
pnpm --filter @motir/design-system typecheck   # tsc --noEmit
pnpm --filter @motir/design-system test        # vitest (registries, apply API, render)
```

`TokensSpecimen` is a live `/tokens`-style render of the whole system for
in-isolation verification; drop it into any route or render it headless.
