# ADR: The issue importer — sources, field mapping, idempotent re-run, and dry-run

- **Status:** Accepted (2026-07-05) — drafted by the planner from the decision-authority ladder (mirror products → shipped code → card) and the verified mirrors below; ratified on PR merge. **Amended (2026-07-06, MOTIR-1657): live-source auth is now OAuth "Connect" ONLY — the paste-a-token / PAT alternative is removed for live sources (see §1 · Live-source authentication).**
- **Story / Subtask:** 7.16 · Issue importer (MOTIR-816) · Subtask 7.16.2 (MOTIR-938); auth amendment 7.16.14 (MOTIR-1657)
- **Supersedes / superseded by:** none. (Supersedes the archived exploratory Story 7.17 / MOTIR-627, which this journey-ordered 7.16 tree replaced.)
- **Consumed by:** MOTIR-937 (7.16.1 wizard design), MOTIR-939 (7.16.3 `Import` model + external-id map + migration), MOTIR-1501 (7.16.4a connector interface + `SourceIssue` + CSV + GitHub), MOTIR-940 (7.16.4 Jira + Linear connectors), MOTIR-1639 (7.16.4b Plane connector), MOTIR-1504 (7.16.5a mapping resolver + idempotency lookup + dry-run classify), MOTIR-941 (7.16.5 persist engine + import routes), MOTIR-942 (7.16.6 wizard UI), MOTIR-943 (7.16.7 Jira OAuth app registration; per-vendor siblings 7.16.7a/7.16.7b for Linear / Plane), MOTIR-1653 (7.16.10 `ImportSourceIdentity` token store), MOTIR-1654 (7.16.11 Jira OAuth connect flow), MOTIR-1655 (7.16.12 Linear OAuth connect flow), MOTIR-1656 (7.16.13 Plane OAuth connect flow), MOTIR-944 (7.16.8 vitest), MOTIR-945 (7.16.9 Playwright E2E).

> This record follows the house ADR convention set by `docs/decisions/work-item-type-taxonomy.md`: a markdown file under `docs/decisions/`, named for the thing it fixes, structured **Status → Context → Decision → Consequences → References**, with the load-bearing facts pinned in explicit tables. It is the durable SHAPE of the importer, fixed BEFORE the code cards build it (the no-shortcuts rule — pick the durable shape, not the demoable happy path).

---

## Context

Journey A ("onboard an existing project") needs to pull an existing project's **entire issue history** from another tracker into Motir work items. The sources are **Jira, Linear, GitHub Issues, and Plane** (live REST/GraphQL) and **CSV** (uploaded-file parse — the universal, credential-free fallback). Every imported issue must land as a first-class Motir work item through the **Epic-2 write authority** (`lib/services/workItemsService.ts`), honouring the same grammar (kind-parent matrix, per-project workflow statuses, priority scale, links) that the rest of the app enforces — an import is not a side-door around the schema.

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
| Import-source token substrate     | `ImportSourceIdentity` (per-user, per-vendor encrypted OAuth token — MOTIR-1653, shipped; mirrors the `GithubIdentity` crypto)                  | The OAuth-connect token store for Jira / Linear / Plane — the SOLE source of a live-source token (no paste-a-token path). See §1 auth.   |

There is **no existing importer, `Import` model, or external-id map** in the repo today (only the `app/(onboarding)/onboarding/import` "coming soon" placeholder) — the importer is greenfield, so this decision is unconstrained by legacy import code.

---

## Decision

### 1 · Sources + the connector interface

The connector layer is an **interface, not a per-source wizard branch**. A further source (a sixth, a seventh) is a new connector class, not a change to the mapping/preview/persist pipeline — Plane, added to the original four, is exactly this: a new implementation, no pipeline change.

```ts
interface IssueSourceConnector {
  readonly source: 'jira' | 'linear' | 'github' | 'plane' | 'csv';
  // Pages the source and YIELDS normalised issues — never returns "all at once".
  fetchIssues(cfg, cursor?): AsyncIterable<SourceIssue>; // or a paged { issues, nextCursor }
}
```

