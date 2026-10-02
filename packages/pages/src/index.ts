// `@motir/pages` — the pages module (Story MOTIR-5751 · MOTIR-5757), under
// `docs/decisions/pages.md` and `docs/decisions/app-shell-over-packages.md`.
//
// ⚠️ THIS BARREL IS THE PACKAGE'S WHOLE SURFACE. The app imports
// `@motir/pages`, never a path inside `src/`, which
// `tests/packages/importDirection.test.ts` asserts.
//
// Today it holds the page model types, the pure tree rules and the record's
// constants. The document conversions, the editor and the save procedure arrive
// with the stories that use them; the app's composition root
// (`lib/pages/index.ts`) arrives with the schema story.

export * from './constants';
export * from './types';
export * from './errors';
export * from './tree';
export * from './position';
