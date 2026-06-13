import type { PlanStory } from '../types';

/**
 * Story 5.7 — In-app notifications (bell + unread feed).
 *
 * The IN-APP half of the notification surface. Story 5.1.6 (DONE) ships the
 * **email** half plus the channel-agnostic job events (`work-item/comment.created`,
 * `work-item/mentioned`) over the Story 1.6 cron/job pipeline; Story 5.4 (watchers)
 * adds `work-item/transitioned`; Story 6.6 (automation) adds `work-item/created`
 * + `work-item/field.changed`. 5.7 is the in-app channel that **consumes those
 * already-shipped events** — a bell in the shell header with an unread count, a
 * notification feed/drawer (mentions first), mark-read / mark-all-read, deep
 * links into issues, and per-user notification preferences (email vs in-app per
 * event type — the Jira personal-notification-settings shape).
 *
 * 📦 Lives in Epic 5 (Collaboration & fields). Added as a stub during the 5.1
 * expansion: Jira notifies mentions in-app as well as by email, and no story
 * owned that surface — a no-V1-tier ownership gap (an unowned capability is a
 * planning bug, not a scope cut), fixed at plan time. Every dependency points
 * backward or sideways — same-story 5.7.x cards plus the SHIPPED 5.1.6 event
 * map — so the cross-epic audit (`notes.html` mistake #32) is CLEAN: no
 * forward-pointing dep. In particular 5.7 does NOT depend on 5.4 or 6.6: the
 * 5.7.3 consumer is built EXTENSIBLE so those stories' events fan in through the
 * SAME handler when they land, with no 5.7 change (they already document 5.7's
 * preference toggle as their seam — 5.4 description, 6.6 description).
 *
 * **The architectural invariant (locked at 5.1, restated here): one emit path,
 * many channels.** A notification is NEVER a second emit site. Comment/mention/
 * transition writes emit ONE channel-agnostic job event after their transaction
 * commits; the 5.1.6 email job is one consumer, the 5.7.3 in-app job is a SECOND
 * consumer of the same event. So 5.7 adds a notification PERSISTENCE model fed by
 * a job — it does not touch `commentsService` / `workItemsService` / the emit
 * sites, and it does not introduce a parallel "also notify in-app" call beside
 * any email send. This is what keeps watcher (5.4) and automation (6.6) events
 * fanning in for free.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian +
 * Linear sources at plan time, 2026-06-12, not asserted from memory):
 *   • **The bell badge counts NEW notifications since you last opened the
 *     drawer; opening clears the count** (Atlassian: "the number over the icon
 *     reflects how many new notifications you've received since you last opened
 *     the notification drawer"). So the badge is a *seen* count, distinct from
 *     per-row *read* state — Motir models both: a fast unread/unseen count for
 *     the badge, and a per-row `readAt` for the blue-dot + mark-read.
 *   • **Two filters — Direct vs Watching.** Jira splits the drawer into
 *     **Direct** (you're mentioned / assignee / reporter — the actions involving
 *     you) and **Watching** (items you watch). Motir ships the same split as a
 *     `category` on the notification ("mentions first" == the Direct tab is the
 *     default/primary), with Watching populated once 5.4's `work-item/
 *     transitioned` fan-in lands — no 5.7 change.
 *   • **Per-row read state + "Mark all as read".** Each row carries an unread
 *     blue-dot; clicking a notification deep-links to the issue AND marks it
 *     read; "Mark all as read" sits behind the drawer's overflow (three-dots)
 *     menu. (Jira's own "mark all" has shipped bugs — JRACLOUD-85017/85043 mark
 *     only the *displayed* rows — so Motir's mark-all is a single server
 *     operation over the unread set, not a client loop over rendered rows.)
 *   • **Click deep-links to the issue; rows persist until dismissed** (not
 *     auto-purged on read). Motir keeps read rows in the feed (greyed, no dot)
 *     and pages the feed — a years-active user accrues thousands of rows, so the
 *     feed read is CURSOR-paginated and the count is a cheap indexed aggregate,
 *     never a load-all (finding #57).
 *   • **Linear Inbox** is the rung-1 cross-check for the feed/drawer + read
 *     model: a dedicated inbox surface, `U` mark read/unread, `Alt-U` mark all,
 *     `J/K` navigate, click opens the issue inline. Motir mirrors the *model*
 *     (a feed with per-row read state, mark-all, keyboard-navigable, deep-link
 *     on open) at Jira's drawer altitude (a header bell + drawer, not a separate
 *     Inbox route — Motir's shell is Jira-shaped, design 5.7.1 fixes the exact
 *     surface).
 *   • **Per-user notification preferences** — Jira's *Personal settings →
 *     Notification settings* lets each user choose to be notified when watching
 *     / mentioned / assigned-or-reporter / they made the change. Motir generalizes
 *     this to a per-user × event-type × CHANNEL (email | in_app) matrix — the
 *     gate BOTH the 5.7.3 in-app consumer and the DONE 5.1.6 email job honour
 *     (5.7.6). Lives on the existing `/settings/account` personal-settings area.
 *
 * ⚠️ Design gate (planning-time). `design/shell/` draws the header (`desktop.pen`)
 * but NO bell, NO unread badge, NO notification drawer/feed, and no per-user
 * notification-preferences settings page — those are whole elements no design
 * specifies == NO design exists. So subtask **5.7.1** is a `type: design` subtask
 * producing the bell + badge + drawer (populated / empty / read-vs-unread /
 * mark-all-read) AND the preferences settings page under `design/notifications/`,
 * and EVERY UI-touching code subtask (5.7.5 the bell + drawer, 5.7.6 the
 * preferences page) carries 5.7.1 in `dependsOn` and is seeded `status:
 * 'blocked'` (Principle #13).
 *
 * Inline-edit memory applied (5.7.5). Mark-read / mark-all-read are inline
 * mutations: the success response IS the confirmation — no `router.refresh()` /
 * `revalidatePath` whole-tree fan-out (the inline-edit-no-tree-refresh lesson;
 * the refresh fan-out is what CAUSED the revert bug). The badge updates from the
 * mutation's own returned count, not a tree re-fetch.
 *
 * Out-of-scope justifications (justified-deviation rule, recorded inline):
 * realtime push (the badge updating without a navigation/poll) — the codebase is
 * Server Components + Server Actions with no realtime substrate, exactly as 5.1
 * recorded for live comments; the count refreshes on navigation + a bounded poll
 * while the drawer is open, and a realtime channel is a product-wide decision,
 * not a story-local improvisation. Notification GROUPING / digest batching
 * (Jira's 10-minute email consolidation) is an email-delivery policy owned by
 * 5.1.6's job, not the in-app feed. Mobile/native push is not a Motir surface.
 *
 * Expanded from its `stubs.ts` entry per `motir plan 5.7`. Matches the canonical
 * depth + string-literal style of Stories 5.1 / 7.1.
 */
