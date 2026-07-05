# ADR: The issue importer — sources, field mapping, idempotent re-run, and dry-run

- **Status:** Accepted (2026-07-05) — drafted by the planner from the decision-authority ladder (mirror products → shipped code → card) and the verified mirrors below; ratified on PR merge.
- **Story / Subtask:** 7.16 · Issue importer (MOTIR-816) · Subtask 7.16.2 (MOTIR-938)
- **Supersedes / superseded by:** none. (Supersedes the archived exploratory Story 7.17 / MOTIR-627, which this journey-ordered 7.16 tree replaced.)
- **Consumed by:** MOTIR-937 (7.16.1 wizard design), MOTIR-939 (7.16.3 `Import` model + external-id map + migration), MOTIR-1501 (7.16.4a connector interface + `SourceIssue` + CSV + GitHub), MOTIR-940 (7.16.4 Jira + Linear connectors), MOTIR-1504 (7.16.5a mapping resolver + idempotency lookup + dry-run classify), MOTIR-941 (7.16.5 persist engine + import routes), MOTIR-942 (7.16.6 wizard UI), MOTIR-943 (7.16.7 source OAuth apps / API tokens), MOTIR-944 (7.16.8 vitest), MOTIR-945 (7.16.9 Playwright E2E).

> This record follows the house ADR convention set by `docs/decisions/work-item-type-taxonomy.md`: a markdown file under `docs/decisions/`, named for the thing it fixes, structured **Status → Context → Decision → Consequences → References**, with the load-bearing facts pinned in explicit tables. It is the durable SHAPE of the importer, fixed BEFORE the code cards build it (the no-shortcuts rule — pick the durable shape, not the demoable happy path).

---

## Context

Journey A ("onboard an existing project") needs to pull an existing project's **entire issue history** from another tracker into Motir work items. The sources are **Jira, Linear, GitHub Issues** (live REST/GraphQL) and **CSV** (uploaded-file parse — the universal, credential-free fallback). Every imported issue must land as a first-class Motir work item through the **Epic-2 write authority** (`lib/services/workItemsService.ts`), honouring the same grammar (kind-parent matrix, per-project workflow statuses, priority scale, links) that the rest of the app enforces — an import is not a side-door around the schema.

**Scope: import ALL issues regardless of state — open AND closed/done alike — not just the open backlog.** Closed issues are not noise to be filtered out; they are load-bearing project context. Motir is AI-native and the work-item tree IS the project's execution and context history, so an imported project needs its _completed_ work — what shipped, the bugs that were fixed, the decisions that were closed — as much as its open items: that history is exactly what grounds AI planning, code-context retrieval, and "what has this project already done" reasoning. The default import is the whole history, end to end; a done issue maps to a **done-category** `workflow_status`, not dropped. (Where the wizard offers a scope filter — by project, by date, by state — the DEFAULT includes closed/done; narrowing is an explicit opt-out, never the default.) The connectors must request every state accordingly — in particular the **GitHub list-issues API defaults to `state=open`**, so its connector MUST pass `state=all` or it would silently drop every closed issue (see the connector table).

Three properties are non-negotiable in the v1 shape (no "MVP-now / v2-later" deferral of any of them):

1. **Pagination** — every live source API is paginated; a connector pages, it never "fetches all in one call."
2. **Idempotent re-run** — re-importing the same source must UPSERT, never duplicate.
3. **Dry-run preview** — every import is previewed and confirmed before it writes.
4. **Whole history, all states** — open and closed/done issues are both imported; closed items carry their done-category status. Never a silent "open only" filter.

This ADR is grounded against **shipped reality** (rung 2 of the decision-authority ladder), read at authoring time. Where the card's prose (rung 3) conflicts with the shipped code, the code wins and the contradiction is flagged here rather than silently conformed to — see the priority and reporter/status/comment-author notes below.

### Shipped surfaces this decision binds to

