// Vite/Vitest-only members of `import.meta`, typed for the TEST tree.
//
// `import.meta.glob` is a BUILD-TIME transform Vite performs on the literal
// call expression — it is not a real runtime function, which is why it must be
// written out in full (aliasing it throws "statically replaced during file
// transformation") and why TypeScript's `ImportMeta` does not carry it.
//
// Declared here rather than by adding `vite/client` to the project's `types`:
// that would also pull in Vite's ambient asset-module declarations (`*.svg`,
// `*.css?inline`, …) for the whole repo, which the Next build does not provide.
//
// Used by `tests/helpers/v1RouteAudit.ts` to DISCOVER the `/api/v1` route tree
// so the guards and the conformance harness never need a hand-maintained list.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