export const story_5_7: PlanStory = {
  id: '5.7',
  title: 'In-app notifications (bell + unread feed)',
  status: 'planned',
  gitBranch: 'feat/PROD-5.7-in-app-notifications',
  descriptionMd:
    'The in-app half of the notification surface — a bell in the shell header with an unread ' +
    'count, a notification feed/drawer (mentions first), mark-read / mark-all-read, deep links ' +
    'into issues, and per-user notification preferences (email vs in-app per event type). Story ' +
    '5.1.6 (DONE) already ships the **email** half plus the channel-agnostic job events; **5.7 ' +
    'is the in-app channel that consumes those SAME events** — a notification persistence model ' +
    'fed by a job, never a second emit path.\n\n' +
    '**One emit path, many channels (the locked invariant).** Comment/mention writes emit ONE ' +
    'channel-agnostic event after commit (`work-item/comment.created`, `work-item/mentioned` — ' +
    "5.1.6's events); the email job is one consumer. 5.7 adds a SECOND consumer (the 5.7.3 " +
    'in-app job) of the same events that writes `Notification` rows. 5.7 touches no emit site, ' +
    'adds no "also notify in-app" call beside any email send, and is built so the watcher event ' +
    '(`work-item/transitioned`, Story 5.4) and the automation events (`work-item/created`, ' +
    '`work-item/field.changed`, Story 6.6) fan into the SAME handler when they land — **no 5.7 ' +
    'change, no forward dep** (5.4 + 6.6 already document 5.7 as their seam).\n\n' +
    '**The Jira/Linear-verified shape (decision-ladder rung 1, checked at plan time — not ' +
    'memory).** The bell badge counts NEW notifications since the drawer was last opened ' +
    '(opening clears it) — a *seen* count distinct from per-row *read* state, so Motir models ' +
    'BOTH: a cheap unread-count aggregate for the badge and a per-row `readAt` for the blue-dot ' +
    '+ mark-read. The drawer splits **Direct** (mentions / assignment / reporter — "mentions ' +
    'first") from **Watching** (the 5.4 fan-in slot). Each row deep-links to its issue AND marks ' +
    'itself read on open; **"Mark all as read"** sits in the drawer overflow and is a single ' +
    "server operation over the unread set (NOT a client loop over rendered rows — Jira's own " +
    'mark-all ships bugs from doing exactly that, JRACLOUD-85017). Read rows persist in the feed ' +
    '(greyed, no dot). **Linear Inbox** is the cross-check for the feed model (per-row read ' +
    'state, mark-all, keyboard-navigable, deep-link on open).\n\n' +
    '**Preferences (the Jira personal-notification-settings shape).** Each user controls, per ' +
    "event type, whether they are notified by **email** and/or **in-app** — generalizing Jira's " +
    '"notify me when watching / mentioned / assigned / I made the change" into a per-user × ' +
    'event-type × channel matrix on the existing `/settings/account` personal-settings area. The ' +
    'preference is the **channel gate** honoured by BOTH the 5.7.3 in-app consumer AND the DONE ' +
    '5.1.6 email job (5.7.6 wires the gate into 5.1.6 without touching its emit site).\n\n' +
    '**Scale (finding #57 — never load-all).** A years-active user accrues thousands of ' +
    'notifications; the feed read is **cursor-paginated** from the most recent (page size 20) ' +
    'and the unread count is a **cheap indexed aggregate** (a partial index on the unread ' +
    'predicate), never a `COUNT(*)` over the whole table or a load-everything read. The drawer ' +
    'shows the newest page + "Show more"; mark-all is a single bulk `UPDATE`.\n\n' +
    '**Completeness — the real-product states.** Empty (no notifications yet — an inviting, ' +
    'non-blank state), loading (skeleton rows in the drawer), error (`ErrorState` + retry), the ' +
    'unread vs read row treatment (blue-dot vs greyed), the Direct/Watching split with Watching ' +
    'inert until 5.4 lands (a documented seam, drawn the way 2.5.3 drew the disabled ' +
    'view-switcher), the zero-badge state, the preferences page with its per-event-type × ' +
    'channel toggles + saving/saved/error states. All drawn by 5.7.1, asserted in 5.7.7/5.7.8.\n\n' +
    '**Out of scope (documented, each justified):** realtime PUSH of the badge (no realtime ' +
    'substrate — the 5.1 live-comments decision; the count refreshes on navigation + a bounded ' +
    'poll while the drawer is open); notification GROUPING / digest batching (an email-delivery ' +
    "policy owned by 5.1.6's job, not the in-app feed); mobile/native push (not a Motir " +
    "surface); the Watching tab's population + the `work-item/transitioned` fan-in (Story 5.4 " +
    'owns the event; 5.7.3 is built to consume it with no change); automation-event ' +
    'notifications (Story 6.6 owns `work-item/created` + `work-item/field.changed`; same seam).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the 5.7.2 ' +
    '`notification` + 5.7.6 `notification_preference` migration cleanly; a re-run reports "No ' +
    'difference detected" — every FK modelled as a Prisma `@relation`, no drift), `pnpm db:seed`, ' +
    '`pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres, `getSession` mock only) over ' +
    '`notificationsService` (feed paging, unread count, mark-read, mark-all-read, the per-user ' +
    'scoping), the 5.7.3 fan-in job (recipients, actor-excluded, mention-deduped), and the 5.7.6 ' +
    'preference gate stays ≥90% per-file branch/fn/line on the new service/repo/job files (the CI ' +
    'coverage gate); every new repo method has a direct empty-input-guard test.\n' +
    '- **Bell + feed flow:** sign in as `bophilips@motir.co`. From another session, ' +
    "`zhuyue@motir.co` @-mentions Bo in a comment → Bo's bell badge increments (on Bo's next " +
    'navigation/poll). Open the drawer (matching `design/notifications/drawer.mock.html`): the ' +
    'mention sits at the top of **Direct** with an unread blue-dot; the badge count clears (seen). ' +
    'Click the row → it deep-links to the issue AND the row marks read (dot gone, greyed); the ' +
    'unread count decrements by one. Receive several more → "Mark all as read" in the drawer ' +
    'overflow clears every dot in ONE request (reload: they stay read — the JRACLOUD-85017 ' +
    'regression is absent).\n' +
    '- **Preferences flow:** open `/settings/account` → Notifications: the per-event-type × ' +
    'channel (email / in-app) matrix renders. Toggle **in-app** OFF for "Mentioned" → a new ' +
    'mention no longer creates a `Notification` row (no bell increment) but the email still ' +
    'arrives. Toggle **email** OFF instead → the `[EMAIL]` dev-console line stops for mentions ' +
    'while the bell still increments — proving BOTH the in-app consumer (5.7.3) and the DONE ' +
    'email job (5.1.6) read the same gate.\n' +
    '- **Self-exclusion + dedupe:** mention yourself → no bell increment, no email (actor ' +
    'excluded). A user who is both mentioned and (later) a watcher gets ONE row per event, not ' +
    'two (mention-deduped, the 5.4 dedupe rule the consumer inherits).\n' +
    '- **Scale check (finding #57):** seed a user with 2,000+ notifications (`pnpm ' +
    'db:seed:large` or the 5.7.7 fixture) → the drawer loads only the newest 20 with "Show more"; ' +
    'the badge count comes from the indexed unread aggregate (a single fast query, not a table ' +
    'scan); no unbounded read fires on any path.\n' +
    '- `pnpm test:e2e --grep notifications` — Playwright over the real stack: ' +
    'mention → bell increment → drawer open → click → issue → marked read → badge decrement, plus ' +
    'the preference-off path stopping the right channel.\n' +
    '- **a11y check:** the bell + drawer pass the strict axe sweep (the bell is a labelled ' +
    'button announcing the unread count, the drawer is a keyboard-navigable feed/list, read state ' +
    'conveyed as text not colour alone, focus returns to the bell on close); the preferences ' +
    'matrix is a labelled control grid; colour via `--el-*`, shape via element shape tokens.',
  items: [
    {
      id: '5.7.1',
      title:
        'Design — bell + unread badge in the shell header + the notification drawer + the per-user notification-preferences settings page (`design/notifications/`)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 45,
      dependsOn: [],
      descriptionMd:
        'The design asset every UI subtask of this story builds against. `design/shell/` draws ' +
        'the header (`desktop.pen`) but NO bell, NO unread badge, NO notification drawer/feed, ' +
        'and no notification-preferences settings page — those are whole elements NO design ' +
        'specifies, which under the design gate == no design exists, so this subtask produces ' +
        'them FIRST (mirrors 5.1.3 and the sibling HTML-mockup design subtasks). Output, under a ' +
        'NEW **`design/notifications/`** area: **`bell.mock.html`** (the header bell + badge ' +
        'states), **`drawer.mock.html`** (the feed/drawer), and **`preferences.mock.html`** (the ' +
        'settings page) — each built from the real design system (`components/ui/*` + `--el-*` ' +
        'colour + element-semantic shape tokens, no Pencil→code gap) + PNG exports + a new ' +
        '`design/notifications/design-notes.md` naming primitives, copy, and placement. Passes ' +
        'the design-mockup render checklist (render + screenshot every panel; icon viewBoxes; no ' +
        'nested interactive elements; prettier; AA). Mirror: the Jira Cloud header notification ' +
        'bell + drawer (Direct/Watching split, blue-dot, Mark all as read in the overflow) and ' +
        'the Linear Inbox feed model; the Jira *Personal settings → Notification settings* page.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Bell + badge (in the header)** — placement in `TopNav` (desktop) and the ' +
        '`SidebarHeader`/mobile drawer affordance, beside the existing header controls. The bell ' +
        '**`IconButton`** (a labelled control, the `--radius-control` affordance), with the ' +
        '**unread/seen badge** as a small count pill anchored to the bell (the count = NEW since ' +
        'last open, per the Jira mirror; 99+ cap). States: zero (no badge), 1–99, 99+, and the ' +
        'open (drawer-anchored) state.\n' +
        '- **The drawer/feed** — a header-anchored popover/drawer (the shipped popover grammar; ' +
        'on mobile, a sheet) with: a **Direct / Watching** segmented filter (Direct default — ' +
        '"mentions first"; **Watching drawn DISABLED** as the documented 5.4 seam, the way 2.5.3 ' +
        'drew the disabled view-switcher), the overflow (three-dots) menu carrying **"Mark all as ' +
        'read"**, and the scrollable feed below.\n' +
        '- **Notification row** — actor `Avatar` · a one-line summary (e.g. "**Zhu Yue** ' +
        'mentioned you on **PROD-42: …**") · relative time (absolute on hover/title) · the ' +
        '**unread blue-dot** leading indicator. Unread vs **read** treatment (read = no dot, ' +
        'muted via `--el-text-muted`, NOT removed from the feed). The whole row is ONE clickable ' +
        'target that deep-links to the issue (no nested interactive elements). Per-row hover ' +
        'affordance to toggle read (the Linear `U` model, surfaced as a control).\n' +
        '- **Feed states** — the loading skeleton rows; the **empty state** ("You\'re all caught ' +
        'up — no notifications yet", never blank); the `ErrorState` + retry; the **"Show more"** ' +
        'affordance at the older edge (cursor paging, finding #57) + the at-scale long feed.\n' +
        '- **The preferences page** (`preferences.mock.html`) — a section on the ' +
        '`/settings/account` personal-settings area: a **matrix** of event types (rows: ' +
        "Mentioned · Commented on an item you're involved in · Assigned to you · [Watching: item " +
        'transitioned — the 5.4 seam, drawn disabled] · …) × **channels** (columns: Email · ' +
        'In-app) of toggles, with section copy, the saving/saved/error inline states, and the ' +
        "defaults annotated (both channels ON for direct/mention events). Mirror Jira's " +
        'Notification-settings layout.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/notifications/{bell,drawer,preferences}.mock.html` + PNGs + the ' +
        '`design-notes.md` exist; built from `components/ui/*` + `--el-*`/element-shape tokens ' +
        'only (no Tier-0 `--color-*`, no raw `rounded-*`/fixed control padding); pass the render ' +
        'checklist; AA-safe; light + dark parity.\n' +
        '- Panels cover: the bell + badge (zero / 1–99 / 99+ / open), the drawer (Direct default ' +
        '+ Watching-disabled seam + overflow "Mark all as read"), the row (actor/summary/time/ ' +
        'blue-dot, unread vs read, single clickable deep-link target, toggle-read affordance), ' +
        'loading / empty / error / "Show more" + at-scale, and the preferences matrix (event × ' +
        'channel toggles + saving/saved/error + annotated defaults + the Watching-event seam).\n' +
        '- `design-notes.md` names the composing primitives (`IconButton`, the count-pill / ' +
        '`Badge`, the popover/drawer grammar, `Avatar`, the segmented filter, the overflow menu, ' +
        'the toggle/`Switch`, `ContentSectionCard` for the settings section), the copy strings, ' +
        'the Direct-default + Watching-disabled decision, the "badge = seen-since-open" vs ' +
        '"row = readAt" distinction, and records the realtime non-feature (poll/navigation ' +
        'refresh) + any new `--el-*`/shape token need for 5.7.5/5.7.6 to add.\n' +
        '- No improvised primitive: every element composes the shipped design system; no nested ' +
        'interactive elements inside the clickable row (the portal-popover / nested-button ' +
        'lessons).\n\n' +
        '## Context refs\n\n' +
        '- `design/shell/desktop.pen` + `desktop.png` — the header this adds the bell to; ' +
        '`app/(authed)/_components/TopNav.tsx` / `SidebarHeader.tsx` / `SidebarNav.tsx` — the ' +
        'shell header components the bell mounts in\n' +
        '- `design/work-items/comments.mock.html` + `design-notes.md` (5.1.3) — the sibling ' +
        'Activity/notification surface conventions + the mention-row vocabulary to echo\n' +
        '- `components/ui/*` — `IconButton`, `Badge`/count-pill, the popover + overflow-menu ' +
        'grammar, `Avatar`, `Switch`, `ContentSectionCard`, the `ErrorState`/empty/skeleton ' +
        'patterns\n' +
        '- The Jira Cloud header notification bell + drawer (Direct/Watching, blue-dot, "Mark all ' +
        'as read" in the overflow) and the *Personal settings → Notification settings* page; the ' +
        'Linear Inbox feed model — the mirror surfaces\n' +
        '- Findings #35 (AA: hue in tint bg + strong text), #54 (use the palette); the ' +
        'design-mockup render checklist + portal-popover/nested-button memories',
    },
    {
      id: '5.7.2',
      title:
        'Schema — `Notification` model + repository + migration (cursor-paginated reads + an efficient unread-count aggregate; FKs as Prisma relations)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: [],
      descriptionMd:
        'The persistence layer for in-app notifications. Pure schema + migration + repository ' +
        'skeleton — no fan-in logic (5.7.3), no service (5.7.4), no UI. This is the model the ' +
        '5.7.3 job WRITES and the 5.7.4 service READS.\n\n' +
        '**`Notification` model:** `id` (cuid), `workspaceId` (the finding-#26 scoping gate every ' +
        'read filters on), `recipientUserId` (the user this notification is FOR — every read is ' +
        'scoped to the session user), `type` (an enum/string discriminator: `mentioned`, ' +
        '`commented`, `assigned`, `transitioned` (the 5.4 seam), … — the event-type axis the ' +
        '5.7.6 preference matrix keys on), `category` (`direct` | `watching` — the Jira ' +
        'Direct/Watching drawer split), `workItemId` (nullable — the deep-link target; nullable ' +
        'so non-item notifications remain modellable), `actorId` (nullable — who caused it; ' +
        'rendered as the row avatar), `data` (`Json` — the denormalized render payload: the ' +
        'summary nouns the row needs without a join storm — issue key + title, comment excerpt, ' +
        'from→to status — captured at fan-in so the feed read is a single-table scan), `readAt` ' +
        '(nullable — set on mark-read; the blue-dot / greyed driver), `createdAt`. Relations: ' +
        "`recipient` (User, onDelete: Cascade — a user's notifications die with them), `actor` " +
        '(User, nullable, onDelete: SetNull), `workItem` (nullable, onDelete: Cascade — a deleted ' +
        "issue's notifications go with it).\n\n" +
        '**Indexes for scale (finding #57).** The feed read is `[recipientUserId, createdAt]` ' +
        '(cursor-paged from most-recent, per recipient). The **unread count must be cheap**: a ' +
        '**partial index** on `(recipientUserId)` `WHERE "readAt" IS NULL` (Postgres partial ' +
        'index over the unread predicate) so the badge aggregate is an index-only count, never a ' +
        'sequential scan — the durable shape for a table that grows unbounded per active user. A ' +
        '`@@unique` on the idempotency key (see 5.7.3) prevents a replayed event double-writing a ' +
        'row.\n\n' +
        '**Every FK modelled as a two-sided Prisma `@relation`** (forward field + back-relation: ' +
        '`User.notifications`, `User.actedNotifications`, `WorkItem.notifications`) with explicit ' +
        '`onDelete` — never raw-SQL-only (the CLAUDE.md migration rule; the 2.3.7 attachment-FK ' +
        'drift lesson). `prisma migrate dev` after the migration reports "No difference ' +
        'detected".\n\n' +
        '**Repository skeleton** (`lib/repositories/notificationRepository.ts`): single-Prisma-op ' +
        'methods — `createMany` requiring `tx` (the job writes a fan-out batch in one tx), ' +
        '`findById`, the cursor-paged `listByRecipient(userId, { cursor, take, category? })`, ' +
        '`countUnreadByRecipient(userId)` (the partial-index aggregate), `markRead(id, tx)` and ' +
        '`markAllReadByRecipient(userId, tx)` (a single bulk `updateMany` over the unread set — ' +
        'NOT a per-row loop). No business logic, no transactions (services own those — 5.7.4).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `prisma/schema.prisma` adds `Notification` (workspaceId, recipientUserId, type, ' +
        'category, nullable workItemId, nullable actorId, `data Json`, nullable `readAt`, ' +
        'createdAt) with every FK a two-sided `@relation` + explicit onDelete (recipient Cascade, ' +
        'actor SetNull, workItem Cascade); a follow-up `prisma migrate dev` reports no drift.\n' +
        '- The feed index `[recipientUserId, createdAt]` exists AND a partial unread index ' +
        '(`WHERE "readAt" IS NULL`) backs `countUnreadByRecipient` — verified by an `EXPLAIN` (or ' +
        'a documented migration note) showing the count uses the partial index, not a seq scan; ' +
        'the idempotency-key `@@unique` exists.\n' +
        '- `notificationRepository` exposes single-op methods with required-`tx` writes per the ' +
        '4-layer contract; `listByRecipient` supports cursor + take + category; ' +
        '`markAllReadByRecipient` is one `updateMany`, not a loop.\n' +
        '- Vitest (real Postgres): cascade verified (deleting a user / work item removes its ' +
        'notification rows; deleting the actor sets `actorId` null); the idempotency unique ' +
        'holds; `countUnreadByRecipient` ignores read rows; empty-input guards on the new repo ' +
        'methods have direct tests (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` — `WorkItem` / `User` / `Workspace` models + the index/naming ' +
        'conventions; the 5.1 `Comment` / `CommentMention` models as the recent two-sided ' +
        '`@relation` exemplar\n' +
        '- `motir-core/CLAUDE.md` — the 4-layer contract (required-`tx` writes; single-op repos) ' +
        '+ the FK-as-@relation migration rule (the 2.3.7 drift lesson)\n' +
        '- `lib/repositories/commentRepository.ts` — the cursor-paged `listBy…` + `countBy…` ' +
        'shape to mirror; finding #57 (paged + cheap count, never load-all)\n' +
        '- Story 5.7 description — the badge-seen-count vs row-readAt distinction + the ' +
        'Direct/Watching `category` split the schema encodes',
    },
    {
      id: '5.7.3',
      title:
        'In-app notification fan-in job — a 1.6-pipeline consumer of the SHIPPED 5.1.6 events writing `Notification` rows (actor-excluded, mention-deduped, EXTENSIBLE for 5.4/6.6)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.7.2'],
      descriptionMd:
        'The event CONSUMER — the heart of "fed by a job, never a second emit path". A SECOND ' +
        'consumer (beside the DONE 5.1.6 email job) of the SAME channel-agnostic events, on the ' +
        'same 1.6 `defineJob` pipeline, that fans each event into `Notification` rows for the ' +
        'right recipients. It touches NO emit site and adds NO "also notify in-app" call ' +
        'anywhere — the emit already happened (5.1.6); 5.7.3 just subscribes.\n\n' +
        '**Job** (`lib/jobs/definitions/notificationFanIn.ts`, the 1.6 `defineJob` harness — ' +
        'mirroring `mentionNotify.ts`, the 5.1.6 in-production reference): consumes the shipped ' +
        '`work-item/comment.created` + `work-item/mentioned` events. For each event it computes ' +
        'the **recipient set**, then writes a `Notification` row per recipient (the 5.7.2 ' +
        '`createMany`, one tx) carrying the denormalized `data` payload the feed row renders ' +
        '(issue key + title, actor, a plain-text excerpt with mention tokens rendered as @Name — ' +
        'reusing the `lib/mentions` helper 5.1.6 already uses; no raw `mention:` leakage).\n\n' +
        '**Recipient rules (inherited from the 5.1.6 / 5.4 contract — same semantics, in-app ' +
        'channel):** the **actor is ALWAYS excluded** (never notify yourself — the 5.1.6 rule); ' +
        'mentions are **deduped** (a user mentioned twice in one comment gets ONE row; a user who ' +
        'is both mentioned and a watcher gets ONE — the 5.4 dedupe rule, mention wins the ' +
        '`direct` category); **view access is re-validated** at fan-in time (a recipient who can ' +
        'no longer view the issue gets no row — the 5.1.6 send-time re-check). **Idempotent** per ' +
        '(eventId × recipientUserId) via the 5.7.2 `@@unique` + the harness idempotency key — a ' +
        'replay or retry never double-writes; failures land in the DLQ per the 1.6 contract.\n\n' +
        '**EXTENSIBLE — the fan-in seam (no forward dep).** The handler dispatches on a small ' +
        "`eventType → { category, recipients(event), summary(event) }` registry so Story 5.4's " +
        "`work-item/transitioned` (the `watching` category) and Story 6.6's `work-item/created` " +
        '+ `work-item/field.changed` fan in by ADDING a registry entry **when those events land ' +
        "— with NO change to this job's core and NO dependency on 5.4/6.6 here** (those stories " +
        'document 5.7 as their seam). 5.7.3 ships only the entries for the SHIPPED 5.1.6 events; ' +
        'an unregistered event type is a clean no-op, not an error.\n\n' +
        '**The preference gate is consulted here** (the actual gating code is 5.7.6, which this ' +
        "job calls): before writing a recipient's row, check their per-event-type **in_app** " +
        'preference; if off, no row. 5.7.3 ships the call site + a permissive default; 5.7.6 ' +
        'lands the `NotificationPreference` model + the resolver behind it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `work-item/comment.created` / `work-item/mentioned` event fans into one ' +
        '`Notification` row per eligible recipient (the `createMany` batch in one tx), with the ' +
        'denormalized `data` payload the feed renders; the actor is excluded; mentions are ' +
        'deduped (twice-mentioned → one row; mention+watcher → one `direct` row).\n' +
        '- View access is re-validated at fan-in (a non-viewer recipient gets no row); ' +
        'idempotency holds (replaying the event / retrying the job never double-writes, per the ' +
        '(eventId × recipient) key); failures land in the DLQ (the 1.6 / `@inngest/test` ' +
        'harness).\n' +
        '- The handler is registry-driven: adding a new `eventType` entry is the ONLY change ' +
        'needed for 5.4/6.6 to fan in (asserted by a test that registers a synthetic event type ' +
        'and sees rows); an unregistered event type is a clean no-op. **No import of, or dep on, ' +
        'Story 5.4 / 6.6 code.**\n' +
        '- The in-app preference gate is consulted per recipient via the 5.7.6 resolver (a ' +
        'permissive default until 5.7.6 lands); no emit site is touched and no second notify call ' +
        'is added beside any email send.\n' +
        '- `pnpm test:coverage` holds the gate on the new job code.\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/definitions/mentionNotify.ts` (5.1.6) — the in-production consumer this ' +
        'mirrors (the SECOND consumer of the same events); `lib/jobs/defineJob.ts` + ' +
        '`lib/jobs/types.ts` — the harness, idempotency, DLQ + the typed `JobEventDataMap` ' +
        '(consumed, NOT extended here)\n' +
        '- 5.7.2 `notificationRepository.createMany` + the `@@unique` idempotency key\n' +
        '- `lib/services/assignableMembersService.ts` (6.4) / the 5.1.6 view re-check — the ' +
        'recipient view-validation reused\n' +
        '- `lib/mentions/` — the excerpt/@Name render helper 5.1.6 already uses (no raw token ' +
        'leakage)\n' +
        '- Story 5.4 (the `work-item/transitioned` watcher event — the `watching` fan-in slot) + ' +
        'Story 6.6 (`work-item/created` / `work-item/field.changed`) — the events that fan in via ' +
        'the registry seam later, with no 5.7 change',
    },
    {
      id: '5.7.4',
      title:
        '`notificationsService` + routes — cursor-paged feed, unread count, mark-read, mark-all-read (4-layer, per-user scoped)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.7.2'],
      descriptionMd:
        'The READ + mark-state API the bell/drawer (5.7.5) calls. Per the 4-layer rule: ' +
        '`lib/services/notificationsService.ts` owning scoping, paging, transactions, DTO ' +
        'mapping, and typed errors (`lib/notifications/errors.ts`); HTTP-only routes; the ' +
        'repository from 5.7.2. Every method is **scoped to the session user** — a notification ' +
        'belongs to exactly one recipient, and a user can only read/mutate their OWN ' +
        '(cross-user access reads as 404, finding #44 — never leak existence).\n\n' +
        '**`listNotifications({ cursor?, category? }, ctx)`** — cursor-paged from the most recent ' +
        '(take 20) with a `totalCount` + the `unreadCount`, filtered to the session user, ' +
        'optionally narrowed to `direct` | `watching` (the drawer tabs). NEVER a load-all ' +
        '(finding #57). DTOs carry actor (id/name/image), the rendered summary from `data`, the ' +
        'deep-link target (issue key), `category`, `readAt`, `createdAt`.\n\n' +
        '**`getUnreadCount(ctx)`** — the cheap aggregate (the 5.7.2 partial-index count) the bell ' +
        'badge polls; a single fast query, never a row fetch.\n\n' +
        '**`markRead(notificationId, ctx)`** — sets `readAt` on ONE notification the caller owns ' +
        '(idempotent — already-read is a no-op), returns the updated row + the new `unreadCount` ' +
        '(so the caller updates the badge from the RESPONSE, not a re-fetch — the ' +
        'inline-edit-no-tree-refresh contract). **`markAllRead(ctx)`** — one bulk `updateMany` ' +
        "over the caller's unread set (the 5.7.2 method), returns the new `unreadCount` (zero). " +
        'NOT a per-row client loop (the JRACLOUD-85017 anti-pattern).\n\n' +
        '**Routes** (HTTP-only): `GET /api/notifications` (list + counts), `GET ' +
        '/api/notifications/unread-count` (the badge poll), `PATCH /api/notifications/[id]/read`, ' +
        '`POST /api/notifications/mark-all-read` — parse → one service call → typed-error→status ' +
        "mapping (404 on a notification the caller doesn't own, per finding #44 — never leak " +
        'existence).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `notificationsService` ships list / unread-count / mark-read / mark-all-read, every ' +
        "method scoped to the session user; reading or marking another user's notification reads " +
        'as 404 (finding #44).\n' +
        '- `listNotifications` is cursor-paged (take 20) + `totalCount` + `unreadCount`, ' +
        'category-filterable (direct/watching); no unbounded read exists on any path.\n' +
        '- `markRead` is idempotent and returns the fresh `unreadCount`; `markAllRead` is a ' +
        'single bulk update returning zero — both return the count so the UI updates from the ' +
        'response (no tree re-fetch).\n' +
        '- Routes are HTTP-only (no `db.*` / `$transaction`); `pnpm test:coverage` keeps the new ' +
        'service/repo files ≥90% branch/fn/line with direct empty-input guards (the coverage ' +
        'gate).\n\n' +
        '## Context refs\n\n' +
        '- 5.7.2 `notificationRepository` (the paged list + partial-index count + bulk ' +
        'mark-all); `motir-core/CLAUDE.md` — the 4-layer contract, one-method-one-transaction, ' +
        'the finding-#26 workspace gate + the finding-#44 404-not-403 rule\n' +
        '- `lib/services/commentsService.ts` (5.1.2) — the cursor-paged read + typed-error ' +
        'service conventions to mirror\n' +
        '- The inline-edit-no-whole-tree-refresh memory (the mutation returns the new count; the ' +
        'UI does not re-fetch the tree)\n' +
        '- Story 5.7 description — the badge-poll vs feed-read split + the mark-all-as-one-op ' +
        'decision',
    },
    {
      id: '5.7.5',
      title:
        'The bell + unread badge + notification drawer in the shell header — live count, deep links, mark-read on open (no whole-tree refresh)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.7.1', '5.7.4'],
      descriptionMd:
        'The user-facing surface: the bell + badge + drawer in the shell header. Design-gated ' +
        '(5.7.1) and built on the read/mark API (5.7.4).\n\n' +
        '**Build** (in `app/(authed)/_components/`): a `NotificationBell` mounted in `TopNav` ' +
        '(desktop) + the `SidebarHeader`/mobile affordance — the bell `IconButton` + the unread ' +
        '**badge** (count from `getUnreadCount`, 99+ cap, zero = no badge). A bounded **poll** ' +
        'refreshes the count on an interval while mounted + on navigation (the documented ' +
        'no-realtime decision — no realtime substrate, the 5.1 live-comments precedent). Opening ' +
        'the bell renders a `NotificationDrawer` (the popover/drawer; sheet on mobile): the ' +
        'Direct / Watching segmented filter (Watching disabled — the 5.4 seam), the overflow ' +
        '"Mark all as read", and the cursor-paged feed (newest 20 + "Show more" driving the ' +
        '5.7.4 list read — never load-all). Each **row is one clickable target** that deep-links ' +
        'to the issue (`/issues/[key]`) AND marks itself read on open. Loading skeleton, empty ' +
        'state, `ErrorState`.\n\n' +
        '**Inline-edit memory (load-bearing).** Mark-read and mark-all-read are inline mutations: ' +
        'the **success response IS the confirmation** — the badge + row state update from the ' +
        "mutation's OWN returned `unreadCount` / row, **NOT** a `router.refresh()` / " +
        '`revalidatePath` whole-tree fan-out (the refresh fan-out is what CAUSED the revert bug; ' +
        'the cell trusts its own success). Opening the badge marks "seen" (clears the badge ' +
        'count) per the Jira mirror, distinct from per-row read.\n\n' +
        '**A11y:** the bell is a labelled button announcing the unread count (e.g. "Notifications, ' +
        '3 unread"); the drawer is a keyboard-navigable feed/list (the Linear J/K + U model, ' +
        'surfaced via standard controls); read state is conveyed as text + the dot, not colour ' +
        'alone; focus returns to the bell on close; no nested interactive elements inside a row ' +
        '(the portal-popover / nested-button lessons). The strict axe sweep covers the header ' +
        'with the drawer open.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The bell renders in the header with the unread badge (matching ' +
        '`design/notifications/{bell,drawer}.mock.html` panel-for-panel: badge states, row ' +
        'grammar, unread-vs-read, Direct default + Watching-disabled seam, overflow mark-all); the ' +
        'count refreshes on poll + navigation.\n' +
        '- Opening the drawer marks "seen" (badge clears); clicking a row deep-links to the issue ' +
        'AND marks that row read with the unread count decrementing **from the mutation response, ' +
        'with no `router.refresh()`/`revalidatePath`**; "Mark all as read" clears every dot in ' +
        'one request and survives reload.\n' +
        '- The feed pages (newest 20 + "Show more"), never an unbounded read; empty / loading / ' +
        'error states match the design; colour/shape only through `--el-*`/element tokens.\n' +
        '- The header axe sweep with the drawer open is clean (labelled bell announcing the ' +
        'count, keyboard-navigable feed, text-conveyed read state, focus return, no nested ' +
        'interactive elements).\n\n' +
        '## Context refs\n\n' +
        '- `design/notifications/{bell,drawer}.mock.html` + design-notes (5.7.1) — THE layout ' +
        'authority\n' +
        '- `app/(authed)/_components/TopNav.tsx` / `SidebarHeader.tsx` / `SidebarNav.tsx` — the ' +
        'shell header components the bell mounts in; the existing header-control + popover ' +
        'patterns\n' +
        '- `notificationsService` + routes (5.7.4) — the read/mark API; the unread-count poll ' +
        'endpoint\n' +
        '- The inline-edit-no-whole-tree-refresh memory (no `router.refresh` fan-out on the ' +
        'mark-read success path) + the portal-popover / nested-button memories\n' +
        '- Story 5.7 description — the no-realtime (poll) decision + the seen-vs-read split',
    },
    {
      id: '5.7.6',
      title:
        'Per-user notification preferences — `NotificationPreference` model + the settings page (Jira shape); the channel gate BOTH the 5.7.3 in-app job AND the DONE 5.1.6 email job honour',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 38,
      dependsOn: ['5.7.2', '5.7.1'],
      descriptionMd:
        'The per-user notification preferences (the Jira personal-notification-settings shape) + ' +
        'the **channel gate** that makes them real. Design-gated (5.7.1, the preferences panel) ' +
        'and built on the 5.7.2 foundation. Full 4-layer for the model + settings surface.\n\n' +
        '**`NotificationPreference` model** (`prisma/schema.prisma` + migration, two-sided FK): ' +
        '`{ id, userId, eventType, channel, enabled }` with `@@unique([userId, eventType, ' +
        'channel])` — a per-user × event-type × **channel** (`email` | `in_app`) toggle. ' +
        'Absence = the **documented default** (direct/mention events default both channels ON; ' +
        'the resolver supplies the default so an unset row is not "off"). `userId` FK a two-sided ' +
        '`@relation` (`User.notificationPreferences`, onDelete Cascade). `prisma migrate dev` ' +
        'reports no drift.\n\n' +
        '**The resolver — the channel gate (the load-bearing seam).** ' +
        '`lib/services/notificationPreferencesService.ts` exposes `isChannelEnabled(userId, ' +
        'eventType, channel)` (and a batch variant) resolving a row-or-default. This is the SAME ' +
        'gate consulted by:\n' +
        '  • the **5.7.3 in-app job** (the call site it stubbed with a permissive default — now ' +
        'backed by the real resolver), AND\n' +
        '  • the **DONE 5.1.6 email job** — wired here to consult `isChannelEnabled(recipient, ' +
        'eventType, "email")` before sending, so toggling email OFF actually suppresses the mail. ' +
        "**This is a gate ADDED at 5.1.6's SEND decision, not a change to any emit site** — the " +
        'event still fires once; the email job just asks the resolver before dispatching (the ' +
        'one-emit-path invariant holds). 5.1.6 already documents the preference toggle as its ' +
        'seam (its description), so this is the planned wiring, not a reach into frozen code.\n\n' +
        '**The settings page** (`app/(authed)/settings/account/_components/` — the existing ' +
        'personal-settings area, beside `LanguageCard`): the per-event-type × channel matrix of ' +
        'toggles from the 5.7.1 design (Mentioned / Commented / Assigned / [Watching: transitioned ' +
        '— disabled 5.4 seam] × Email · In-app), with the Watching-event rows drawn disabled until ' +
        '5.4 lands. Toggling a cell is an inline mutation through a Server Action calling the ' +
        'service — the **success response IS the confirmation** (no whole-tree refresh; the ' +
        'inline-edit memory), with saving/saved/error inline states. A `GET/PUT ' +
        '/api/notification-preferences` route pair (HTTP-only) backs it.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `NotificationPreference` (`@@unique([userId, eventType, channel])`, two-sided ' +
        '`@relation`, Cascade) + migration land; `prisma migrate dev` reports no drift; an unset ' +
        'preference resolves to the documented default (direct/mention ON), not "off".\n' +
        '- `notificationPreferencesService.isChannelEnabled` is the single resolver; the 5.7.3 ' +
        'in-app job consults it (in_app) AND the DONE 5.1.6 email job is wired to consult it ' +
        '(email) at its SEND decision — toggling email off stops the mail, toggling in-app off ' +
        'stops the bell row, with NO change to any emit site (the event still fires once).\n' +
        '- The settings page renders the event × channel matrix on `/settings/account` with the ' +
        'Watching-event rows disabled (the 5.4 seam); toggling persists through a Server Action ' +
        'whose success response updates the cell (no `router.refresh` fan-out); saving/saved/ ' +
        'error states match the 5.7.1 design.\n' +
        '- Routes are HTTP-only; `pnpm test:coverage` holds the gate on the new model/service/ ' +
        'page code.\n\n' +
        '## Context refs\n\n' +
        '- 5.7.2 (the `Notification` model + the `type` axis the preference keys on); 5.7.3 (the ' +
        'in-app call site this backs); 5.7.1 (the preferences-panel design)\n' +
        '- `lib/jobs/definitions/mentionNotify.ts` (5.1.6, DONE) — the email job whose SEND ' +
        'decision this gates (the documented preference seam in its 5.1.6 card)\n' +
        '- `app/(authed)/settings/account/page.tsx` + `_components/LanguageCard.tsx` — the ' +
        'existing personal-settings area + card grammar to extend; `components/ui/Switch` + ' +
        '`ContentSectionCard`\n' +
        '- `motir-core/CLAUDE.md` — 4-layer; the inline-edit-no-whole-tree-refresh memory (the ' +
        'toggle success IS confirmation); the Jira *Personal settings → Notification settings* ' +
        'mirror',
    },
    {
      id: '5.7.7',
      title:
        'Vitest — `Notification` model + fan-in recipients (actor-excluded, mention-deduped, registry-extensible) + the read/mark API + preference gating',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.7.3', '5.7.4', '5.7.6'],
      descriptionMd:
        'The integration verification across the 5.7 model + fan-in + API + preference gate ' +
        '(real Postgres, `getSession` mock only — the standing rule). The cross-cutting ' +
        "assertions the per-subtask tests don't fully own; the Playwright journey is 5.7.8.\n\n" +
        '**Model (5.7.2):** cascade behaviour (recipient/work-item delete removes rows; actor ' +
        'delete nulls), the partial-index unread count ignores read rows, the idempotency ' +
        '`@@unique` rejects a duplicate (eventId × recipient), cursor paging edges (walk, empty ' +
        'page, count).\n\n' +
        '**Fan-in job (5.7.3):** a `work-item/mentioned` event writes one row per eligible ' +
        'recipient with the right `data` payload + `category: direct`; the **actor is excluded**; ' +
        'a user mentioned twice → ONE row; a non-viewer recipient → no row; a replayed event → no ' +
        'duplicate (idempotent). **Extensibility:** registering a SYNTHETIC event type produces ' +
        'rows through the same handler with no core change (the 5.4/6.6 seam, asserted WITHOUT ' +
        'depending on 5.4/6.6 code); an unregistered type is a clean no-op.\n\n' +
        '**API (5.7.4):** list is per-user-scoped + cursor-paged + category-filterable; reading ' +
        "another user's notification → 404; mark-read is idempotent and returns the fresh count; " +
        'mark-all-read is one bulk op returning zero.\n\n' +
        '**Preference gate (5.7.6):** in_app OFF for an event type → the fan-in writes no row for ' +
        'that user; email OFF → the 5.1.6 email job suppresses the mail (asserted via the ' +
        '`[EMAIL]`/job harness) while in-app still writes — proving BOTH channels read the same ' +
        'resolver; an unset preference resolves to the documented default.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest matrix covers the model (cascade / partial-count / idempotency / paging), ' +
        'the fan-in (recipients, actor-excluded, mention-dedupe, view-recheck, idempotent, the ' +
        'registry-extensible synthetic-event case), the API (scoping / 404 / paging / mark-read / ' +
        'mark-all), and the preference gate (in_app + email both honoured, default resolution); ' +
        '`pnpm test:coverage` keeps all 5.7 files ≥90% branch/fn/line.\n' +
        '- The extensibility test registers a synthetic event type and sees rows WITHOUT importing ' +
        'Story 5.4 / 6.6 code (proving the seam carries no forward dep).\n' +
        '- The flaky-isolation rule is respected (no reliance on sibling-session DB state).\n\n' +
        '## Context refs\n\n' +
        '- `tests/integration/` service-test conventions (real DB, `getSession` mock only) + the ' +
        '`@inngest/test` job harness (the 5.1.6 / 1.6 pattern for fan-in + DLQ assertions)\n' +
        '- 5.7.2 / 5.7.3 / 5.7.4 / 5.7.6 — everything under test; the coverage gate (direct ' +
        'empty-input guards on new repo methods)\n' +
        '- Story 5.7 description — the actor-exclude / mention-dedupe / view-recheck / ' +
        'channel-gate rules being asserted',
    },
    {
      id: '5.7.8',
      title:
        'Playwright E2E — mention → bell increment → drawer → click → issue → marked read → badge decrement; preference-off stops the channel',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['5.7.5'],
      descriptionMd:
        'The story-closing end-to-end journey over the real stack (Principle #18 — review at the ' +
        'Story level): the in-app notification loop a user actually experiences, plus the ' +
        'preference-gate cut. Run against the standing dev-server + inngest-stub harness (the ' +
        'OOM-safe reuseExistingServer pattern; the cron/job pipeline drives the fan-in).\n\n' +
        '**Playwright (`tests/e2e/notifications.spec.ts`):** two browser contexts — **B** ' +
        '(`zhuyue@motir.co`) and **A** (`bophilips@motir.co`). B opens an issue and @-mentions A ' +
        "in a comment (the 5.1 picker keyboard path). A's **bell badge increments** (after A's " +
        'navigation/poll). A opens the **drawer** → the mention sits atop **Direct** with the ' +
        'unread blue-dot; the badge clears (seen). A **clicks the row** → it deep-links to the ' +
        'issue AND the row marks read (dot gone, greyed); the **unread count decrements** (asserted ' +
        'to come from the response, no full reload). B mentions A twice more → "Mark all as read" ' +
        'in the overflow clears every dot in one action; on reload they STAY read (the ' +
        'JRACLOUD-85017 regression is absent). **Self-exclusion:** B mentioning B produces no ' +
        'bell increment for B.\n\n' +
        '**Preference cut:** A opens `/settings/account` → Notifications, toggles **in-app OFF** ' +
        'for "Mentioned" → B mentions A again → A\'s bell does NOT increment, but the `[EMAIL]` ' +
        'dev-console line still fires (email channel untouched). A toggles **email OFF** instead ' +
        '(in-app back on) → the next mention increments the bell while NO `[EMAIL]` line fires — ' +
        'demonstrating the single gate driving both channels independently.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `notifications.spec.ts` passes the full journey (mention → bell increment → drawer ' +
        'open/seen → click → issue deep-link → row marked read → badge decrement → mark-all → ' +
        "survives reload) + the self-exclusion case, green in CI's Playwright lane.\n" +
        '- The preference cut passes: in-app-off stops the bell (email still sends); email-off ' +
        'stops the mail (bell still increments) — both off the same `/settings/account` matrix.\n' +
        '- The badge/count updates without a whole-page reload on mark-read (the inline-edit ' +
        'contract observed in the E2E); the run uses the standing dev-server + inngest-stub ' +
        'harness; the flaky-isolation rule is respected.\n\n' +
        '## Context refs\n\n' +
        '- `tests/e2e/comments.spec.ts` (5.1.7) + `tests/e2e/_helpers/` — the comment/mention ' +
        'journey + the multi-context + selector gotchas (Combobox option name = label+secondary; ' +
        'the `[EMAIL]` dev-console grep contract)\n' +
        '- 5.7.5 (the bell/drawer surface) + 5.7.6 (the preferences matrix) — the surfaces under ' +
        'test\n' +
        '- The E2E harness memories: standing dev server + inngest stub (OOM-safe ' +
        'reuseExistingServer), shared-DB flake isolation; finding #57 (the feed stays paged under ' +
        'the journey)',
    },
  ],
};