| Surface                           | Location                                                                                                                                        | What it fixes for the importer                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Work-item create/update authority | `lib/services/workItemsService.ts` — `createWorkItem` (`CreateWorkItemInput`), `updateWorkItem` (`UpdateWorkItemInput`)                         | The only write path a mapped issue takes. Its input shape (`lib/dto/workItems.ts:695–855`) defines what a mapping may set.               |
| Workflow statuses                 | `WorkflowStatus` (`prisma/schema.prisma`), `lib/workflows/defaultWorkflow.ts`, `lib/services/workflowsService.ts`                               | Per-project, `key`-addressed, category ∈ {`todo`,`in_progress`,`done`}; exactly one `isInitial`. Status is NOT a free-form create field. |
| Kind-parent matrix                | `prisma/sql/work_item_triggers.sql` (`enforce_work_item_kind_parent`), `lib/issues/parentRules.ts` (`ALLOWED_CHILD_TYPES`, `assertValidParent`) | DB-enforced legal (parent-kind → child-kind); max depth 4; `subtask` must have a parent; `epic` must be root.                            |
| Priority scale                    | `WorkItemPriorityDto` (`lib/dto/workItems.ts:20`)                                                                                               | `lowest \| low \| medium \| high \| highest` — **no `none`**; column default `medium`.                                                   |
| Labels                            | `lib/services/labelsService.ts` — `setLabels(workItemId, names[])`                                                                              | Find-or-create by name (case-insensitive per project). Maps cleanly.                                                                     |
| Comments                          | `lib/services/commentsService.ts` — `addComment`                                                                                                | `authorId` = `ctx.userId`, `createdAt` = `now()` — **author + timestamp are NOT overridable** as shipped.                                |
| Attachments                       | `lib/services/attachmentsService.ts` — `uploadAttachment(file)` → `attachToWorkItem`                                                            | Uploader is the current user; needs the source bytes fetched then uploaded.                                                              |
| GitHub token substrate            | `GithubIdentity.accessTokenEncrypted` (AES-256-GCM, `lib/github/tokenCrypto.ts`); `lib/git/` provider seam                                      | Reusable per-user OAuth token for the GitHub Issues connector — no new token store for GitHub.                                           |

There is **no existing importer, `Import` model, or external-id map** in the repo today (only the `app/(onboarding)/onboarding/import` "coming soon" placeholder) — the importer is greenfield, so this decision is unconstrained by legacy import code.

---

## Decision

### 1 · Sources + the connector interface

The connector layer is an **interface, not a per-source wizard branch**. A fifth source is a new connector class, not a change to the mapping/preview/persist pipeline.

```ts
interface IssueSourceConnector {
  readonly source: 'jira' | 'linear' | 'github' | 'csv';
  // Pages the source and YIELDS normalised issues — never returns "all at once".
  fetchIssues(cfg, cursor?): AsyncIterable<SourceIssue>; // or a paged { issues, nextCursor }
}
```

Every connector normalises its source into ONE internal shape — the **normalised `SourceIssue`** (MOTIR-1501 owns the type) — before any mapping runs. The mapping/dry-run/persist stages are **source-agnostic**: they see only `SourceIssue`, never a Jira/Linear/GitHub payload. This is the **verified Linear precedent** (`packages/import`): a single `Importer` interface + a shared `ImportResult` normalised model, with one implementation per source (`jiraCsv`, `github`, `trelloJson`, …).

| Source            | Access shape          | Pagination (VERIFIED — a paging loop is mandatory)                                          | Credentials                                                                          |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Jira**          | REST issue search     | `startAt` + `maxResults` offset paging (default page 50) — loop incrementing `startAt`      | OAuth / API token (MOTIR-943)                                                        |
| **Linear**        | GraphQL               | Relay cursor paging: `first` + `after`; page until `pageInfo.hasNextPage` is false (def 50) | OAuth / API key (MOTIR-943)                                                          |
| **GitHub Issues** | REST list-repo-issues | `per_page` (max 100) + `page`, Link headers                                                 | Reuse `GithubIdentity.accessTokenEncrypted` (per-user OAuth) where present; else 943 |
| **CSV**           | Uploaded-file parse   | n/a (whole file, streamed rows)                                                             | **none** — the universal fallback                                                    |

Connectors carry paginate + retry scaffolding (MOTIR-1501); Jira + Linear live-field-mapping into `SourceIssue` is MOTIR-940; the interface + `SourceIssue` + CSV + GitHub connector is MOTIR-1501.