Every connector normalises its source into ONE internal shape — the **normalised `SourceIssue`** (MOTIR-1501 owns the type) — before any mapping runs. The mapping/dry-run/persist stages are **source-agnostic**: they see only `SourceIssue`, never a Jira/Linear/GitHub/Plane payload. This is the **verified Linear precedent** (`packages/import`): a single `Importer` interface + a shared `ImportResult` normalised model, with one implementation per source (`jiraCsv`, `github`, `trelloJson`, …).

| Source            | Access shape          | Pagination (VERIFIED — a paging loop is mandatory)                                          | Credentials                                                                                  |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Jira**          | REST issue search     | `startAt` + `maxResults` offset paging (default page 50) — loop incrementing `startAt`      | **OAuth "Connect" ONLY** — per-user token via `ImportSourceIdentity` (MOTIR-1654)            |
| **Linear**        | GraphQL               | Relay cursor paging: `first` + `after`; page until `pageInfo.hasNextPage` is false (def 50) | **OAuth "Connect" ONLY** — per-user token via `ImportSourceIdentity` (MOTIR-1655)            |
| **GitHub Issues** | REST list-repo-issues | `per_page` (max 100) + `page`, Link headers                                                 | **OAuth ONLY** — reuse `GithubIdentity.accessTokenEncrypted` (per-user, 7.10 App)            |
| **Plane**         | REST work-items       | Cursor paging: `per_page` (≤100) + `cursor`; loop while `next_page_results`                 | **OAuth "Connect" ONLY** — per-user token via `ImportSourceIdentity` + base URL (MOTIR-1656) |
| **CSV**           | Uploaded-file parse   | n/a (whole file, streamed rows)                                                             | **none** — the universal, credential-free fallback                                           |

Connectors carry paginate + retry scaffolding (MOTIR-1501); Jira + Linear live-field-mapping into `SourceIssue` is MOTIR-940; the **Plane** connector is MOTIR-1639; the interface + `SourceIssue` + CSV + GitHub connector is MOTIR-1501.

**How the data actually leaves each source — a LIVE API is the primary path, a FILE EXPORT is the credential-free alternative.** Every live source has a first-class read API we connect to directly; every source that can produce a file export routes that export through the ONE CSV/file connector — so a user who can't or won't grant API access can still import. The two paths converge on the same `SourceIssue` and the same mapping/dry-run/persist pipeline.

| Source     | Live API (primary connector)                        | Auth                                                            | File export → CSV connector                                                 |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Jira**   | REST issue-search (JQL), offset-paginated           | OAuth 2.0 (3LO) "Connect" ONLY (MOTIR-1654)                     | ✅ Jira's native CSV export (Issues → Export → CSV)                         |
| **Linear** | GraphQL `issues` query, cursor-paginated            | OAuth 2.0 "Connect" ONLY (MOTIR-1655)                           | ✅ Linear's CSV export                                                      |
| **GitHub** | REST list-repo-issues (`state=all`), page-paginated | OAuth ONLY — reuse `GithubIdentity` (7.10 App)                  | ⚠️ no first-party issues CSV export — API is the path (or a hand-built CSV) |
| **Plane**  | REST work-items API, cursor-paginated               | OAuth "Connect" ONLY + base URL (Cloud/self-hosted, MOTIR-1656) | ✅ Plane's CSV/Excel export (Workspace Settings → Exports, admin)           |
| **CSV**    | — (this IS the file path)                           | **none**                                                        | ✅ the universal target: any of the above exports, or a hand-made sheet     |

