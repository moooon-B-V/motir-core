# @motir/brand

## 0.3.0

### Minor Changes

- The brand colours follow the monochrome Motir palette (MOTIR-6474, `design/brand/design-notes.md` §10). Every carrier keeps the token it already named; under Motir the tile and the glyph-on-a-surface are no longer one colour.
  - `BRAND_ACCENT_HEX` (`--el-accent`, the tile / fill): `#5645d4` → `#1a1d21`
  - `BRAND_ACCENT_INK_HEX` (`--el-accent-text`): `#ffffff` → `#ffffff` (unchanged)
  - `BRAND_PAGE_BG_HEX` (`--el-page-bg`): `#ffffff` → `#ffffff` (unchanged)
  - **new** `BRAND_GLYPH_HEX` (`--el-accent-on-surface`, the bare glyph on a surface — email mark, OG cards): `#155bc4`
  - **new** `BRAND_ACCENT_DARK_HEX` (`--el-accent`, dark — the tab icon's `prefers-color-scheme: dark` tile): `#edeef0`
  - **new** `BRAND_ACCENT_INK_DARK_HEX` (`--el-accent-text`, dark): `#0c0d0f`
  - **new** `BRAND_LINK_HEX` (`--el-link` — email links, the Stripe accent): `#155bc4`
- A consumer drawing the glyph on a page (not in a tile) must move from `BRAND_ACCENT_HEX` to `BRAND_GLYPH_HEX`, or it paints the mark ink instead of blue.

## 0.2.4

### Patch Changes

- Updated dependencies [01294f1]
  - @motir/design-system@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [686a872]
  - @motir/design-system@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [570ecd1]
  - @motir/design-system@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [1491e94]
  - @motir/design-system@0.2.0