**How the data actually leaves each source — a LIVE API is the primary path, a FILE EXPORT is the credential-free alternative.** Every live source has a first-class read API we connect to directly; every source that can produce a file export routes that export through the ONE CSV/file connector — so a user who can't or won't grant API access can still import. The two paths converge on the same `SourceIssue` and the same mapping/dry-run/persist pipeline.

| Source     | Live API (primary connector)                        | Auth                                               | File export → CSV connector                                                 |
| ---------- | --------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| **Jira**   | REST issue-search (JQL), offset-paginated           | OAuth 2.0 (3LO) or API token (MOTIR-943)           | ✅ Jira's native CSV export (Issues → Export → CSV)                         |
| **Linear** | GraphQL `issues` query, cursor-paginated            | OAuth 2.0 or personal API key (MOTIR-943)          | ✅ Linear's CSV export                                                      |
| **GitHub** | REST list-repo-issues (`state=all`), page-paginated | Reuse `GithubIdentity` OAuth token; else MOTIR-943 | ⚠️ no first-party issues CSV export — API is the path (or a hand-built CSV) |
| **CSV**    | — (this IS the file path)                           | **none**                                           | ✅ the universal target: any of the above exports, or a hand-made sheet     |

**Deliberate altitude:** this ADR fixes the access _model_ per source (API type, auth model, pagination, the export alternative) — it does NOT pin exact endpoint URLs, OAuth scopes, or the JQL string. Those are connector-implementation detail owned by **MOTIR-940** (Jira + Linear), **MOTIR-1501** (GitHub + CSV), and **MOTIR-943** (OAuth-app / token provisioning), which read the vendor's _current_ API docs at build time — deliberately, because vendor endpoints move (e.g. Jira Cloud is mid-migration from `/rest/api/3/search` to a token-paginated `/search/jql`), and a durable decision doc must not hard-code a moving endpoint.

**Every connector fetches ALL states (open + closed/done), per the whole-history scope above.** No connector applies an open-only filter. Concretely: **GitHub** must pass `state=all` (its list-issues API defaults to `state=open` — omitting this silently drops closed issues); **Jira** uses a JQL with no `status`/`resolution` clause (an unfiltered JQL returns every state, resolved and unresolved); **Linear** fetches without a state filter (all workflow states, including completed/cancelled); **CSV** carries whatever rows the export contains. A closed source issue therefore reaches the resolver with its real closed status, which maps to a done-category `workflow_status` (§2, status).

### 2 · Field mapping (`SourceIssue` → Motir work item)

Every mapped issue is persisted through `workItemsService.createWorkItem` / `updateWorkItem` (+ the sibling services for labels/comments/attachments — those are the Epic-2 surface for those entities, NOT a second write path around it). The mapping resolver is MOTIR-1504; the persist engine is MOTIR-941.

