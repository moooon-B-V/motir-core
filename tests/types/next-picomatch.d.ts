// `next/dist/compiled/picomatch` is a vendored bundle with no `.d.ts`, so
// importing it trips `noImplicitAny` (TS7016).
//
// `tests/brand/opengraphImages.test.tsx` imports it ON PURPOSE rather than
// reaching for a matcher of its own: it asserts that the
// `outputFileTracingIncludes` keys in `next.config.ts` actually MATCH the routes
// Next builds — and the only way that assertion means anything is to ask the
// very matcher `collect-build-traces.js` will ask. A reimplementation would test
// the reimplementation.
//
// Typed to the two options that call site passes, not to picomatch's full
// surface: a declaration that claims more than it has been checked against is
// its own kind of lie.
declare module 'next/dist/compiled/picomatch' {
  interface PicomatchOptions {
    dot?: boolean;
    contains?: boolean;
  }
  const picomatch: (glob: string, options?: PicomatchOptions) => (value: string) => boolean;
  export default picomatch;
}
