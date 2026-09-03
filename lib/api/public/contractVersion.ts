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
 * - `1.2.0` — MOTIR-4109 gives the BOARD tab and the ROADMAP's first page their
 *   reads: a new `getPublicProjectBoard`, and a second ARM on the existing
 *   `getPublicProjectRoadmapColumn` — with neither `bucket` nor `cursor` it now
 *   answers the whole `PublicRoadmap` instead of `MISSING_ROADMAP_CURSOR`.
 *   Additive under §D: a new operation, and two REQUIRED parameters relaxed to
 *   optional, which is the direction §D permits (it forbids the inverse). Every
 *   request that has a defined answer today keeps exactly that answer — the
 *   both-absent case is the only new one — so no status an existing condition
 *   returns has moved. The `operationId` is deliberately NOT renamed: a
 *   generated client names its method after it.
 * - `1.3.0` — MOTIR-4110 gives the two DETAIL reads their routes:
 *   `getPublicProjectWorkItem` and `getPublicProjectRequest`. Additive under §D
 *   — two new operations, no declared shape changed. Both are keyed by the
 *   project key plus the target's WORK-ITEM identifier, which is what the
 *   service takes and what a shared link carries; the request WRITES beside
 *   them stay keyed by ids, and that asymmetry is declared rather than
 *   smoothed over.
 * - `1.4.0` — MOTIR-4111 restores the CRAWL surface: `listPublicProjectIndex`
 *   (the sitemap enumeration, keyset-paged on a stable order) and
 *   `getPublicProjectChangelogFeed` (the Atom document whose builder had been
 *   caller-less since the pages were deleted). Additive under §D — two new
 *   operations. The feed is the FIRST operation here that does not answer JSON,
 *   so the declaration gained a `responseMediaType`; every existing operation
 *   defaults to `application/json` and none of their documents changed.
 * - `1.5.0` — MOTIR-4217 gives the tenant-address surface its producer end:
 *   `resolvePublicHost` (`/api/public/hosts/{host}`), the one read a second
 *   renderer makes to turn a `Host` header into a subject. Two existing
 *   documents also GAIN a field — `PublicProjectOverview.addresses` (the
 *   canonical URL and its alternates) and `PublicProjectIndexEntry.primaryHost`
 *   (the host a project's canonical lives on, so a sitemap can list only its
 *   own host's URLs). Additive under §D: one new operation and two added
 *   response properties. **No existing property changed type, went optional, or
 *   moved**, and every request that has a defined answer today keeps exactly
 *   that answer — a project with no claimed address reports its `motir.co`
 *   URL as `primary`, which is the address it already had.
 */
export const PUBLIC_CONTRACT_VERSION = '1.5.0';

/** The MAJOR, for the document's own identity. */
export const PUBLIC_API_MAJOR = 1;