| Source field       | Motir target              | Rule                                                                                                                                                                                                                                                                                                                                                                             | Shipped-surface note                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **issue type**     | `kind`                    | Map source type → kind, then **validate against the kind-parent matrix**: a mapped parent must be legal for the child kind, depth ≤ 4, `subtask` must have a parent, `epic` must be root. Illegal edge → resolve (drop the parent edge, or re-map kind), never emit an issue the DB trigger will reject.                                                                         | `assertValidParent` (`parentRules.ts`) is enforced on create; the resolver pre-checks so persist never hits a 422.                                                                                                                                                                                                 |
| **status**         | project `workflow_status` | Map source status → one of the **target project's** `WorkflowStatus` keys, **including done-category statuses** — a closed/resolved source issue maps to a done-category status (e.g. `done`/`cancelled`) and is imported closed, never re-opened or dropped. Unmatched → **user choice in the wizard: map to an existing status or a chosen default — never silently dropped.** | `status` is NOT settable on create (create lands in `isInitial`) or via `updateWorkItem`. The mapped status is applied through the workflow transition path — see Consequences → _required extension_; that path MUST be able to reach a **done-category** status (closed items are in scope), not only open ones. |
| **priority**       | `priority`                | Map source priority → `lowest \| low \| medium \| high \| highest`. **Unmatched → `medium`** (the column default).                                                                                                                                                                                                                                                               | **Card said "unmatched → none"; the shipped enum has no `none` (`lib/dto/workItems.ts:20`).** Rung 2 wins: default to `medium`, do NOT invent a `none` value.                                                                                                                                                      |
| **assignee**       | `assigneeId`              | Match by **email** to a workspace member. Unmatched → user choice: **leave unassigned** or **invite**. Never a silent drop.                                                                                                                                                                                                                                                      | `assigneeId` IS settable on create.                                                                                                                                                                                                                                                                                |
| **reporter**       | (see note)                | Preserve the source reporter, matched by email to a member, where the source provides it.                                                                                                                                                                                                                                                                                        | **`reporterId` is NOT settable — `createWorkItem` forces `reporterId = ctx.userId`.** Preservation needs an in-authority extension (Consequences); until then reporter falls to the importing user + the original is captured in history/first comment.                                                            |
| **labels**         | Motir labels              | `labelsService.setLabels(workItemId, names[])` — find-or-create by name.                                                                                                                                                                                                                                                                                                         | Clean map.                                                                                                                                                                                                                                                                                                         |
| **comments**       | Motir comments            | Import with **author (email-matched) + original timestamp** where the source provides them; ordering preserved.                                                                                                                                                                                                                                                                  | **`addComment` hardcodes `authorId = ctx.userId`, `createdAt = now()`.** Author/timestamp preservation needs a commentsService extension (Consequences); degraded fallback = importing user + an in-body "originally by X on DATE" line.                                                                           |
| **attachments**    | Motir attachments         | Fetch the source bytes, `uploadAttachment` then `attachToWorkItem`, **where the source + scope allow** (CSV carries none; private-source attachments need the connector's auth scope).                                                                                                                                                                                           | Uploader is the importing user.                                                                                                                                                                                                                                                                                    |
| **links / parent** | parent edge + Motir links | `parent` → the work-item parent edge (validated per the matrix, **2nd pass** — create all items, then link parents, since a parent may be imported after its child). Issue links → Motir relationship links (`CreateWorkItemLinkInput`).                                                                                                                                         | Parent 2nd-pass is MOTIR-941's persist contract.                                                                                                                                                                                                                                                                   |
| **history**        | timestamps / activity     | Import as available — **at minimum created/closed timestamps**; richer history where the source exposes it.                                                                                                                                                                                                                                                                      | Where a first-class field can't hold it, capture in the imported activity / first comment.                                                                                                                                                                                                                         |

**Per-source field availability** (the mapping degrades gracefully — not every source has every field):

| Field               | Jira    | Linear          | GitHub Issues          | CSV             |
| ------------------- | ------- | --------------- | ---------------------- | --------------- |
| type / kind         | ✅      | ✅ (team/label) | ⚠️ label-derived       | ⚠️ column-dep   |
| status              | ✅      | ✅              | ✅ (open/closed + lbl) | ⚠️ column-dep   |
| priority            | ✅      | ✅              | ⚠️ label-derived       | ⚠️ column-dep   |
| assignee / reporter | ✅ / ✅ | ✅ / ⚠️         | ✅ / ✅ (author)       | ⚠️ column-dep   |
| labels              | ✅      | ✅              | ✅                     | ⚠️ column-dep   |
| comments            | ✅      | ✅              | ✅                     | ❌              |
| attachments         | ✅      | ✅              | ✅                     | ❌              |
| links / parent      | ✅      | ✅ (parent)     | ⚠️ task-list/refs      | ⚠️ id column    |
| history             | ✅      | ✅              | ⚠️ (events API)        | ⚠️ created only |

CSV carries **only what its columns provide**; the resolver treats a missing column as "unmapped," never as an error.

**Unmatched-value policy (uniform):** an unmatched **status**, **user** (assignee/reporter), or **label** is surfaced as a **choice** in the wizard's mapping step — map to an existing value, create/invite, or fall to a chosen default — and **never silently dropped**. This is the same shape across all three.

### 3 · Idempotent re-run — the explicit external-id map

Every imported issue carries its source's **stable id** (Jira `PROJ-123`, Linear identifier, GitHub `owner/repo#42`, a CSV id column). The importer persists an explicit map:

```
(import_source, external_id) → work_item_id
```

owned by the **`Import` model + external-id map (MOTIR-939)**. A re-run resolves each incoming `SourceIssue` through this map and **UPSERTs**: a hit → UPDATE the mapped work item; a miss → CREATE and record the new mapping. Re-import therefore never duplicates.

**We adopt the EXPLICIT mapping-table shape, not a per-project custom field.** Verified precedent: Jira's CSV / external-system import records the source id in an **"External issue ID"** field and **skips rows whose external id already exists** (Atlassian: _"Issues with an Issue ID that duplicates an existing External Issue ID value won't be imported"_). We adopt the _idempotency behaviour_ but the _explicit table_ over Jira's custom-field mechanism, because Atlassian documents that its custom-field-based check is **inconsistent across projects in Cloud** (it reliably fires only in the project where the field was first auto-created) — an owned join table has no such gap and keeps the source id out of user-visible custom fields.

**Update policy on re-run (field ownership):**

| Class                                        | On re-run                        | Fields                                                                                                                             |
| -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Source-owned** — re-synced from the source | overwrite with the current value | title, description, status, priority, assignee/reporter (re-resolved), source labels, source comments (append new; do not delete)  |
| **Motir-local** — never clobbered            | preserved as-is                  | comments authored in Motir, links / re-parenting done in Motir, custom-field values set in Motir, local sprint/estimate assignment |

Default rule, stated once: **re-sync source-owned fields; do not clobber Motir-local-only changes.** A field edited in both is source-owned → the source wins (import is a sync of source-owned state); Motir-only additions are additive and survive.

### 4 · The dry-run — preview is the run minus the writes

Every import is **PREVIEWED before it writes**. The importer computes, per issue, a plan row: **CREATE / UPDATE / SKIP** + the fully-resolved mapping + any warnings (unmatched status/user/label, illegal parent to be legalised, missing source field) — **without touching the PM core**. The user reviews and confirms; only then does the persist engine run.

**The dry-run shares the SAME mapping engine as the real run** — the preview _is_ the run with the write calls elided (classify-only, no `workItemsService` writes), not a separate estimator that could diverge. This is enforced structurally: MOTIR-1504's resolver produces the classified plan; MOTIR-941's persist engine consumes the identical resolution to write. The classify path (MOTIR-1504) performs no writes.

Verified precedent: **Plane's Jira importer** ends its wizard on a **"Review the mappings … Click Back to adjust, or click Confirm to start the migration"** gate — the confirm sits after all mapping steps and before any migration write. (Whether Plane also shows numeric per-status counts on that screen is an _assumption-to-verify_; the mapping-review-then-confirm gate itself is verified — see References.)

---

## Consequences

### Required extensions to the shipped write authority (surfaced to the code cards — NOT built here)

These are the rung-2 gaps this decision found; each is an extension **of** an Epic-2 service, not a bypass **around** it:

1. **Status on import** (MOTIR-941 + `workflowsService`): the mapped status is applied via the **workflow transition path**, not a free-form field. Because an import is an authoritative bulk/system operation (all three mirror products place the imported issue directly in its mapped status), the persist card must apply the target status through an import/system context that respects the project's `WorkflowStatus` set. **This MUST reach any status, including a done-category one** — closed/done source issues are in scope (see the whole-history scope in Context), so the import path cannot be limited to open statuses or to walking only the interactive `restricted`-policy legal edges from `isInitial`. Record whether the existing `updateStatus` admits a system-context direct set to an arbitrary project status, or whether a thin import-scoped status-set method is added — either way inside `workflowsService`, honouring the project's status keys.
2. **Reporter preservation** (MOTIR-941 + `workItemsService`): `createWorkItem` currently forces `reporterId = ctx.userId`. To preserve the source reporter, extend the create surface with an **optional, import-context-only `reporterId`** (email-matched member); unmatched → importing user + original captured in history. If the extension is descoped, the degraded behaviour (importing user as reporter, original in the first comment) is the recorded fallback.
3. **Comment author + timestamp** (MOTIR-941 + `commentsService`): `addComment` hardcodes `authorId`/`createdAt`. To preserve source comment authorship, add an **import-scoped create path** accepting a resolved `authorId` (email-matched) + the source `createdAt`. Degraded fallback = importing user + an in-body "originally by X on DATE" attribution line.

None of these introduce a write path around `workItemsService` / its sibling entity services; they extend those same services under an import context. Every persisted work item still flows through `workItemsService`.

### What each consumer card builds

- **MOTIR-939** — the `Import` row (source, config, mapping, status) + the `(import_source, external_id) → work_item_id` map; schema + migration.
- **MOTIR-1501** — `IssueSourceConnector` interface + normalised `SourceIssue` + CSV parse + GitHub Issues connector (paginate + retry scaffolding).
- **MOTIR-940** — Jira + Linear connectors: paginated fetch + field-mapping into `SourceIssue`.
- **MOTIR-1504** — mapping resolver + idempotency lookup + dry-run classify (no writes).
- **MOTIR-941** — persist engine (batched tx, parent 2nd pass, the three extensions above) + import API routes.
- **MOTIR-942** — the wizard UI (connect → map → dry-run preview → run → progress); **MOTIR-937** is its design.
- **MOTIR-943** — provisions the Jira / Linear / GitHub OAuth apps / tokens.
- **MOTIR-944 / MOTIR-945** — vitest (mapping correctness + idempotency no-dupe + dry-run) and Playwright E2E (import a Jira export + a CSV → mapped work items; re-run doesn't dupe).

### Assumptions to verify (flagged per the "cite verified or flag" rule)

- **A-1:** Plane's confirm screen shows numeric per-status/issue counts (the mapping-review-then-confirm _gate_ is verified; the numeric-count detail is not). Impact: cosmetic — our dry-run shows counts regardless.
- **A-2:** The exact Jira skip log wording _"External issue N already exists as PROJ-1, not importing"_ (the skip _behaviour_ is verified; the precise string is not). Impact: none — we own our external-id table and its messaging.

---

## References

**Verified mirrors**

- Plane Jira importer — mapping-review → Confirm gate before migration: <https://docs.plane.so/importers/jira> (VERIFIED: confirm gate; A-1 count detail unverified).
- Linear multi-source model — `Importer` interface + shared `ImportResult`, one implementation per source: <https://github.com/linear/linear/tree/master/packages/import/src/importers> and <https://github.com/linear/linear/blob/master/packages/import/src/types.ts> (VERIFIED).
- Atlassian external-id idempotent skip — "External issue ID" + skip-existing: <https://confluence.atlassian.com/adminjiraserver/importing-data-from-csv-938847533.html> and <https://support.atlassian.com/jira/kb/csv-import-error-issues-have-been-skipped-because-they-already-exist-in-destination-projects/>; Cloud inconsistency caveat noted; context ticket <https://jira.atlassian.com/browse/JRASERVER-64477> (behaviour VERIFIED; A-2 exact-string unverified).
- Pagination — GitHub REST issues (`per_page`/`page`): <https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28>; Jira search (`startAt`/`maxResults`): <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/>; Linear GraphQL (`first`/`after` cursor): <https://linear.app/developers/pagination> (all VERIFIED).

**Shipped code (rung 2 — grounding facts)**

- `lib/services/workItemsService.ts` — `createWorkItem` / `updateWorkItem` (reporter forced to `ctx.userId`; status not settable).
- `lib/dto/workItems.ts` — `CreateWorkItemInput` / `UpdateWorkItemInput` (`:695–855`); `WorkItemPriorityDto` (`:20`, no `none`).
- `prisma/sql/work_item_triggers.sql` + `lib/issues/parentRules.ts` — kind-parent matrix, depth 4.
- `lib/workflows/defaultWorkflow.ts`, `lib/services/workflowsService.ts`, `WorkflowStatus` (`prisma/schema.prisma`) — per-project statuses, gated transitions.
- `lib/services/commentsService.ts` (`addComment` author/timestamp), `lib/services/labelsService.ts` (`setLabels`), `lib/services/attachmentsService.ts` (`uploadAttachment`).
- `GithubIdentity.accessTokenEncrypted` + `lib/github/tokenCrypto.ts` — reusable GitHub OAuth token substrate.

**Authority ladder** — `motir-meta/prompts/plan-rules.md` (mirror → shipped code → card). Card-vs-code contradictions resolved here: priority `none` → `medium`; reporter/status/comment-author preservation via in-authority extensions.
