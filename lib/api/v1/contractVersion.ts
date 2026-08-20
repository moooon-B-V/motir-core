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
 * ⚠️ **FOR A NEW OPERATION THAT OBLIGATION HAS AN EXECUTOR** —
 * `tests/api/v1/contract-version-guard.test.ts` fails when the operation
 * registry holds an id that no entry below names (MOTIR-3157). It cannot check
 * a new FIELD or a new HEADER, so for those the rule above is still discharged
 * by whoever remembers it; for an endpoint it is not.
 *
 * - `1.0.0` — the contract as Stories 11.1–11.4 and 11.7 shipped it.
 * - `1.1.0` — MOTIR-2275 adds the `X-Motir-Api-Version` response header.
 * - `1.2.0` — MOTIR-2279 adds the minimal ACTOR object to a collection row
 *   (`ReadyItem.assignee`), the rule Amendment 10 Q1 states for every one.
 * - `1.3.0` — MOTIR-2283 applies that rule to `Comment.author`, the one shape
 *   that had kept the rationale Amendment 10 overturned.
 * - `1.3.1` — MOTIR-2317 declares the ready set's `kind` / `priority` as the
 *   ARRAYS the route has always read them as. A PATCH, not a minor: the set of
 *   requests the server accepts is unchanged — `parseReadyFilters` has read
 *   both with `getAll` since they shipped — and only the document, which
 *   described them as scalars while its own prose said "Repeatable", moves.
 * - `1.4.0` — MOTIR-2318 adds `GET …/work-items/count`, the operation
 *   Amendment 14 decided on so a client can learn how many items match a filter
 *   without paging the match set. Additive: a new operation, no declared shape
 *   changed.
 * - `1.5.0` — MOTIR-2320 adds `totalComments` / `totalChanges` to the activity
 *   page (Amendment 15). The merged `all` view reports two streams, and one
 *   `totalCount` cannot say what it is made of. Additive: two new fields,
 *   `totalCount` unchanged in meaning on every view.
 * - `1.6.0` — MOTIR-2400 adds `inheritedSessionBranch` to the READY row
 *   (Amendment 17). The row asserted that an item is ready without saying what
 *   that readiness is measured against — from the trunk, or on top of unmerged
 *   work. Additive: one new field, and the `blockedBy` it sits beside is
 *   unchanged.
 * - `1.7.0` — MOTIR-2445 adds `parentKey` to the DISPATCH PROMPT. The prompt
 *   already named the parent in its CONTEXT prose; the field lets a client read
 *   it without parsing text the server may reword — and costs no query, since
 *   the parent row is already read to render that line. Additive: one new
 *   field, the prompt text byte-identical.
 * - `1.8.0` — MOTIR-2421 adds `POST /api/v1/work-items/{key}/implementation`.
 *   Recording WHAT BUILT an item was only reachable through the integration
 *   endpoint, which requires a session branch — so the per-item-PR path could
 *   not record provenance at all without also asserting a lineage that does not
 *   exist. Additive: one new endpoint, on the existing `integration` scope, with
 *   `POST …/integration` unchanged in shape and behaviour.
 * - `1.9.0` — MOTIR-2728 adds `targetRepos` to the work-item detail response and
 *   to both work-item write bodies: the ordered SET of repositories an item ships
 *   in, of which `targetRepo` is the first element. Additive on all three, and
 *   deliberately so — §8 forbids removing, renaming or retyping a published
 *   field, and turning `targetRepo` into an array is all three at once. A client
 *   written against `targetRepo` keeps reading the repository dispatch routes to;
 *   one that never learns about the set under-reports rather than mis-reports.
 *   The two write fields are MUTUALLY EXCLUSIVE (`CONFLICTING_TARGET_REPO_INPUT`,
 *   422) — a new CONDITION getting a status, which §8 permits, on an existing
 *   code family. See `docs/decisions/work-item-repository-set.md` §3.
 * - `1.10.0` — MOTIR-2903 adds the SUBSUMPTION member to the dispatch prompt's
 *   `advisories` union: a card whose body names a path a later merge already
 *   changed, so its deliverable may already be in the repository. Additive — a
 *   new member of a union on a field clients are required to tolerate unknown
 *   members of, with every existing member byte-identical.
 * - `1.11.0` — MOTIR-3041 adds `targetRepositories` — the item's repository set
 *   as REFERENCES to the project's `project_repository` rows — beside the
 *   derived names, on the work-item detail response, the MCP item shape and the
 *   DTO. Additive; the names it publishes are read projections of the same
 *   references. (Logged retroactively by MOTIR-3131: the bump shipped with
 *   MOTIR-2732 and the line for it did not.)
 * - `1.12.0` — MOTIR-3131 adds `targetRepos` to the DISPATCH PROMPT: EVERY
 *   repository the item ships in, ordered with the primary first, each with its
 *   clone URL, its default branch and its per-repository delivery state. The
 *   payload described a repository where the card has a set, so a launcher could
 *   not resolve a checkout, a prompt could not instruct a second worktree, and a
 *   run could not say that one of two repositories had already shipped.
 *   Additive: one new field, the three scalars unchanged in value, the assembled
 *   `prompt` text byte-identical. See `docs/decisions/work-item-repository-set.md`
 *   § *Amendment 2026-08-19* §B1.
 * - `1.13.0` — MOTIR-3110 adds the SIZING member to the dispatch prompt's
 *   `advisories` union: a childless `coding_agent` card sized over the
 *   estimation gate (13+ story points, or more than 60 estimated minutes).
 *   Additive on the same terms as `1.10.0` — a new member of the same union, on
 *   the same field clients must tolerate unknown members of. It is a SECOND
 *   `kind: "shape"` variant rather than a third severity inside the existing
 *   one, because it carries no `criterionIndex` and making that field optional
 *   would be a nullability change §8 forbids. Every existing member is
 *   byte-identical.
 * - `1.14.0` — MOTIR-3157 records `uploadWorkItemAttachment`, the
 *   `POST /api/v1/work-items/{key}/attachments` operation MOTIR-3000 shipped
 *   WITHOUT moving this number. Additive: a new endpoint, §8's first allowed
 *   change — so the contract grew when that operation merged and only the
 *   number stood still, which is the one thing this string exists not to do.
 *   The bump is therefore RETROACTIVE, and the entry names the OPERATION rather
 *   than the position: which minor it lands on depends on merge order, and a
 *   reader asking "when did the attachment door arrive?" needs the id, not the
 *   ordinal. Nothing on the wire changes here — the endpoint has been live
 *   since #2145; what changes is that a client pinning a minor to get it is now
 *   told the truth by `X-Motir-Api-Version`.
 * - `1.15.0` — MOTIR-2961 adds `claimWorkItem`,
 *   `POST /api/v1/work-items/{key}/claim`: an ATOMIC claim of one work item BY
 *   KEY — lock the row, re-assert the to-do category, assign and transition, in
 *   one transaction. Every dispatch path except `claim_next_ready`'s "give me
 *   whatever is next" was serialising claimants with an assignment its own code
 *   calls an advisory, so two runs could start the same card. Additive: one new
 *   endpoint (§8's first allowed change) and one new resource (`WorkItemClaim`);
 *   no declared shape changed.
 * - `1.16.0` — MOTIR-3178 adds the SELF-BLOCKING-DESIGN member to the dispatch
 *   prompt's `advisories` union: a CHILDLESS card one of whose acceptance
 *   criteria produces a design ASSET while another builds the rendered SURFACE
 *   that drawing decides — the planning-time design gate's degenerate reading,
 *   where the `type: design` subtask a UI card must be linked to IS the card.
 *   Additive on the same terms as the sizing member — a new member of the same
 *   union, on the same field clients must tolerate unknown members of. It is a
 *   THIRD `kind: "shape"` variant rather than a fourth severity inside the
 *   criterion-carrying one, because it carries a PAIR of indices
 *   (`designCriterionIndex` / `surfaceCriterionIndex`) and no `criterionIndex`
 *   at all. Every existing member is byte-identical.
 * - `1.17.0` — MOTIR-3017 adds two things a run needs in order to report what it
 *   found, both additive. (1) An optional `findingsPolicy` query parameter on
 *   `GET …/dispatch-prompt`: a comma-separated list of the capabilities this run
 *   switches OFF for its agent. Omitted renders the protocol byte-identically to
 *   today, so no existing caller moves; an unrecognised capability is refused
 *   (`INVALID_FINDINGS_POLICY`, 422) rather than ignored, which is a new
 *   CONDITION getting a status on an existing operation — §8's allowed shape.
 *   (2) `approveWorkItemPlan` — `POST /api/v1/work-items/{key}/plan-approval`,
 *   the bounded public entrance to `plansService.approvePlan` that
 *   `motir auto --auto-approve-replan` drives: a new operation, gated by the key
 *   the service already asserts, with no declared shape changed. Its 409
 *   additionally carries
 *   `planStatus`, an enrichment on a NEW condition rather than a change to an
 *   existing one. See `docs/decisions/run-findings-protocol.md`.
 *
 *   ⚠️ THAT KEY IS NOW `ai:decide_plan`, AND THE VERSION DOES NOT MOVE FOR IT
 *   (MOTIR-3188, 2026-08-20). The entry above named `ai:view_plan`; that key
 *   gated no view and held AUTHOR and DECIDE at once, and the decisions were
 *   split onto `ai:decide_plan`. `approveWorkItemPlan` follows the service, as it
 *   always did. **No §8 clause moves:** no field is removed, renamed or retyped,
 *   no error `code` is repurposed, no existing condition changes status, no limit
 *   tightens and no optional parameter becomes required — the operation is byte-
 *   identical in shape. §8 governs the CONTRACT's surface, and a gate is not on
 *   it; inventing a clause for one here would be a policy change of its own
 *   (and would bind `POLICY_FORBIDDEN` in `lib/apiDocs/guide.ts`), not a note.
 *
 *   ⚠️ THE ONE THING A READER SHOULD KNOW ANYWAY, stated rather than buried: a
 *   token holding an EXPLICIT grant of `ai:view_plan` and not `ai:decide_plan`
 *   loses this operation. Every built-in role resolves the two keys identically,
 *   and `DEFAULT_TOKEN_GRANT` is derived at mint from the grantable set, so the
 *   affected population is tokens minted with a hand-picked grant in the window
 *   between MOTIR-3021 landing and this change — hours, on one deployment. Re-mint
 *   or edit such a token's grant; nothing about the request or response changes.
 *
 *   ⚠️ RENUMBERED 1.14.0 → 1.17.0 ON MERGE, which is the process working rather
 *   than a correction. This number is a SERIALIZED RESOURCE: every in-flight
 *   additive pull request claims the next MINOR, and three landed while this one
 *   was open (MOTIR-3157, MOTIR-2961, MOTIR-3178). The entry above names the
 *   OPERATIONS rather than a position precisely so renumbering stays one line,
 *   and it did.
 */
export const V1_CONTRACT_VERSION = '1.17.0';