**Deliberate altitude:** this ADR fixes the access _model_ per source (API type, auth model, pagination, the export alternative) — it does NOT pin exact endpoint URLs, OAuth scopes, or the JQL string. Those are connector-implementation detail owned by **MOTIR-940** (Jira + Linear), **MOTIR-1639** (Plane), **MOTIR-1501** (GitHub + CSV), **MOTIR-1654 / MOTIR-1655 / MOTIR-1656** (the per-vendor OAuth connect flows), and **MOTIR-943** + siblings (per-vendor OAuth-app registration), which read the vendor's _current_ API docs at build time — deliberately, because vendor endpoints move (e.g. Jira Cloud is mid-migration from `/rest/api/3/search` to a token-paginated `/search/jql`, and Plane has deprecated `/issues/` in favour of `/work-items/`), and a durable decision doc must not hard-code a moving endpoint.

#### Live-source authentication — OAuth "Connect" is the SOLE path (amended 2026-07-06, MOTIR-1657)

**Every LIVE source authenticates through an OAuth "Connect" flow, and ONLY that. There is NO "paste an API token / personal access token into the wizard" alternative for a live source.** The connectors stay **auth-agnostic** — a connector consumes a bearer/token string and does not care where it came from — but that string now originates from exactly ONE place: the per-user OAuth token store. CSV is unchanged: a file upload, credential-free.

| Live source | Connect mechanism                                                               | Token store                                   | Owning card          |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------- | -------------------- |
| **GitHub**  | Reuse the shipped **7.10 GitHub App** + per-user OAuth grant (`GithubIdentity`) | `GithubIdentity.accessTokenEncrypted`         | 7.10 / existing      |
| **Jira**    | Per-vendor OAuth 2.0 (3LO) "Connect" flow                                       | `ImportSourceIdentity` (per-user, per-vendor) | 7.16.11 (MOTIR-1654) |
| **Linear**  | Per-vendor OAuth "Connect" flow                                                 | `ImportSourceIdentity`                        | 7.16.12 (MOTIR-1655) |
| **Plane**   | Per-vendor OAuth "Connect" flow (+ self-hosted base URL captured alongside)     | `ImportSourceIdentity`                        | 7.16.13 (MOTIR-1656) |
| **CSV**     | — (file upload, no auth)                                                        | —                                             | —                    |

The per-vendor token substrate is **`ImportSourceIdentity`** (MOTIR-1653, shipped) — a per-user, per-vendor encrypted token row mirroring the `GithubIdentity` crypto. Each vendor's connect flow (`start` → vendor consent → `callback`) writes the granted token there; the connector reads it at run time. GitHub is the one live source that does NOT use `ImportSourceIdentity` — it reuses the already-shipped `GithubIdentity` grant from the 7.10 GitHub App, so a project that already connected GitHub needs no second connect.

**Provisioning (env vars + redirect URLs).** Each vendor OAuth app is registered per-vendor (7.16.7 / 7.16.7a / 7.16.7b — `manual`/human provisioning cards) and its client credentials live in the secret store / env, NEVER the repo:

| Vendor | Client-id env var        | Client-secret env var        | OAuth redirect / callback URL                        |
| ------ | ------------------------ | ---------------------------- | ---------------------------------------------------- |
| Jira   | `JIRA_OAUTH_CLIENT_ID`   | `JIRA_OAUTH_CLIENT_SECRET`   | `{BETTER_AUTH_URL}/api/import/jira/oauth/callback`   |
| Linear | `LINEAR_OAUTH_CLIENT_ID` | `LINEAR_OAUTH_CLIENT_SECRET` | `{BETTER_AUTH_URL}/api/import/linear/oauth/callback` |
| Plane  | `PLANE_OAUTH_CLIENT_ID`  | `PLANE_OAUTH_CLIENT_SECRET`  | `{BETTER_AUTH_URL}/api/import/plane/oauth/callback`  |

