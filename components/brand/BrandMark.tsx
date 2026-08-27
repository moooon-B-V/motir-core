// The Motir brand lockup now ships from `@motir/brand` (MOTIR-1456 · ADR
// docs/decisions/brand-asset-distribution.md). This file is a thin re-export
// shim so the seven in-app consumers keep importing `@/components/brand/BrandMark`
// unchanged — the same shape MOTIR-1527 used when the design system moved out.
//
// The presentation it renders against (`.brand-lockup` / `.brand-glyph` /
// `.brand-word` / …) ships from `@motir/brand/brand.css`, imported by
// `app/globals.css` AFTER `@motir/design-system/theme.css`, whose `--el-*` and
// `--font-sans-source` tokens it reads.
export * from '@motir/brand';
