// The PUBLIC READ CONTRACT's version — one number, one meaning, one definition
// (MOTIR-3946).
//
// ⚠️ WHY THIS IS ITS OWN MODULE, and the same reason `lib/api/v1/contractVersion.ts`
// is one: a leaf with no imports lets the emitter and any future response header
// read the SAME value without one depending on the other. `emit.ts` imports the
// whole operation registry — every schema and every declaration — so importing
// the constant from there would drag the documentation emitter into anything
// that only wants the number.
//
// ⚠️ AND WHY IT IS NOT `V1_CONTRACT_VERSION`. `app/api/public/*` is a DIFFERENT
// contract from `/api/v1`, decided in `docs/decisions/public-surface-hosts.md`
// AMENDMENT 1 on three measured grounds: v1 is authenticated by construction
// (`withV1Route` requires a permission and 401s an anonymous caller), its
// operations reference envelopes these routes do not use, and its version is
// stamped on `X-Motir-Api-Version` by a wrapper these routes do not compose.
// One number covering both surfaces would be a promise about two things with
// different stability — unreadable by the client it exists for.

/**
 * `info.version` of the published public document.
 *
 * MAJOR changes only on a BREAKING change, which the deprecation policy in
 * AMENDMENT 1 §D defines and constrains. MINOR increments on an additive
 * change — a new operation, a new optional response field, a new optional
 * parameter. PATCH is a documentation-only correction that changes no wire
 * shape.
 *
 * ⚠️ **BUMP IT WHEN THE CONTRACT GROWS.** A consumer reads this number to learn
 * what the contract offers; an additive change that leaves it alone makes it
 * lie about the one thing it exists to report.
 *
 * ⚠️ AND IT IS A SERIALIZED RESOURCE, the way `V1_CONTRACT_VERSION` is: every
 * in-flight additive pull request claims the next MINOR. Read this file on
 * `origin/main` before merging and renumber if a sibling has taken it — which
 * is why each entry below names the OPERATIONS it added rather than a position.
 *
 * - `1.0.0` — MOTIR-3946: the contract's spine and the three reads a public
 *   renderer needs first (`getPublicProject`, `listPublicProjects`,
 *   `listPublicCategories`), with the document, the deprecation policy and the
 *   drift guard.
 * - `1.1.0` — MOTIR-3990 brings it to TOTALITY: the nine remaining operations —
 *   `getPublicProjectTreeLevel`, `listPublicProjectWorkItems`,
 *   `getPublicProjectRoadmapColumn`, `listPublicProjectChangelog`,
 *   `subscribeToPublicProject`, `followPublicProject`, `unfollowPublicProject`,
 *   `submitPublicRequest`, `findPublicRequestDuplicates` — plus the coverage
 *   guard that fails on a route with no declaration. Additive under §D's first
 *   clause: nine new operations, no declared shape changed, nothing on the wire
 *   moved. Four of them REQUIRE the application's session and say so, which is
 *   a correction to what 1.0.0's document implied rather than a change to any
 *   route (see AMENDMENT 1 §G).
 */
export const PUBLIC_CONTRACT_VERSION = '1.1.0';

/** The MAJOR, for the document's own identity. */
export const PUBLIC_API_MAJOR = 1;
