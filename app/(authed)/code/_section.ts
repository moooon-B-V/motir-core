// WHICH SECTION THE URL ASKS FOR — the parser, and NOTHING ELSE (Story
// MOTIR-1754 · MOTIR-1768).
//
// ⚠️ THIS FILE EXISTS BECAUSE OF WHERE IT IS NOT. `sectionFromParam` used to sit
// in `_components/CodeSections.tsx`, beside the component that consumes it,
// which reads as good colocation and is a 500 in production.
//
// `CodeSections.tsx` is `'use client'`. A server component importing a
// non-component export from a client module does not get the FUNCTION — it gets
// a client REFERENCE, an opaque object the bundler substitutes so the value can
// be shipped across the boundary. Calling it throws, and the page answers "This
// page couldn't load. A server error occurred."
//
// ⚠️ AND NO UNIT TEST CAN SEE IT. Vitest compiles this module graph as plain
// ESM with no RSC boundary, so `sectionFromParam` is simply a function there and
// every assertion about it passes — including the ones in `codePage.test.ts` and
// the render harness's. The substitution only happens in a real Next build,
// which is why this surfaced as a browser-level 500 in the cloud lane and
// nowhere else. Keeping the parser in a module with no `'use client'` is what
// makes it importable from BOTH sides, which is the actual requirement.

/** The two sections of the Codebase room. */
export type CodeSection = 'repositories' | 'health';

const SECTIONS: readonly CodeSection[] = ['repositories', 'health'];

/** The section a URL asks for, or the default. Unknown values fall back rather than throw. */
export function sectionFromParam(raw: string | null | undefined): CodeSection {
  return SECTIONS.includes(raw as CodeSection) ? (raw as CodeSection) : 'repositories';
}
