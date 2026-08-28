// `export *` rather than a named list: `waveBand.ts` is the module where the
// mark's BAKED colour literals and the email-mark constants live alongside the
// geometry (see its own header — the bake happens ONCE, here, with each literal
// naming the token it came from). A named re-export list would go stale the
// first time that module grows a constant, silently, so the barrel mirrors the
// module instead. `isolatedModules` is on and `verbatimModuleSyntax` is not, so
// `export *` correctly carries both the types and the values.
export * from './BrandMark.js';
export * from './waveBand.js';
