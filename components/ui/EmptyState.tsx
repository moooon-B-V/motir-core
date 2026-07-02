// Re-export shim — this surface moved into `@motir/design-system` (MOTIR-1527,
// ADR docs/decisions/design-system-package.md). motir-core consumes the shared
// package here so existing `@/…` import sites keep resolving unchanged.
export * from '@motir/design-system';
