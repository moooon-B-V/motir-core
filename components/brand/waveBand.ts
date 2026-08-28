// The wave-band geometry, its baked colour literals and the email-mark
// constants now ship from `@motir/brand` (MOTIR-1456 · ADR
// docs/decisions/brand-asset-distribution.md). This file is a thin re-export
// shim so `app/manifest.ts`, both `opengraph-image.tsx` routes,
// `PlanWithAIFab`, `EmailLayout` and the `scripts/brand/*` generators keep
// importing `@/components/brand/waveBand` unchanged.
export * from '@motir/brand';
