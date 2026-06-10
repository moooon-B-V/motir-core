import type { PlanStory } from '../types';

/**
 * Story 5.1 — Comments + @mentions.
 *
 * The first Epic-5 story: comments on issues (the "team workspace" layer) with
 * @mentions that resolve to workspace members and drive notifications through
 * the Story 1.6 job infrastructure. It fills the **Activity placeholder the
 * detail page has carried since 2.4** (`detail.pen`'s "Section · Activity
 * (placeholder)" — literally captioned "Comments coming in Epic 5").
 *
 * 📦 Lives in Epic 5 (Collaboration & fields). Every dependency points backward
 * (Epics 1/2 + the already-shipped 6.4 roles), so the cross-epic audit
 * (`notes.html` mistake #32) is clean: no forward-pointing dep.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10, not asserted from memory):
 *   • **Threaded, one level deep.** The archive's epic prose left
 *     "threading-or-flat (decide at expansion)" open. Jira Cloud rolled out
 *     comment replies to ALL users (GA ~April 2025; JRACLOUD-3406 closed as
 *     done): replies are single-level child comments, the reply affordance on a
 *     child attaches to the same thread and auto-tags that child's author, and
 *     long threads collapse their middle ("Show more replies"). So the decision
 *     is **single-level threading** — `comment.parentCommentId`, replies never
 *     nest further.
 *   • **Ordering** — oldest-first by default with a per-user newest/oldest
 *     toggle (Jira: `jira.workitem.actions.order` default `asc` + the per-user
 *     "Reverse sort direction" control).
 *   • **Scale (finding #57)** — Jira's issue view loads only the newest
 *     comments and hides the rest behind "Show more comments"
 *     (JRACLOUD-76318/94212). A detail page that loads every comment row is the
 *     prototype tell; 5.1 ships a cursor-paged read + "Show more comments".
 *   • **Permissions** — Jira's permission-scheme set is Add / Edit own / Edit
 *     all / Delete own / Delete all comments. Mapped onto the shipped 6.4 role
 *     model (rung 2 — enforced reality): admin/member who can view the project
 *     may add; the author edits/deletes their own; project `admin` (and
 *     workspace admin/owner) edits/deletes all; the read-only `viewer` role
 *     cannot comment.
 *   • **Edit/delete semantics** — an edited comment shows an "Edited" tag
 *     (latest version only, no native edit history); delete is a **hard
 *     delete** (no tombstone) with the History trail recording only THAT a
 *     comment was deleted and by whom — 5.1 writes that `work_item_revision`
 *     row, which Story 5.5 renders.
 *   • **Mentions** — @ in the editor opens a member picker; the mentioned user
 *     is notified (email + in-app in Jira) ONLY if they can view the issue;
 *     mentions work in the description too, not just comments.
 *
 * ⚠️ Design gate (planning-time). `detail.pen` draws ONLY the Activity
 * placeholder ("Activity" / "Comments coming in Epic 5") — the comment thread,
 * composer, mention popup, edited/deleted states, sort toggle, and "Show more"
 * affordances are **whole elements no design specifies** == NO design exists.
 * So subtask **5.1.3** is a `type: design` subtask producing
 * `design/work-items/comments.mock.html` + design-notes, and EVERY UI-touching
 * code subtask (5.1.4 mention editor surface, 5.1.5 comments section) carries
 * 5.1.3 in `dependsOn` and is seeded `status: 'blocked'` (Principle #13).
 *
 * Notification split (kept honest at plan time): 5.1 ships the **email**
 * notification hook via the Story 1.6 job pipeline (the stub's scope). Jira
 * also notifies mentions **in-app** — that surface (the bell + unread feed) is
 * owned by NO story today, which is a planning bug under the no-V1-tier rule,
 * so this same planning PR adds the **Story 5.7 stub** (in-app notification
 * center) to `stubs.ts`. 5.1.6's job event payload is deliberately
 * channel-agnostic so 5.7 (in-app) and 5.4 (watchers) fan in off the same
 * events without reshaping them.
 *
 * Out-of-scope justifications (justified-deviation rule, recorded inline):
 * per-comment visibility restriction (Jira's padlock) needs the role/group
 * taxonomy of company-managed permission schemes — Jira's team-managed
 * projects (the small-team shape Prodect targets) do NOT support it; documented
 * extension slot for Epic 6 admin. Realtime/live comment updates: the codebase
 * is Server Components + Server Actions with no realtime substrate; comments
 * refresh on navigation/action like every other surface — a realtime channel
 * is a product-wide decision, not something to improvise inside one story.
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.1`. Matches the
 * canonical depth + string-literal style of Stories 4.5 / 4.6 / 4.7.
 */
