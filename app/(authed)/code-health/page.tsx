import { permanentRedirect } from 'next/navigation';

// `/code-health` IS NOW `/code` (Story MOTIR-1754 · MOTIR-1768).
//
// The audit did not move surfaces — it became one SECTION of the Code room, so
// everything this route used to render still renders, one tab over. The page's
// whole body, its two-phase read and its five components live under
// `app/(authed)/code/`; nothing about them changed.
//
// ⚠️ PERMANENT (308), NOT TEMPORARY, and the difference is not pedantic. This is
// a route that is never coming back: `Code health` was a top-level row and is
// now a tab, so every bookmark, every link in a shipped email, and every design
// asset that names this address should be re-pointed by whoever holds it rather
// than redirected for ever. A 307 tells a client to keep asking.
//
// ⚠️ AND THE REDIRECT IS ITSELF A COST, NAMED RATHER THAN ABSORBED.
// `tests/design-asset-addresses.test.ts` fails an asset that names an address
// which redirects away, so every asset naming `/code-health` needs a `KNOWN` row
// recording it as a point-in-time record. Those rows were enumerated from a run
// of that lane, not guessed.
//
// ⚠️ NO `loading.tsx` IS ADDED ANYWHERE ON THIS PATH. `/code` calls no
// `notFound()`, so it is not itself a decider — but `app/(authed)` is a group
// containing eleven of them, and a boundary at the group root fixes the status
// at 200 before any page function runs (CLAUDE.md § A `loading.tsx` may NOT sit
// above a route that decides existence).
export default function CodeHealthRedirect(): never {
  permanentRedirect('/code');
}
