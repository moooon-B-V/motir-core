// The `/api/v1` CONTRACT VERSION — one number, one meaning, one definition
// (Story 11 · MOTIR-2275).
//
// ⚠️ WHY THIS IS ITS OWN MODULE, and not still a line in `openapi/emit.ts`.
// Two things read this number now: the emitted document (`info.version`) and
// the `X-Motir-Api-Version` header the wrapper stamps on EVERY response. The
// wrapper is on the hot path of every v1 request, and `emit.ts` imports the
// whole operation registry — every resource schema and every operation
// declaration — so importing the constant from there would drag the
// documentation emitter into the request path of the API it documents. A leaf
// module with no imports is what lets both sides read the SAME value without
// one depending on the other; `emit.ts` re-exports it, so every existing
// importer is unchanged.

/**
 * `info.version`, and the value of the `X-Motir-Api-Version` response header —
 * the API CONTRACT's version, NOT the app's release number.
 *
 * MAJOR is the path version (`1`), MINOR increments on an additive change under
 * ADR §8's allowed list, and PATCH on a documentation-only correction (ADR
 * Amendment 4 Q6). A client reading it learns what the contract offers; a
 * release number would churn on every unrelated deploy and tell a client
 * nothing it can act on. This is the number Story 11.5's CLI version-skew gate
 * compares against.
 *
 * ⚠️ **BUMP IT WHEN THE CONTRACT GROWS.** An additive change under §8 that
 * leaves this string alone makes the number lie about the one thing it exists
 * to report — and, since 1.1.0, it lies on a header every client reads off the
 * happy path rather than in a document nobody fetches at runtime.
 *
 * - `1.0.0` — the contract as Stories 11.1–11.4 and 11.7 shipped it.
 * - `1.1.0` — MOTIR-2275 adds the `X-Motir-Api-Version` response header.
 * - `1.2.0` — MOTIR-2279 adds the minimal ACTOR object to a collection row
 *   (`ReadyItem.assignee`), the rule Amendment 9 Q1 states for every one.
 * - `1.3.0` — MOTIR-2283 applies that rule to `Comment.author`, the one shape
 *   that had kept the rationale Amendment 9 overturned.
 */
export const V1_CONTRACT_VERSION = '1.3.0';