export const story_5_1: PlanStory = {
  id: '5.1',
  title: 'Comments + @mentions',
  status: 'planned',
  descriptionMd:
    'Comments turn an issue from a record into a conversation — the first Epic-5 collaboration ' +
    'surface, and the one the detail page has reserved a slot for since Story 2.4 (the Activity ' +
    'placeholder: "Comments coming in Epic 5"). This story ships the comment model + service, the ' +
    'thread UI in that slot, **@mentions** over workspace members in the rich-text editor (comments ' +
    'AND description — Jira-faithful), and the mention → **email notification** hook through the ' +
    'Story 1.6 job pipeline.\n\n' +
    '**The Jira-verified shape (decision-ladder rung 1, checked against Atlassian sources at plan ' +
    'time — not memory).** Comments are **threaded, one level deep**: Jira Cloud GA-ed comment ' +
    'replies (~April 2025) as single-level child comments — a reply to a reply attaches to the same ' +
    "thread (and pre-fills an @mention of that reply's author, Jira's auto-tag behaviour); threads " +
    'never nest deeper. Ordering is **oldest-first by default with a per-user newest/oldest ' +
    'toggle**. An edited comment carries an **"Edited" tag** (only the latest version is kept — ' +
    'no edit history). Delete is a **hard delete** — no tombstone, no content retention; what ' +
    'remains is a `work_item_revision` row recording that a comment was deleted and by whom (the ' +
    "History trace Story 5.5's activity feed renders). Permissions map Jira's five comment " +
    'permissions (Add / Edit own / Edit all / Delete own / Delete all) onto the shipped 6.4 role ' +
    'model: project `admin`/`member` (who can view the project) add comments; authors edit/delete ' +
    'their own; project `admin` + workspace admin/owner edit/delete any; the read-only `viewer` ' +
    'role cannot comment (rung 2 — the shipped viewer contract is read-only).\n\n' +
    '**Mentions.** Typing `@` in the editor opens a member picker (the Combobox option-row ' +
    'vocabulary) over the members who can VIEW the issue — for open/limited projects the workspace ' +
    'membership, for private projects the project members (exactly the 6.4 ' +
    '`assignableMembersService` scoping; mention candidates reuse that read). Mentions serialize ' +
    'into the stored Markdown as a durable token — `[@Display Name](mention:<userId>)` — so the ' +
    'body stays plain Markdown (rung: one storage format, no parallel rich-text blob), renders as ' +
    'a user chip in `MarkdownView`, and is parseable server-side. The **service** is the authority ' +
    'on mentions: on every comment write it parses the body, validates each mentioned user is a ' +
    'workspace member who can view the issue (silently dropping the rest — the Jira rule: no ' +
    'view permission → no notification), and persists `comment_mention` rows in the same ' +
    'transaction — the queryable substrate ("comments mentioning me") Epic 6 search can filter on. ' +
    'Because the mention capability lives in the shared `MarkdownEditor` primitive (2.3.5), the ' +
    '**description field gets mentions for free** — and description-mention notifications ride the ' +
    'same parse helper on the work-item write path (Jira notifies description mentions too).\n\n' +
    '**Notifications (email here; in-app is Story 5.7).** Comment writes emit a channel-agnostic ' +
    'job event after the transaction commits (`work-item/comment.created` carrying workspace, ' +
    'issue, comment, author, and the mentioned-user ids; the description path emits ' +
    '`work-item/mentioned`). An Inngest job (the 1.6 `defineJob` harness) fans out **mention ' +
    'emails** via the shipped email pipeline: per mentioned user — never the author themselves — ' +
    'it re-validates view access at send time, renders a `mentionNotification` template (who ' +
    'mentioned you, the issue identifier + title, a plain-text excerpt, a deep link), and sends ' +
    'idempotently (one notification per comment × user, replay-safe). The event payload is shaped ' +
    'so Story 5.4 (watcher notifications) and Story 5.7 (the in-app bell) consume the SAME events ' +
    'later without reshaping.\n\n' +
    '**Scale (finding #57 — never load-all).** A years-old issue can hold hundreds of comments; ' +
    'Jira\'s issue view loads only the newest few and hides the rest behind **"Show more ' +
    'comments\"**. The list read is **cursor-paginated from the most recent** (page size 20) with ' +
    'a total count; the UI renders the newest page in the active sort direction plus a "Show more ' +
    'comments (N older)" affordance that extends backward — never a fetch-everything read. ' +
    'Replies load with their thread; long threads collapse their middle behind "Show more ' +
    'replies" (the Jira auto-collapse).\n\n' +
    '**Completeness — the real-product states.** Empty (no comments yet — an inviting, non-blank ' +
    'state), loading (skeleton rows in the Activity slot), error (`ErrorState` + retry), the ' +
    'composer\'s submitting/disabled states, the "Edited" tag, the delete confirm (naming the ' +
    'reply count when deleting a thread root — deleting a root deletes its replies, a deliberate ' +
    'decision recorded in 5.1.2 since the mirror behaviour is unverifiable), the viewer ' +
    '(read-only) state — thread visible, no composer — and a deleted/permission-denied mention ' +
    'target degrading gracefully. All drawn by 5.1.3, asserted in 5.1.7.\n\n' +
    '**Out of scope (documented extension slots, each justified):** per-comment **visibility ' +
    "restriction** (Jira's padlock — needs the company-managed role/group substrate; Jira's " +
    'team-managed projects, the shape Prodect mirrors for small teams, do not support it; Epic-6 ' +
    'admin territory); **realtime** live-updating comments (no realtime substrate in the codebase; ' +
    'a product-wide decision, not a story-local improvisation); the **in-app notification center** ' +
    '(Story 5.7 — added as a stub in this same planning pass); **watcher** notifications on every ' +
    'comment (Story 5.4 owns watchers; the 5.1.6 event payload already carries what it needs); ' +
    'comment **reactions/emoji**, edit **history**, and rendering field-change history in the ' +
    'Activity feed (Story 5.5). The Activity section ships with the comments stream and a ' +
    'documented seam where 5.5 adds the History filter.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the 5.1.1 ' +
    '`comment` + `comment_mention` migration cleanly; a re-run reports "No difference detected" — ' +
    'both FKs are modelled as Prisma `@relation`s, no drift), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres, no mocks except `getSession`) over ' +
    '`commentsService` (add/edit/delete/list/permissions/mention parsing) stays ≥90% per-file ' +
    'branch/fn/line on the new service/repo files (the CI coverage gate); every new repo method ' +
    'has a direct empty-input-guard test.\n' +
    '- **Comment flow:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open any issue → the ' +
    'Activity section shows the comment thread + composer (matching ' +
    '`design/work-items/comments.mock.html`). Add a comment → it appears with your avatar + ' +
    'relative time. Edit it → the "Edited" tag shows. Reply to it → the reply nests one level; ' +
    'replying to the reply attaches to the same thread with the author pre-mentioned. Delete the ' +
    'root → the confirm names the reply count; the thread disappears (hard delete) and the ' +
    'revision trail records the deletion.\n' +
    "- **Mention flow:** type `@` in the composer → the member picker opens over the project's " +
    'viewable members; pick `bophilips@prodect.co` → the chip renders in the posted comment; the ' +
    'dev email console (`[EMAIL]` line) shows the mention notification to Bo (subject naming you ' +
    'and the issue identifier) — and NO email when you mention yourself. A mention in the issue ' +
    'DESCRIPTION (edit form) notifies the same way.\n' +
    '- **Permission checks:** as `eikooc@prodect.co` (member) — can add, can edit/delete OWN ' +
    "comment only (no edit/delete affordance on others'); as a project `viewer` — thread visible, " +
    "no composer; as project admin / workspace owner — can delete anyone's comment.\n" +
    '- **Scale check (finding #57):** seed an issue with 100+ comments (`pnpm db:seed:large` or ' +
    'the 5.1.7 fixture) → the detail page loads only the newest 20 with "Show more comments ' +
    '(N older)"; clicking extends backward; the network read is cursor-paged, never the full set; ' +
    'the sort toggle flips oldest/newest-first.\n' +
    '- `pnpm test:e2e --grep comments` — Playwright over the real stack: comment → mention → ' +
    'email assertion, edit/delete/reply, show-more at scale, sort toggle, viewer read-only.\n' +
    '- **a11y check:** the comments surface passes the strict axe sweep (composer labelled, the ' +
    'mention picker keyboard-navigable with the Combobox listbox semantics, "Edited"/timestamps ' +
    'conveyed as text, focus returns after post/delete); colour via `--el-*`, shape via element ' +
    'shape tokens.',
  items: [
    {
      id: '5.1.1',
      title:
        'Schema — `comment` + `comment_mention` models + migration (single-level threading via `parentCommentId`; FKs as Prisma relations)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: [],
      descriptionMd:
        'The persistence layer for threaded comments and queryable mentions. Pure ' +
        'schema + migration + repository skeleton — no service logic, no UI.\n\n' +
        '**`Comment` model:** `id` (cuid), `workspaceId` (the finding-#26 scoping gate every read ' +
        'filters on), `workItemId`, `authorId`, `parentCommentId` (nullable self-relation — the ' +
        'single-level threading decision: a root has `null`, a reply points at a root; depth >1 is ' +
        'rejected in the service, 5.1.2), `bodyMd` (`@db.Text` — Markdown, same substrate as ' +
        '`work_item.descriptionMd`), `editedAt` (nullable — set on body edit, drives the "Edited" ' +
        'tag; distinct from `updatedAt` which any write touches), `createdAt`, `updatedAt`. ' +
        'Relations: `workItem` (onDelete: Cascade — comments die with the issue), `author` ' +
        '(Restrict — a user with comments cannot be hard-deleted silently), `parent`/`replies` ' +
        'self-relation (onDelete: Cascade — deleting a root deletes its thread; the deliberate ' +
        '5.1.2 decision). Indexes: `[workItemId, createdAt]` (the paged list read), ' +
        '`[parentCommentId]`.\n\n' +
        '**`CommentMention` model:** `id`, `commentId` (Cascade), `mentionedUserId`, `createdAt`, ' +
        'with `@@unique([commentId, mentionedUserId])` — one row per mention regardless of how ' +
        'many times the token repeats. This is the queryable "mentions me" substrate Epic 6 ' +
        'filters on and 5.1.6 fans notifications out from.\n\n' +
        '**Every FK modelled as a Prisma `@relation` on BOTH sides** (forward field + ' +
        'back-relation: `WorkItem.comments`, `User.authoredComments`, `User.commentMentions`) with ' +
        'explicit `onDelete` actions — never raw-SQL-only (the CLAUDE.md migration rule; the ' +
        '2.3.7 attachment-FK drift lesson). `prisma migrate dev` after the migration reports "No ' +
        'difference detected".\n\n' +
        '**Repository skeleton** (`lib/repositories/commentRepository.ts` + ' +
        '`commentMentionRepository.ts`): single-Prisma-op methods — `create`/`update`/`delete` ' +
        'requiring `tx`, `findById`, the cursor-paged `listByWorkItem(workItemId, { cursor, take, ' +
        'order })` + `countByWorkItem`, `createMany`/`deleteByCommentId` for mentions. No business ' +
        'logic, no transactions (services own those — 5.1.2).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma/schema.prisma` adds `Comment` (workspaceId, workItemId, authorId, nullable ' +
        '`parentCommentId` self-relation, `bodyMd @db.Text`, nullable `editedAt`, timestamps) and ' +
        '`CommentMention` (`@@unique([commentId, mentionedUserId])`), every FK a two-sided ' +
        '`@relation` with explicit onDelete (workItem Cascade, author Restrict, parent Cascade, ' +
        'mention→comment Cascade); a follow-up `prisma migrate dev` reports no drift.\n' +
        '- Indexes exist for the paged list read (`[workItemId, createdAt]`) and the thread read ' +
        '(`[parentCommentId]`).\n' +
        '- `commentRepository` / `commentMentionRepository` expose single-op methods with ' +
        'required-`tx` writes per the 4-layer contract; reads support cursor + take + order.\n' +
        '- Vitest (real Postgres): cascades verified — deleting a work item removes its comments; ' +
        'deleting a root removes its replies + mention rows; the unique mention constraint holds; ' +
        'empty-input guards on the new repo methods have direct tests (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — `WorkItem` / `User` / `Workspace` models + the existing ' +
        'index/naming conventions; the `Attachment` model as the recent FK-relation exemplar\n' +
        '- `prodect-core/CLAUDE.md` — the 4-layer contract (required-`tx` writes; single-op repos) ' +
        '+ the FK-as-@relation migration rule (the 2.3.7 drift lesson)\n' +
        '- `lib/repositories/workItemRepository.ts` — repository shape + cursor/paging precedent\n' +
        '- Story plan: single-level threading + hard delete + the mention substrate are the ' +
        'Jira-verified decisions recorded in the 5.1 story description',
    },
    {
      id: '5.1.2',
      title:
        '`commentsService` — add/edit/delete/list with 6.4-role permissions, server-side mention parsing + `comment_mention` rows, paged reads, job events',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.1.1'],
      descriptionMd:
        'The business-logic core. Per the 4-layer rule: `lib/services/commentsService.ts` owning ' +
        'validation, transactions, DTO mapping, and typed errors (`lib/comments/errors.ts`); ' +
        'HTTP-only routes; the repos from 5.1.1.\n\n' +
        '**`addComment(workItemId, { bodyMd, parentCommentId? }, ctx)`** — validates the caller ' +
        'can view the issue AND holds a commenting role (project `admin`/`member` via the 6.4 ' +
        'access logic; the read-only `viewer` gets a typed `CommentForbiddenError` — the Jira "Add ' +
        'comments" permission mapped onto the shipped role model). A `parentCommentId` must point ' +
        'at a ROOT comment on the SAME issue (a reply-to-a-reply is attached to the root by the ' +
        'UI, 5.1.5; the service rejects depth >1 with a typed error — single-level threading). In ' +
        'ONE transaction: create the comment, parse mentions (below), write `comment_mention` ' +
        'rows. After commit: emit the `work-item/comment.created` job event (workspaceId, ' +
        'workItemId, commentId, authorId, mentionedUserIds) via the 1.6 `sendEvent` — events ' +
        'NEVER fire inside the tx (a rollback must not have notified anyone).\n\n' +
        '**Mention parsing — the service is the authority.** A shared helper ' +
        '(`lib/mentions/parse.ts`) extracts `[@Name](mention:<userId>)` tokens from Markdown. For ' +
        'each id: workspace member AND can view this issue (private projects → project members; ' +
        'open/limited → workspace members — the 6.4 `assignableMembersService` scoping, reused ' +
        'not duplicated); failures are silently DROPPED from the mention set (the Jira rule — no ' +
        'view permission, no notification), never an error. Dedup repeated tokens. On EDIT, ' +
        're-parse and diff: newly-added mentions get `comment_mention` rows + a follow-up event ' +
        'carrying ONLY the new ids (no re-notify on unchanged mentions).\n\n' +
        '**`editComment` / `deleteComment` — the Jira permission split.** Edit own = author; edit ' +
        'all / delete all = project `admin` or workspace admin/owner; delete own = author. Edit ' +
        'sets `editedAt` (the "Edited" tag). Delete is a **hard delete** — the row (and, for a ' +
        'root, its replies + mention rows, via the 5.1.1 cascade) is gone; in the same tx write a ' +
        '`work_item_revision` entry recording that a comment by X was deleted by Y (count of ' +
        'replies included) — the History trace Jira keeps and Story 5.5 renders. The deliberate ' +
        'root-delete-cascades decision (mirror behaviour unverifiable) is recorded here: confirm ' +
        'copy in 5.1.5 names the reply count.\n\n' +
        '**`listComments(workItemId, { cursor?, order? }, ctx)`** — view-gated, cursor-paged from ' +
        'the most recent (take 20) with `totalCount`, returning roots WITH their replies (a ' +
        'thread loads whole — replies are bounded by single-level threading) ordered per `order` ' +
        '(default oldest-first, the Jira default). NEVER a load-all (finding #57). DTOs carry ' +
        'author (id/name/image), body, editedAt, reply nesting, and mention metadata.\n\n' +
        '**Routes** (HTTP-only): `GET/POST /api/work-items/[id]/comments`, `PATCH/DELETE ' +
        '/api/comments/[id]` — parse → one service call → typed-error→status mapping ' +
        '(403 forbidden / 404 cross-workspace-invisible per finding #44 — never leak existence).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `commentsService` ships add/edit/delete/list with the permission matrix: viewer cannot ' +
        'add; author edits/deletes own; project admin + workspace admin/owner edit/delete all; ' +
        'all writes view-gated; cross-workspace access reads as 404 (finding #44).\n' +
        '- Threading: replies attach to roots only (depth >1 → typed error); a root delete ' +
        'cascades its thread and writes the revision-trail deletion record in the same tx.\n' +
        '- Mention parsing: `[@Name](mention:<id>)` tokens → deduped, view-validated ' +
        '`comment_mention` rows in the same tx; non-viewable/non-member ids dropped silently; ' +
        'edit re-parse notifies only NEW mentions; `work-item/comment.created` (typed in ' +
        '`JobEventDataMap`) emits AFTER commit, never on rollback.\n' +
        '- `listComments` is cursor-paged (take 20) + `totalCount`, threads load whole, order ' +
        'param flips oldest/newest-first; no unbounded read exists on any path.\n' +
        '- Edit sets `editedAt`; the DTO exposes it; routes are HTTP-only; ' +
        '`pnpm test:coverage` keeps the new files ≥90% branch/fn/line with direct empty-input ' +
        'guards (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- 5.1.1 repos + models; `lib/services/workItemsService.ts` — service conventions, the ' +
        'finding-#26 workspace gate, the finding-#44 404-not-403 rule\n' +
        '- `lib/services/assignableMembersService.ts` (6.4) — the EXACT view-scoping the mention ' +
        'validation + candidate read reuse\n' +
        '- `lib/services/workItemRevisionsService.ts` (1.4.6) — the revision-trail write for the ' +
        'deletion record\n' +
        '- `lib/jobs/sendEvent.ts` + `lib/jobs/types.ts` (1.6) — typed event emission (extend ' +
        '`JobEventDataMap`); `prodect-core/CLAUDE.md` — one service method = one transaction\n' +
        '- Story 5.1 description — the Jira-verified permission set, threading, hard-delete + ' +
        'History-trace semantics',
    },
    {
      id: '5.1.3',
      title:
        'Design — comment thread + composer + mention picker (`design/work-items/comments.mock.html`; fills the detail Activity placeholder)',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: [],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. `detail.pen` draws ONLY ' +
        'the Activity placeholder ("Activity" / "Comments coming in Epic 5") — the thread, ' +
        'composer, mention popup, and every comment state are whole elements NO design specifies, ' +
        'which under the design gate == no design exists, so this subtask produces it FIRST ' +
        '(mirrors 1.0.5 / 1.2.1 / 1.3.3 / 1.5.1 and the sibling HTML-mockup design subtasks ' +
        '2.4.8 / 2.5.7 / 4.6.1). Output: **`design/work-items/comments.mock.html`** (built from ' +
        'the real design system — `components/ui/*` + `--el-*` colour + element-semantic shape ' +
        'tokens, no Pencil→code gap) + a PNG export + a new section in ' +
        '`design/work-items/design-notes.md` naming primitives, copy, and placement. Passes the ' +
        'design-mockup render checklist (render + screenshot every panel; icon viewBoxes; no ' +
        'nested interactive elements; prettier; AA). Mirror: the Jira Cloud issue-view Activity ' +
        'section (threaded comments, GA 2025).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Placement** — the comments stream INSIDE the existing Activity section card (the ' +
        '`ContentSectionCard` grammar, after Relationships — where the placeholder sits today). A ' +
        'filter seam in the section header (Comments active; History as the documented 5.5 ' +
        'extension slot, drawn disabled the way 2.5.3 drew the view-switcher seam) + the **sort ' +
        'toggle** (oldest/newest-first, default oldest — per-user, the Jira shape).\n' +
        '- **Comment row** — initial-letter `Avatar` · author name · relative time (absolute on ' +
        'hover/title) · the **"Edited" tag** (muted, after the time) · the rendered Markdown body ' +
        '(`MarkdownView`, mention chips inline) · quiet row actions (Reply on roots; Edit/Delete ' +
        'per the permission matrix — drawn present/absent by role). **Replies** indent ONE level ' +
        'under their root (single-level threading); a long thread collapses its middle behind ' +
        '**"Show more replies"** (the Jira auto-collapse).\n' +
        '- **Composer** — the `MarkdownEditor` primitive (2.3.5) in a compact comment mode with ' +
        'placeholder copy, a primary **Comment** button (disabled while empty/submitting) + ghost ' +
        'Cancel when editing; the **edit-in-place** state (composer replaces the row body, ' +
        'Save/Cancel); the **reply** composer (indented under the thread, the replied-to author ' +
        'pre-mentioned as a chip — the Jira auto-tag).\n' +
        '- **Mention popup** — typing `@` anchors a member listbox at the caret: the Combobox ' +
        'option-row vocabulary (Avatar · name · secondary email · keyboard-navigable, ' +
        '`aria-activedescendant`), filtered as you type, fed by the viewable-member candidates. ' +
        'The **mention chip** as rendered in a posted body (accent-tinted, AA-safe — hue in the ' +
        'tint background, `--el-text-strong` text, finding #35).\n' +
        '- **Pagination** — **"Show more comments (N older)"** at the thread\'s older edge ' +
        '(position flips with the sort direction) + the total count in the section header; the ' +
        'loading skeleton rows; the empty state ("No comments yet — start the conversation", ' +
        'never blank); the `ErrorState`.\n' +
        '- **Destructive + restricted states** — the delete **confirm popover** (naming the reply ' +
        'count on a root: "Also deletes N replies — comments can\'t be restored", the hard-delete ' +
        'truth); the **viewer** (read-only) state: thread visible, NO composer, a quiet "You have ' +
        'view-only access" line (the 6.4 read-only grammar).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/work-items/comments.mock.html` + PNG + the design-notes section exist; built ' +
        'from `components/ui/*` + `--el-*`/element-shape tokens only (no Tier-0 `--color-*`, no ' +
        'raw `rounded-*`/fixed control padding); passes the render checklist; AA-safe; light + ' +
        'dark parity.\n' +
        '- Panels cover: placement in the Activity card (+ the History filter seam for 5.5 + sort ' +
        'toggle), the comment row (Edited tag, role-dependent actions), single-level replies + ' +
        '"Show more replies", the composer (new/edit/reply with pre-mentioned author), the ' +
        'mention popup + posted mention chip, "Show more comments (N older)" + count, loading / ' +
        'empty / error, the delete confirm naming the reply count, and the viewer read-only ' +
        'state.\n' +
        '- `design-notes.md` names the composing primitives (`ContentSectionCard`, `Avatar`, ' +
        '`MarkdownEditor`, `MarkdownView`, the Combobox listbox vocabulary, `Pill`/chip ' +
        'treatment), the copy strings, the oldest-first default, and documents the History seam ' +
        "as Story 5.5's slot + the padlock (per-comment visibility) as a deliberate " +
        'non-feature (team-managed Jira parity).\n' +
        '- No improvised primitive: every element composes the shipped design system; the mention ' +
        'chip + any new `--el-*` token need is recorded in the notes for 5.1.4/5.1.5 to add.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/detail.pen` + `detail.png` — the Activity placeholder this fills; ' +
        '`design/work-items/design-notes.md` — the area conventions + where the new section goes\n' +
        '- `components/ui/MarkdownEditor.tsx` (2.3.5), `MarkdownView`, `Avatar`, `Combobox` ' +
        '(option-row vocabulary), `ContentSectionCard`, `Modal`/popover confirm patterns\n' +
        '- The Jira Cloud issue-view Activity section (threaded comments GA 2025; "Show more ' +
        'comments"; Edited tag; oldest-first default + toggle) — the mirror surface\n' +
        '- Findings #35 (AA: hue in tint bg + strong text), #54 (use the palette); the ' +
        'design-mockup render checklist memory',
    },
    {
      id: '5.1.4',
      title:
        'Mention capability in `MarkdownEditor` + mention-chip rendering in `MarkdownView` (tiptap Mention + `mention:` token round-trip)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.1.3', '5.1.2'],
      descriptionMd:
        'The editor-level mention capability — built into the SHARED `MarkdownEditor` primitive ' +
        '(2.3.5) so comments (5.1.5) AND the existing description fields (create modal, edit ' +
        'form) gain mentions in one place — the Jira-faithful scope (mentions work in ' +
        'description too). Design-gated UI: carries 5.1.3 in `dependsOn` (the popup + chip are ' +
        "designed there) and 5.1.2 (the token format + candidate scoping are the service's " +
        'contract).\n\n' +
        '**Editor side.** Add `@tiptap/extension-mention` (suggestion plugin) to ' +
        '`MarkdownEditor`: typing `@` opens the caret-anchored member listbox from the 5.1.3 ' +
        'design (Combobox option-row vocabulary — Avatar · name · email; filter-as-you-type; ' +
        '↑/↓/Enter/Esc; `aria-activedescendant` — the a11y bar the shipped Combobox sets). ' +
        'Candidates come from a `mentionCandidates` prop the host surface supplies (the ' +
        "detail/comment surfaces pass the issue-scoped viewable members from 5.1.2's candidate " +
        'read; the primitive itself stays data-source-agnostic and mention support is OFF when ' +
        'the prop is absent — existing consumers are untouched until wired). The mention node ' +
        '**serializes to the durable Markdown token** `[@Display Name](mention:<userId>)` via ' +
        'the tiptap-markdown serializer, and parses back on load (round-trip stable — editing a ' +
        'body with mentions preserves them).\n\n' +
        '**Render side.** `MarkdownView` / `lib/markdown/render.tsx`: allow the `mention:` ' +
        "protocol through `rehype-sanitize` (extend the schema's allowed protocols — the " +
        'default strips unknown schemes) and map mention links to a **user chip** (the 5.1.3 ' +
        'treatment: accent tint bg + `--el-text-strong`, finding #35 AA) instead of a navigable ' +
        'anchor. Unknown/stale user ids degrade to plain text of the display name — never a ' +
        'broken link.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `MarkdownEditor` accepts an optional `mentionCandidates` source; with it, `@` opens ' +
        'the designed picker (keyboard-complete, axe-clean) and inserts a mention that ' +
        'serializes to `[@Name](mention:<userId>)` and round-trips through ' +
        'load→edit→`getMarkdown()` unchanged; without it, behaviour is byte-identical to today ' +
        '(existing tests untouched).\n' +
        '- `MarkdownView` renders mention tokens as the designed chip (no navigation), sanitize ' +
        'still strips every other non-allowlisted protocol (no XSS regression — test ' +
        '`javascript:` stays dead), and a stale id degrades to plain text.\n' +
        '- No raw `--color-*`/Tier-0 utilities; chip + popup colour through `--el-*`, shape ' +
        "through element tokens (adding tokens per the growth pattern if 5.1.3's notes call for " +
        'them).\n' +
        '- Component tests: serialization round-trip, the sanitize allowlist, the ' +
        "picker's keyboard path; `pnpm test:coverage` holds the gate.\n\n" +
        '## Context refs\n\n' +
        '- `design/work-items/comments.mock.html` + design-notes (5.1.3) — the popup + chip ' +
        'design\n' +
        '- `components/ui/MarkdownEditor.tsx` (2.3.5 — tiptap v3 + tiptap-markdown, ' +
        '`html: false`), `lib/markdown/render.tsx` + `rehype-sanitize` schema\n' +
        '- `lib/mentions/parse.ts` + the candidate read (5.1.2) — the token format + scoping ' +
        'contract the editor must match\n' +
        '- `components/ui/Combobox.tsx` — the option-row + `aria-activedescendant` vocabulary ' +
        'the popup mirrors',
    },
    {
      id: '5.1.5',
      title:
        'Comments section UI on the issue detail page — thread + composer + reply/edit/delete + "Show more" paging in the Activity slot',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.1.2', '5.1.3', '5.1.4'],
      descriptionMd:
        'The user-facing surface: replace the detail page\'s Activity placeholder ("Comments ' +
        'coming in Epic 5") with the designed comments stream. Design-gated (5.1.3) and built on ' +
        'the service (5.1.2) + the mention-capable editor (5.1.4).\n\n' +
        '**Build** (in `app/(authed)/issues/[key]/_components/`): a `CommentsSection` inside the ' +
        'existing Activity `ContentSectionCard` — the section header count + the (disabled) ' +
        'History filter seam documented for 5.5 + the sort toggle (oldest-first default, ' +
        'localStorage-persisted per user); the thread list (roots + one-level replies, long ' +
        'threads collapsing middle replies behind "Show more replies"); the composer ' +
        '(`MarkdownEditor` compact mode + `mentionCandidates` wired to the issue-scoped read); ' +
        'reply composers (pre-mentioning the replied-to author); edit-in-place; the delete ' +
        'confirm popover naming the reply count; **"Show more comments (N older)"** driving the ' +
        'cursor-paged read (server action / route — never load-all, finding #57); loading ' +
        'skeleton, empty state, `ErrorState`. Mutations go through Server Actions calling ' +
        '`commentsService` + `router.refresh()` (the shipped detail-page pattern — no realtime, ' +
        'the documented story-level decision). Role-aware affordances: composer hidden for ' +
        '`viewer` (the quiet view-only line); Edit/Delete rendered per the 5.1.2 permission ' +
        'matrix (the server re-checks regardless — UI affordance is not the gate).\n\n' +
        '**A11y:** the thread is a labelled feed/list; rows expose author + time as text; focus ' +
        'returns to a sane place after post/edit/delete; the strict axe sweep covers the ' +
        'detail route with comments present (extending the 2.4.6 sweep scope).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Activity placeholder is gone; the section renders the designed thread (matching ' +
        '`comments.mock.html` panel-for-panel: row grammar, Edited tag, reply indent + ' +
        'collapse, composer states, mention chips) with the count + sort toggle + History seam.\n' +
        '- Add/reply/edit/delete round-trip through Server Actions with the permission-aware ' +
        'affordances (viewer: no composer; non-author: no Edit; admin: Delete on any) and the ' +
        'delete confirm naming the reply count.\n' +
        '- Pagination: first paint shows the newest 20 in the active order with "Show more ' +
        'comments (N older)"; extending appends without losing scroll position; an issue with ' +
        '100+ comments never issues an unbounded read.\n' +
        '- Empty / loading / error states match the design; the sort toggle flips and persists; ' +
        'the detail-route axe sweep stays clean; colour/shape only through `--el-*`/element ' +
        'tokens.\n' +
        '- Component/integration tests over the section (role matrix rendering, paging, ' +
        'reply-collapse) + the existing detail E2E still green.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/comments.mock.html` + design-notes (5.1.3) — THE layout authority\n' +
        '- `app/(authed)/issues/[key]/page.tsx` + `_components/` (the Activity placeholder, ' +
        '`ContentSectionCard`, the Server-Action + `router.refresh()` pattern from ' +
        '`edit/actions.ts`)\n' +
        '- `commentsService` + routes (5.1.2); `MarkdownEditor` mentions (5.1.4)\n' +
        '- The 2.4.6 a11y sweep scope (extend to the comments surface); finding #57 (paged, ' +
        'never load-all)',
    },
    {
      id: '5.1.6',
      title:
        'Mention → email notification job (`work-item/comment.created` + description-mention parity) via the 1.6 pipeline + `mentionNotification` template',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.1.2', '1.6.3'],
      descriptionMd:
        'The notification hook — the stub\'s "Mention → notification hook (via Story 1.6 ' +
        'jobs)". Email only here; the event payload is channel-agnostic so Story 5.7 (in-app ' +
        'bell) and Story 5.4 (watchers) fan in off the SAME events later.\n\n' +
        '**Job** (`lib/jobs/definitions/mentionNotify.ts`, the 1.6 `defineJob` harness — ' +
        'mirroring `emailSend.ts`, the production reference): consumes ' +
        '`work-item/comment.created` (and `work-item/mentioned`, below). Per mentioned user: ' +
        'skip the author (never self-notify), **re-validate view access at send time** (the ' +
        'Jira rule — access may have changed since the write; the 5.1.2 scoping reused), render ' +
        'the **`mentionNotification` template** and send through the shipped email pipeline. ' +
        '**Idempotent** per (commentId × userId) via the harness idempotency key — a replay or ' +
        'retry never double-mails. Failures land in the DLQ per the 1.6 contract.\n\n' +
        '**Template** (`lib/emailTemplates/mentionNotification.tsx`, the pure-template ' +
        'contract): "<Author> mentioned you on <PROD-N: title>" subject; body with the author, ' +
        'the issue identifier + title as a deep link, a short PLAIN-TEXT excerpt of the comment ' +
        '(Markdown stripped, mention tokens rendered as @Name — a small `lib/mentions` helper; ' +
        'no raw token leakage), and the CTA button to the issue. Hand-written plain text with ' +
        'the link unredacted (the dev-console grep contract).\n\n' +
        '**Description-mention parity (Jira-faithful).** Mentions in the issue DESCRIPTION ' +
        'notify too: on `createWorkItem` / description-changing `updateWorkItem`, parse with ' +
        'the SAME `lib/mentions/parse.ts` helper, diff against the prior body (only ' +
        'newly-added, view-validated ids), and emit `work-item/mentioned` (workspaceId, ' +
        'workItemId, authorId, mentionedUserIds) after commit. The job treats both events ' +
        'uniformly (idempotency key swaps commentId for the revision id). No `WorkItem` schema ' +
        'change — description mentions are notification-only (no stored mention rows; recorded ' +
        'as the deliberate scope line: the queryable substrate is comment-scoped until a use ' +
        'case earns more).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `JobEventDataMap` gains `work-item/comment.created` + `work-item/mentioned` (typed ' +
        'payloads); both emit AFTER their transactions commit; the job fans out one email per ' +
        'mentioned user, skipping the author and any user who can no longer view the issue at ' +
        'send time.\n' +
        '- Idempotency: replaying the event or retrying the job never double-sends (per ' +
        'comment×user / revision×user key); failures land in the DLQ (`@inngest/test` ' +
        'coverage, the 1.6 test harness).\n' +
        '- `mentionNotification` is a pure template (no I/O; props in, `{subject, text, html}` ' +
        'out) with hand-written plain text + unredacted deep link; the excerpt renders mention ' +
        'tokens as @Name, never raw `mention:` markup.\n' +
        '- Editing a comment notifies ONLY newly-added mentions; description create/edit ' +
        'notifies newly-added description mentions through the same job; the dev email console ' +
        'shows the `[EMAIL]` line in the E2E flow.\n' +
        '- `pnpm test:coverage` holds the gate on the new job/template/service-diff code.\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/defineJob.ts` + `definitions/emailSend.ts` (1.6.3) — the harness, ' +
        'idempotency, DLQ + the production job exemplar; `lib/jobs/types.ts` — the typed event ' +
        'map to extend\n' +
        '- `lib/emailTemplates/` contract (CLAUDE.md — pure templates, hand-written plain ' +
        'text); `workspaceInvite.tsx` as the exemplar\n' +
        '- `lib/mentions/parse.ts` + the view-scoping (5.1.2); `workItemsService` ' +
        'create/update paths (the description diff point)\n' +
        '- Story 5.7 stub (the in-app consumer of these same events) + Story 5.4 (watchers) — ' +
        'the channel-agnostic payload contract',
    },
    {
      id: '5.1.7',
      title:
        'Story tests — Vitest service matrix + Playwright E2E (comment→mention→email, reply/edit/delete, show-more at scale) + strict a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.1.5', '5.1.6'],
      descriptionMd:
        'The story-closing verification (Principle #18 — review at the Story level): the ' +
        'end-to-end journey over the real stack plus the cross-cutting assertions the ' +
        "per-subtask tests don't own. (Epic-wide collaboration journeys remain Story 5.6; this " +
        'is the 5.1-scoped story E2E, the same split Stories 2.3.10 / 2.4.6 / 4.7 use.)\n\n' +
        '**Vitest (integration, real Postgres):** the permission matrix end-to-end through the ' +
        'service (viewer/member/admin × add/edit-own/edit-all/delete-own/delete-all), the ' +
        'threading invariants (reply depth, root-delete cascade + revision record), mention ' +
        'parse→persist→event flow incl. the dropped-non-viewable case and the edit-diff ' +
        '(only-new-mentions) rule, and pagination edges (cursor walk, order flip, empty page, ' +
        'count).\n\n' +
        '**Playwright E2E (`tests/e2e/comments.spec.ts`):** signed in as the PM — add a ' +
        'comment; `@`-mention Bo via the picker (keyboard path: type, ↓, Enter); assert the ' +
        'posted chip AND the `[EMAIL]` dev-console line (mention notification to Bo, none to ' +
        'self); reply (auto-mention pre-filled) and assert single-level nesting; edit → Edited ' +
        'tag; delete the root → confirm names the reply count → thread gone. **At-scale ' +
        'fixture** (an issue seeded with 100+ comments — seed positions/fixtures per the E2E ' +
        'helper conventions): first paint shows 20 + "Show more comments (N older)", extending ' +
        'appends, the sort toggle flips, no unbounded request fires. **Role pass:** a viewer ' +
        'sees the thread, no composer. Run against the standing dev-server harness (the ' +
        'OOM-safe reuseExistingServer pattern).\n\n' +
        '**Strict a11y sweep:** the detail route WITH a populated, mention-bearing thread + ' +
        'open mention picker passes the strict axe config (extending the 2.4.6 sweep): ' +
        'labelled feed, keyboard-complete picker, text-conveyed state (Edited / timestamps / ' +
        'role notices), AA on the mention chip + confirm popover.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest matrix covers every permission cell + threading + mention-diff + paging ' +
        'edge named above; `pnpm test:coverage` keeps all 5.1 files ≥90% branch/fn/line.\n' +
        '- `comments.spec.ts` passes the full journey (comment → mention → email assert → ' +
        'reply → edit → delete-with-cascade-confirm) + the 100-comment scale walk + the viewer ' +
        "pass, green in CI's Playwright lane.\n" +
        '- The strict axe sweep over the comments-populated detail route reports zero ' +
        'violations.\n' +
        '- The Story 5.1 verification recipe runs clean top to bottom; flaky-isolation rule ' +
        'respected (no reliance on sibling-session DB state).\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/issue-detail-flow.spec.ts` + `tests/e2e/_helpers/` — the detail-page E2E ' +
        'conventions + selector gotchas (Combobox option name = label+secondary: match the ' +
        'email substring)\n' +
        '- `tests/integration/` service-test conventions (real DB, `getSession` mock only)\n' +
        '- The 2.4.6 strict-a11y sweep config (extend scope); the dev email console `[EMAIL]` ' +
        'grep contract (1.1.6 / 1.6.3)\n' +
        '- The E2E harness memories: standing dev server + inngest stub (OOM), shared-DB flake ' +
        'isolation',
    },
  ],
};