The connect-flow start route is the symmetric `/api/import/<vendor>/oauth/start`. (GitHub reuses the 7.10 App's existing OAuth app + callback — no new env var / redirect for import.)

**Rationale — why no paste-a-token path (Yue, 2026-07-06).** Asking a non-technical user to find, scope, and paste a personal access token is bad UX: it pushes vendor-console spelunking onto the user, invites over-broad or mis-scoped tokens, and stores a long-lived secret the user has to rotate by hand. A "Connect" button is the shape every mirror product uses (and the shape Motir already ships for GitHub) — one click, vendor-hosted consent, a scoped token Motir holds and can refresh. Keeping a paste-a-token fallback would mean maintaining, testing, and securing two auth paths per vendor for the worse one, and would leak a raw-token input field into a wizard aimed at non-technical users. So the paste-a-token path is removed, not merely de-emphasised — one auth path per live source, and it is OAuth "Connect".

**Every connector fetches ALL states (open + closed/done), per the whole-history scope above.** No connector applies an open-only filter. Concretely: **GitHub** must pass `state=all` (its list-issues API defaults to `state=open` — omitting this silently drops closed issues); **Jira** uses a JQL with no `status`/`resolution` clause (an unfiltered JQL returns every state, resolved and unresolved); **Linear** fetches without a state filter (all workflow states, including completed/cancelled); **Plane** fetches every state GROUP (`backlog`/`unstarted`/`started`/`completed`/`cancelled`) — `completed`/`cancelled` are done-category; **CSV** carries whatever rows the export contains. A closed source issue therefore reaches the resolver with its real closed status, which maps to a done-category `workflow_status` (§2, status).

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

| Field               | Jira    | Linear          | GitHub Issues          | Plane                   | CSV             |
| ------------------- | ------- | --------------- | ---------------------- | ----------------------- | --------------- |
| type / kind         | ✅      | ✅ (team/label) | ⚠️ label-derived       | ⚠️ label/module-derived | ⚠️ column-dep   |
| status              | ✅      | ✅              | ✅ (open/closed + lbl) | ✅ (5 state groups)     | ⚠️ column-dep   |
| priority            | ✅      | ✅              | ⚠️ label-derived       | ✅ (urgent…none)        | ⚠️ column-dep   |
| assignee / reporter | ✅ / ✅ | ✅ / ⚠️         | ✅ / ✅ (author)       | ✅ / ⚠️ (created_by)    | ⚠️ column-dep   |
| labels              | ✅      | ✅              | ✅                     | ✅                      | ⚠️ column-dep   |
| comments            | ✅      | ✅              | ✅                     | ✅                      | ❌              |
| attachments         | ✅      | ✅              | ✅                     | ✅                      | ❌              |
| links / parent      | ✅      | ✅ (parent)     | ⚠️ task-list/refs      | ✅ (sub-issues)         | ⚠️ id column    |
| history             | ✅      | ✅              | ⚠️ (events API)        | ⚠️ created/updated      | ⚠️ created only |

CSV carries **only what its columns provide**; the resolver treats a missing column as "unmapped," never as an error.

**Unmatched-value policy (uniform):** an unmatched **status**, **user** (assignee/reporter), or **label** is surfaced as a **choice** in the wizard's mapping step — map to an existing value, create/invite, or fall to a chosen default — and **never silently dropped**. This is the same shape across all three.

### 3 · Idempotent re-run — the explicit external-id map

**Lifecycle: a one-shot MIGRATION that is re-runnable on demand — NOT a continuous/live sync, and one-directional (source → Motir, never write-back).** The import is a discrete run (connect → map → dry-run → confirm → execute), even when connected over a live API — the API is queried per-run, not held open to stream changes. There is **no background polling, no webhook-driven mirroring, and no bidirectional sync**: Motir is the destination the project is _moving into_, not a mirror kept in lockstep with the old tracker. This matches every mirror (Linear's `packages/import`, Plane's importer, Jira's CSV import are all one-time migrations, not daemons). What idempotency buys is a safe **manual catch-up**: the user can re-run the same import later — the external-id map below means a re-run UPSERTs (picks up issues created since, re-syncs changed source-owned fields, preserves Motir-local edits per the update policy) instead of duplicating. **Continuous live/two-way sync is explicitly OUT OF SCOPE** here — it is a materially larger, separate capability (webhooks, conflict resolution, field-level ownership, write-back) that would be its own story, not a mode of this importer; we do not half-build it.

Every imported issue carries its source's **stable id** (Jira `PROJ-123`, Linear identifier, GitHub `owner/repo#42`, the Plane work-item **UUID** `id` — not its renameable `{project}-{sequence_id}` display ref, a CSV id column). The importer persists an explicit map:

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
- **MOTIR-1639** — Plane connector: paginated `work-items` REST fetch (reads its per-user token from `ImportSourceIdentity` + the captured base URL) + field-mapping into `SourceIssue`.
- **MOTIR-1504** — mapping resolver + idempotency lookup + dry-run classify (no writes).
- **MOTIR-941** — persist engine (batched tx, parent 2nd pass, the three extensions above) + import API routes.
- **MOTIR-942** — the wizard UI (connect → map → dry-run preview → run → progress); the Connect step launches the per-vendor OAuth flow and shows connected/not-connected — NO token/PAT input field. **MOTIR-937** is its design.
- **MOTIR-1653** — `ImportSourceIdentity` (per-user, per-vendor encrypted OAuth token store) + migration — the SOLE token substrate for Jira / Linear / Plane. (Shipped.)
- **MOTIR-1654 / MOTIR-1655 / MOTIR-1656** — the Jira / Linear / Plane OAuth "Connect" flows (`/api/import/<vendor>/oauth/start` + `/callback`) that grant + store the token in `ImportSourceIdentity`.
- **MOTIR-943** (+ per-vendor siblings 7.16.7a / 7.16.7b) — registers the Jira / Linear / Plane OAuth apps and records `{JIRA,LINEAR,PLANE}_OAUTH_CLIENT_ID` / `_SECRET` + the `/api/import/<vendor>/oauth/callback` redirect in the secret store. GitHub reuses the 7.10 App. **No API-token / PAT provisioning** — OAuth apps only.
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
- Pagination — GitHub REST issues (`per_page`/`page`): <https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28>; Jira search (`startAt`/`maxResults`): <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/>; Linear GraphQL (`first`/`after` cursor): <https://linear.app/developers/pagination>; Plane REST work-items (`X-API-Key`, cursor `per_page`/`cursor`, `/work-items/` supersedes deprecated `/issues/`): <https://developers.plane.so/api-reference/introduction> (all VERIFIED).

**Shipped code (rung 2 — grounding facts)**

- `lib/services/workItemsService.ts` — `createWorkItem` / `updateWorkItem` (reporter forced to `ctx.userId`; status not settable).
- `lib/dto/workItems.ts` — `CreateWorkItemInput` / `UpdateWorkItemInput` (`:695–855`); `WorkItemPriorityDto` (`:20`, no `none`).
- `prisma/sql/work_item_triggers.sql` + `lib/issues/parentRules.ts` — kind-parent matrix, depth 4.
- `lib/workflows/defaultWorkflow.ts`, `lib/services/workflowsService.ts`, `WorkflowStatus` (`prisma/schema.prisma`) — per-project statuses, gated transitions.
- `lib/services/commentsService.ts` (`addComment` author/timestamp), `lib/services/labelsService.ts` (`setLabels`), `lib/services/attachmentsService.ts` (`uploadAttachment`).
- `GithubIdentity.accessTokenEncrypted` + `lib/github/tokenCrypto.ts` — reusable GitHub OAuth token substrate.
- `ImportSourceIdentity` (per-user, per-vendor encrypted OAuth token store — MOTIR-1653, shipped) — the SOLE live-source token substrate for Jira / Linear / Plane (mirrors the `GithubIdentity` crypto).

**Authority ladder** — `motir-meta/prompts/plan-rules.md` (mirror → shipped code → card). Card-vs-code contradictions resolved here: priority `none` → `medium`; reporter/status/comment-author preservation via in-authority extensions.
