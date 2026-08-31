// STRIP COMMENTS FROM TYPESCRIPT SOURCE — the correct order, and why the order
// is the whole content of this module (MOTIR-4035).
//
// A source-scanning guard asks "does this file's CODE do X", so it has to remove
// the prose first. The idiom in this tree does it in one expression:
//
//     source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
//
// ⚠️ BLOCK-COMMENTS-FIRST IS WRONG, AND IT FAILS SILENTLY IN THE DIRECTION THAT
// PASSES. A `//` line containing the two characters `/*` opens a block comment
// for that first regex, which then runs to the NEXT `*/` anywhere in the file —
// swallowing every line of real code in between. The scan does not error; it
// simply stops seeing that code, and a guard that cannot see code reports that
// the code is fine.
//
// It is not a contrived input. In this repository a line comment naming a route
// tree — `app/api/public/*`, `app/(authed)/*`, `design/<area>/*` — contains
// `/*` by construction, and that is ordinary prose in a file full of it. It was
// found when a freshly-written guard reported that `app/(authed)/layout.tsx`
// does not call `isCloud()`, seven lines after the call was added: a `//` line
// in the paragraph above it ended `…gated on \`app/api/public/*\` serves nothing,`
// and took the next five lines with it.
//
// LINE COMMENTS FIRST removes the hazard, because a `//` line is deleted before
// anything can read a `/*` out of it. The mirror case — `//` inside a block
// comment — is harmless: the block is removed whole either way.
//
// ⚠️ NEITHER ORDER IS A PARSER. A `/*` inside a STRING LITERAL still opens a
// block for a regex, and no amount of ordering fixes that; a guard that needs
// certainty should use the TypeScript compiler API, which is what the heavier
// scanners in `tests/rls/` do. This is the cheap tool, made correct for the
// input this tree actually produces.

/** `source` with its comments removed — line comments first, then blocks. */
export function stripSourceComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
