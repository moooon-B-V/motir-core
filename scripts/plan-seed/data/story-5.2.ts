import type { PlanStory } from '../types';

/**
 * Story 5.2 — Attachments.
 *
 * First-class issue attachments: the managed, work_item-linked attachment
 * panel (list/strip + upload + download + delete + image/PDF preview) on the
 * issue detail page. It REUSES the 2.3.7 upload primitive wholesale (finding
 * #52's explicit contract): `attachmentsService.uploadAttachment`, the
 * `POST /api/upload/issue-attachment` route, the shared `lib/blob/allowlist.ts`
 * (10 MB cap + MIME set + rate limit), and the `attachment` table. This story
 * adds the `attachment.workItemId` link + the management surface — it does NOT
 * rebuild the uploader.
 *
 * 📦 Lives in Epic 5. Deps point at 5.1 (same epic, earlier story), 5.2
 * siblings, and done Epic-1/2 work — the cross-epic audit (`notes.html`
 * mistake #32) is clean: no forward-pointing dep.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10):
 *   • **Panel** — switchable strip (thumbnail cards: preview/type icon + name
 *     + date) and list (adds size) views; a count; "Download" per file. Jira
 *     loads the whole set and force-degrades to list view >150 attachments
 *     (cap 2,000/item) — we deviate to a cursor-paged read + "Show more"
 *     (finding #57: strictly bounded reads; Jira's own cap+degrade acknowledges
 *     the same pressure — justification recorded).
 *   • **Embeds ARE attachments** — files added via the description/comment
 *     editor appear in the panel; the panel BLOCKS deleting a comment/field-
 *     sourced file (it points you at the source instead). Deleting an
 *     attachment out from under an embed leaves a broken embed in Jira
 *     (closed Won't-Fix) — our block-on-editor-sourced rule avoids that hole.
 *   • **Permissions** — exactly three: Create attachments / Delete own /
 *     Delete all. Mapped onto the 6.4 roles like 5.1's comment set:
 *     admin/member add; uploader deletes own; project admin + workspace
 *     admin/owner delete all; read-only `viewer` neither.
 *   • **Preview** — click a thumbnail → full-screen preview for images + PDF
 *     (other types download); in-preview prev/next is NOT verified in Jira
 *     Cloud, so it is not planned (no complexity for nothing).
 *   • **Delete** — permanent (no trash); the issue History records attachment
 *     added/removed. (Jira has a documented gap: editor-added files miss the
 *     changelog — we record ALL adds/removes uniformly; deliberate improvement
 *     over a documented mirror bug, not a deviation from intent.)
 *   • **Access control** — Jira serves attachments authenticated. The shipped
 *     storage layer (rung 2) is Vercel Blob `access: 'public'` with
 *     `addRandomSuffix` — public-but-unguessable URLs, the SAME shape Jira's
 *     own JSM "unguessable links" mode ships for portal customers. Kept (the
 *     markdown-embed render path depends on direct URLs; the storage layer has
 *     no private serving), recorded as a deliberate deviation with the authed
 *     proxy/private storage named an Epic-8 hardening extension. The
 *     management API (list/delete/link) is fully workspace- and role-gated.
 *
 * ⚠️ Design gate (planning-time). NO attachment surface is designed anywhere —
 * `detail.pen` has no attachments section (the page reserves an Epic-5 slot in
 * a code comment only) and the quick-view notes list attachments as
 * detail-only. So subtask **5.2.4** is the `type: design` subtask
 * (`design/work-items/attachments.mock.html`), and the UI code subtasks
 * (5.2.5 panel, 5.2.6 preview) carry it in `dependsOn` and seed `'blocked'`
 * (Principle #13).
 *
 * Storage-lifecycle completeness (the non-happy-path Jira hides server-side):
 * editor uploads happen BEFORE the issue exists (create modal), so rows start
 * work_item-unlinked; a cancelled modal strands them, and 2.3.7 shipped no
 * delete path at all — so this story owns the full lifecycle: link-on-write
 * (5.2.3), delete with blob cleanup (5.2.2), and the orphan-GC job (5.2.7) on
 * the 1.6 harness. Blob store + token already provisioned (2.3 manual subtask,
 * done) — no new manual/human prerequisite.
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.2`, on the standing
 * `seed/epic-5-plan` branch. Matches the canonical depth + string-literal
 * style of Stories 4.6 / 5.1.
 */
export const story_5_2: PlanStory = {
  id: '5.2',
  title: 'Attachments',
  status: 'planned',
  descriptionMd:
    'First-class attachments: the managed, per-issue attachment panel on the detail page — strip ' +
    'of thumbnail cards / list toggle, upload (button + drag-drop), download, permission-gated ' +
    'delete, and an image/PDF preview — **reusing the 2.3.7 upload primitive wholesale** (finding ' +
    "#52's contract): `attachmentsService.uploadAttachment`, `POST /api/upload/issue-attachment`, " +
    'the shared `lib/blob/allowlist.ts` (10 MB + MIME set + rate limit), and the `attachment` ' +
    "table. 2.3.7's rows are deliberately work_item-unlinked (audit only); this story adds the " +
    '**`attachment.workItemId` link** + the management surface. The uploader is NOT rebuilt.\n\n' +
    '**The Jira-verified shape (rung 1, checked at plan time).** The panel offers **strip** ' +
    '(thumbnail cards — image preview or file-type glyph, name, date) and **list** (adds size) ' +
    'views with a count. **Embeds ARE attachments**: a file uploaded through the description or ' +
    'comment editor shows in the panel too, marked with its source — and the panel **blocks ' +
    'deleting editor-sourced files** (pointing at the source field instead), which is both the ' +
    "Jira rule and what prevents Jira's own broken-embed hole (deleting under an embed — closed " +
    "Won't-Fix there). Permissions are Jira's three, mapped onto the 6.4 roles exactly like 5.1's " +
    'comments: `admin`/`member` (who can view) **create**; the uploader **deletes own**; project ' +
    '`admin` + workspace admin/owner **delete all**; read-only `viewer` neither. Delete is ' +
    '**permanent** (no trash), removes the blob as well as the row, and the issue History records ' +
    'attachment added/removed (we record editor-added files too — Jira documents that gap as a ' +
    'known changelog hole; recording uniformly is the obviously-correct fill, not a deviation).\n\n' +
    '**Scale (finding #57).** Jira loads the whole attachment set, force-degrades to list view ' +
    'over 150, and hard-caps at 2,000 per item — load-all-then-degrade. We deviate to the ' +
    'house discipline: a **cursor-paged read (take 50) + "Show more (N)"** in the panel ' +
    "(justification: strictly bounded reads everywhere; Jira's own cap+degrade is the same " +
    'pressure handled worse). The upload-count cap is not replicated (no use case at team scale; ' +
    'the page size bounds the read regardless).\n\n' +
    '**Lifecycle (the part 2.3.7 deferred).** Editor uploads at create-modal time happen before ' +
    'the issue exists, so rows start unlinked; a cancelled modal strands them; and no delete path ' +
    'exists at all today. This story owns the whole lifecycle: **link-on-write** — on every ' +
    'description/explanation (and 5.1 comment-body) write, parse the referenced blob URLs and ' +
    "link those rows to the issue as `source: 'editor'`, unlinking rows no longer referenced — " +
    '**delete with blob cleanup** (row in the tx, blob best-effort after commit with the GC as ' +
    'backstop), and the **orphan-GC job** on the 1.6 harness (unlinked rows older than a safety ' +
    'window → blob + row removed; also the backstop for blobs whose delete-after-commit failed). ' +
    'Issue deletion sets `workItemId` null (SetNull, NOT cascade — a cascade would vaporise rows ' +
    'and strand their blobs invisibly; the GC sweeps the nulled rows instead).\n\n' +
    '**Access-control decision (recorded honestly).** Jira serves attachments authenticated. Our ' +
    "shipped storage layer (rung 2) is Vercel Blob `access: 'public'` + `addRandomSuffix` — " +
    'public-but-unguessable URLs, the exact shape Jira\'s own JSM offers as its "unguessable ' +
    'links" mode. Kept for this story: the markdown-embed render path depends on direct URLs and ' +
    'the storage layer has no private serving. The management API (list/link/delete) is fully ' +
    'workspace- and role-gated. An authed download proxy / private storage is the named **Epic-8 ' +
    'hardening extension**, not silently dropped.\n\n' +
    '**Completeness — the real-product states.** Uploading (per-file progress + the multi-file ' +
    'queue), upload errors inline (413 / 415 / 429 — the typed errors 2.3.7 already returns), ' +
    'empty ("No attachments yet" + the affordance), loading skeleton, `ErrorState`, the ' +
    'editor-sourced indicator + disabled-delete tooltip, the delete confirm ("can\'t be ' +
    'restored" — the hard-delete truth), viewer read-only (no upload/delete affordances), and ' +
    'drag-over highlight on the dropzone. All drawn by 5.2.4, asserted in 5.2.8.\n\n' +
    '**Out of scope (documented extension slots, each justified):** authed/private attachment ' +
    'serving (Epic-8 hardening — storage-layer dependent); a dedicated attach field in the ' +
    'create modal (files already attach at create via the editor path + link-on-write; a ' +
    'dropzone there is additive UI with no new capability); "Download all" as ZIP (needs a ' +
    'server zipper; no use case at team scale yet); in-preview prev/next navigation ' +
    "(unverified in the mirror itself); Jira's grid view (strip + list is the documented " +
    'primary pair); per-project storage quotas + admin-configurable size limits (Epic 6/8 ' +
    'admin); comment-attachment coupling beyond source-blocking (the eye-icon jump-to-comment ' +
    'is additive). Custom-field file types are Story 5.3 territory.',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (applies the 5.2.1 ' +
    '`workItemId`/`source` migration cleanly; re-run reports "No difference detected" — relations ' +
    'modelled on both sides), `pnpm db:seed`, `pnpm dev`. `BLOB_READ_WRITE_TOKEN` is already ' +
    'provisioned (2.3, done).\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the attachment service extensions ' +
    '(link/list/delete/permissions), the link-on-write parser, and the GC job stays ≥90% ' +
    'per-file branch/fn/line (the coverage gate); new repo methods carry direct ' +
    'empty-input-guard tests.\n' +
    '- **Panel flow:** sign in as `zhuyue@prodect.co` / `!QAZ1qaz`, open an issue → the ' +
    'Attachments panel (matching `design/work-items/attachments.mock.html`). Upload via the ' +
    'Attach button AND by dragging a file onto the panel → cards appear (image thumbnail / ' +
    'file-type glyph, name, date; list view adds size); download works; the count updates.\n' +
    '- **Embeds-are-attachments:** paste an image into the issue description (edit form) and ' +
    'save → the file appears in the panel marked editor-sourced, and its panel delete is ' +
    'disabled with the points-at-source tooltip; remove the embed from the description and ' +
    'save → the row unlinks (GC-eligible), the panel no longer lists it.\n' +
    '- **Permissions:** as the uploader (member) — delete own works (confirm warns "can\'t be ' +
    'restored"; blob + row gone); as another member — no delete affordance on it; as project ' +
    'admin — delete-any works; as a project `viewer` — panel visible, no upload or delete ' +
    'affordances. The revision trail records each add/remove.\n' +
    '- **Preview:** click an image card → the full-screen preview opens (download affordance ' +
    'inside); a PDF previews; a `.zip` card downloads instead of previewing.\n' +
    '- **Scale check (finding #57):** seed an issue with 120+ attachments (the 5.2.8 fixture) → ' +
    'first paint shows 50 + "Show more (N)"; extending appends; the read is cursor-paged, never ' +
    'the full set.\n' +
    '- **Lifecycle/GC:** upload in the create modal, CANCEL the modal → the row is unlinked; ' +
    'run the GC job (Inngest dev) past the safety window → blob + row removed; a ' +
    'failed-blob-delete simulation is swept on the next GC pass.\n' +
    '- `pnpm test:e2e --grep attachments` — Playwright over the real stack: upload → panel → ' +
    'preview → delete journey, the editor-sourced block, the viewer pass, the paged walk.\n' +
    '- **a11y check:** the panel passes the strict axe sweep (cards/list keyboard-reachable, ' +
    'upload affordance labelled, preview modal focus-trapped with Esc/return-focus, ' +
    'source/state conveyed as text not colour alone); colour via `--el-*`, shape via element ' +
    'shape tokens.',
  items: [
    {
      id: '5.2.1',
      title:
        'Schema — `attachment.workItemId` link + `source` + indexes (SetNull lifecycle, relations both sides) + repo methods',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: [],
      descriptionMd:
        'The linking layer 2.3.7 deliberately left out. Schema + migration + repository methods ' +
        'only — no service logic, no UI.\n\n' +
        '**`Attachment` model extensions:** `workItemId` (nullable — rows are born unlinked by ' +
        'the editor-at-create path and audit rows predate the link; **onDelete: SetNull**, NOT ' +
        'cascade: cascading would delete rows and strand their blobs invisibly — the nulled row ' +
        'is what the 5.2.7 GC sweeps) with the two-sided relation (`WorkItem.attachments` ' +
        "back-relation) per the CLAUDE.md FK rule; `source` (`'editor' | 'panel'` — string with " +
        'a CHECK or enum, matching house style) defaulting `editor` for existing rows (every ' +
        'pre-5.2 row came from the editor path); index `[workItemId, createdAt(sort: Desc)]` ' +
        'for the paged panel read. NO `commentId` column — the editor-sourced **block** only ' +
        'needs `source`; the jump-to-exact-comment affordance is the documented extension ' +
        '("no complexity for nothing").\n\n' +
        '**Repository methods** (single-op, writes require `tx`): ' +
        '`listByWorkItem(workItemId, { cursor, take })` + `countByWorkItem`; ' +
        '`findManyByBlobUrls(workspaceId, urls)` (the link-on-write lookup — workspace-scoped ' +
        'so a foreign URL pasted into a body never links a foreign row); ' +
        '`linkToWorkItem(ids, workItemId, source, tx)` / `unlinkFromWorkItem(ids, tx)`; ' +
        '`delete(id, tx)`; `listOrphans({ olderThan, cursor, take })` (unlinked rows for the ' +
        'GC).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `Attachment` gains nullable `workItemId` (SetNull, relation modelled on BOTH sides) ' +
        "+ `source` ('editor'|'panel', existing rows backfilled 'editor') + the " +
        '`[workItemId, createdAt desc]` index; `prisma migrate dev` re-run reports no drift.\n' +
        '- The 2.3.7 upload path is untouched and its tests stay green (rows still insert ' +
        'unlinked; `uploadAttachment` signature unchanged).\n' +
        '- Repo methods listed above exist as single Prisma ops (writes require `tx`); ' +
        '`findManyByBlobUrls` is workspace-scoped; `listOrphans` is cursor-bounded.\n' +
        '- Vitest (real Postgres): SetNull on issue delete verified (row survives unlinked); ' +
        'backfill verified; empty-input guards on every new repo method (the coverage gate).\n\n' +
        '## Context refs\n\n' +
        '- `prisma/schema.prisma` `Attachment` (the 2.3.7 model + its RLS migration) + ' +
        '`WorkItem`; `prodect-core/CLAUDE.md` (FK-as-@relation rule, required-`tx` writes)\n' +
        "- `lib/repositories/attachmentRepository.ts` (2.3.7) — extend, don't fork\n" +
        '- Finding #52 — the reuse contract (rows deliberately unlinked until this story)\n' +
        '- Story 5.2 description — the SetNull-not-cascade lifecycle decision',
    },
    {
      id: '5.2.2',
      title:
        '`attachmentsService` management surface — attach-to-issue, paged list, permission-gated delete w/ blob cleanup + revision trail, routes',
      status: 'planned',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.2.1'],
      descriptionMd:
        'The management half of the service (the upload half is 2.3.7, reused verbatim). Per the ' +
        '4-layer rule: extend `lib/services/attachmentsService.ts`; HTTP-only routes; typed ' +
        'errors in `lib/blob/errors.ts` (extend the 2.3.7 set); DTOs + mappers.\n\n' +
        '**`attachToWorkItem(workItemId, file, ctx)`** — the panel upload: validates the caller ' +
        'can view the issue AND holds a creating role (`admin`/`member`; read-only `viewer` → ' +
        'typed forbidden — Jira\'s "Create attachments" on the 6.4 roles), delegates to the ' +
        '2.3.7 `uploadAttachment` gates (size/MIME/rate — NOT re-implemented), then links the ' +
        "row `source: 'panel'` and writes the work_item_revision attachment-added entry in the " +
        'same tx.\n\n' +
        '**`listForWorkItem(workItemId, { cursor }, ctx)`** — view-gated, cursor-paged (take ' +
        '50, newest first) + `totalCount`; DTO carries id, filename, mime, size, createdAt, ' +
        'uploader (id/name), `source`, `blobUrl`, and `isImage`/`isPdf` flags for the card + ' +
        'preview affordances. Bounded always (finding #57).\n\n' +
        '**`deleteAttachment(id, ctx)`** — the Jira permission split: uploader deletes own; ' +
        'project `admin` + workspace admin/owner delete all; viewer never. **Editor-sourced ' +
        'rows are REJECTED with a typed error** (`AttachmentEditorSourcedError` → 409): the ' +
        'mirror blocks panel-deleting comment/field-sourced files, and the block is what ' +
        'prevents the broken-embed hole. Order of operations: row delete + the revision ' +
        'attachment-removed entry in ONE tx; the **blob delete AFTER commit, best-effort** ' +
        '(a blob-store failure must not un-delete the row; the 5.2.7 GC is the backstop for ' +
        'stranded blobs). Hard delete — no tombstone.\n\n' +
        '**Routes:** `GET/POST /api/work-items/[id]/attachments`, `DELETE ' +
        '/api/attachments/[id]` — parse → one service call → typed-error mapping (403 role / ' +
        '404 cross-workspace per finding #44 / 409 editor-sourced / the 2.3.7 413/415/429 ' +
        'pass-through).\n\n' +
        '## Acceptance criteria\n\n' +
        '- `attachToWorkItem` reuses the 2.3.7 gates (no duplicated validation), links ' +
        "`source: 'panel'`, records the revision entry, and is role-gated (viewer forbidden).\n" +
        '- `listForWorkItem` is cursor-paged + counted, view-gated, cross-workspace → 404; no ' +
        'unbounded read exists.\n' +
        '- `deleteAttachment` enforces own/all per the role matrix, rejects editor-sourced rows ' +
        'with the typed 409, removes row + revision entry transactionally and the blob ' +
        'post-commit best-effort; a simulated blob failure leaves the row deleted and the blob ' +
        'GC-sweepable.\n' +
        '- Both History entries (added/removed) appear in the revision trail with actor + ' +
        'filename (covers editor-sourced adds too via 5.2.3 — the trail is uniform).\n' +
        '- Routes are HTTP-only; `pnpm test:coverage` ≥90% on the touched service/repo files.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/attachmentsService.ts` + `lib/blob/allowlist.ts` + `lib/blob/errors.ts` ' +
        '(2.3.7 — the primitive + typed-error vocabulary to extend)\n' +
        '- `lib/services/assignableMembersService.ts` + the 6.4 role checks (the same gating ' +
        '5.1.2 uses); finding #44 (404-not-403)\n' +
        '- `lib/services/workItemRevisionsService.ts` (1.4.6) — the History entries\n' +
        '- The verified Jira contract in the Story 5.2 description (three permissions; ' +
        'editor-sourced block; hard delete)',
    },
    {
      id: '5.2.3',
      title:
        'Link-on-write — parse referenced blob URLs in description/explanation + 5.1 comment bodies; link/unlink attachment rows (`source: editor`)',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 26,
      dependsOn: ['5.2.1', '5.1.2'],
      descriptionMd:
        'The embeds-ARE-attachments rule, server-side. Editor uploads write unlinked rows ' +
        '(create modal: the issue does not exist yet), so linkage happens at BODY-WRITE time — ' +
        "the same parse-on-write pattern as 5.1's mentions.\n\n" +
        '**Shared helper** (`lib/blob/referencedUrls.ts`): extract our blob URLs from a ' +
        'Markdown body (image embeds + file links; match on the blob-host + the ' +
        '`attachments/<workspaceId>/` pathname prefix so only OUR uploads qualify — a pasted ' +
        'foreign URL never links anything; workspace-scoped lookup via ' +
        '`findManyByBlobUrls`).\n\n' +
        "**Wire into the write paths** (inside each owning service's existing transaction):\n" +
        '- `workItemsService.createWorkItem` / `updateWorkItem` — on a description/explanation ' +
        "write, diff referenced URLs against the issue's currently-linked editor-sourced rows: " +
        "newly-referenced rows link (`source: 'editor'`, + the revision attachment-added " +
        "entry — uniform History, the fill of Jira's documented editor-add changelog gap); " +
        'no-longer-referenced editor-sourced rows **unlink** (revision attachment-removed ' +
        'entry; the row goes GC-eligible — the Jira analogue: deleting the comment removes the ' +
        'attachment from the work item). Panel-sourced rows are NEVER touched by body diffs.\n' +
        '- `commentsService.addComment` / `editComment` / `deleteComment` (5.1.2) — comment ' +
        "bodies get the same parse: add/edit links newly-referenced rows to the COMMENT's " +
        'work item; a comment delete (incl. thread cascade) unlinks the rows its bodies ' +
        'referenced (unless another body on the same issue still references the URL — the ' +
        'diff is per-issue across the bodies that reference it; keep the check bounded: ' +
        "match against the issue's linked editor rows only).\n\n" +
        '**Idempotent + bounded:** re-saving an unchanged body is a no-op; the parse is ' +
        'per-write over ONE body + one bounded `findManyByBlobUrls` lookup — never a scan of ' +
        'the attachment table.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Creating an issue whose description embeds an upload links that row ' +
        "(`source: 'editor'`, workItemId set) in the create transaction; cancelling the modal " +
        'leaves the row unlinked (GC-eligible, 5.2.7).\n' +
        '- Editing a body links newly-referenced rows and unlinks de-referenced editor-sourced ' +
        'rows, each with the matching revision entry; panel-sourced rows are untouched; ' +
        're-saving unchanged is a no-op.\n' +
        '- Comment add/edit/delete (5.1.2) round-trips the same linkage incl. the ' +
        'still-referenced-elsewhere guard; a foreign/random URL in a body never links or ' +
        'unlinks anything (workspace + pathname-prefix scoped).\n' +
        "- All linkage happens inside the owning service's existing transaction (one method = " +
        'one tx); `pnpm test:coverage` ≥90% on the helper + touched paths.\n\n' +
        '## Context refs\n\n' +
        '- `lib/blob/uploader.ts` (2.3.7 — the pathname structure `attachments/<workspaceId>/` ' +
        'the matcher keys on) + `lib/blob/uploadClient.ts` (what the editor inserts)\n' +
        '- `workItemsService` create/update (the description write paths); `commentsService` ' +
        '(5.1.2) — the comment write paths\n' +
        '- `lib/mentions/parse.ts` (5.1.2) — the sibling parse-on-write pattern to mirror\n' +
        '- The Jira coupling contract (embeds are attachments; comment delete removes them) in ' +
        'the Story 5.2 description',
    },
    {
      id: '5.2.4',
      title:
        'Design — attachments panel + preview (`design/work-items/attachments.mock.html`: strip/list views, upload affordances, editor-sourced block, lightbox)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      dependsOn: [],
      descriptionMd:
        'The design asset the panel (5.2.5) and preview (5.2.6) build against. NO attachment ' +
        'surface is designed anywhere — `detail.pen` has no attachments section (the detail ' +
        'page reserves the Epic-5 slot in a code comment only). Under the design gate that is ' +
        'the NONE-exists case, so this subtask produces the asset FIRST (mirrors 5.1.3 and the ' +
        'prior HTML-mockup design subtasks). Output: ' +
        '**`design/work-items/attachments.mock.html`** (built from `components/ui/*` + ' +
        '`--el-*` + element-shape tokens) + a PNG export + a new section in ' +
        '`design/work-items/design-notes.md`. Passes the render checklist; AA-safe; light + ' +
        'dark parity. Mirror: the Jira Cloud attachments panel (strip/list views, verified at ' +
        'plan time).\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **Placement** — a left-column `ContentSectionCard` ("Attachments" + count + the ' +
        'view toggle + the Attach button in the header), between Relationships and Activity ' +
        '(content-width, multi-row — the rail is for scalars; same argument as 2.4.5).\n' +
        '- **Strip view** — thumbnail cards: image preview (cover-fit) or the file-type glyph ' +
        '(by MIME family) on a `--el-surface-soft` tile, filename (truncating, full on title), ' +
        'date; hover/focus reveals per-card download + delete icon buttons. **Editor-sourced ' +
        'cards** carry a small source indicator and their delete affordance is disabled with ' +
        'the points-at-source tooltip ("Added in the description — remove it there"). Cards ' +
        'whose delete the caller lacks (not uploader, not admin) simply omit the control.\n' +
        '- **List view** — the same rows densified: glyph · name · size · date · uploader · ' +
        'actions; the toggle is a small segmented/menu control in the header (mirror the ' +
        'shipped view-switcher grammar from `list.mock.html`).\n' +
        '- **Upload affordances** — the header **Attach** button (file picker, multi-select) ' +
        'AND the whole-panel **dropzone** (drag-over highlight state: dashed `--el-accent` ' +
        'border + tint); the **uploading** state (per-file progress card with name + ' +
        'indeterminate/percent bar + cancel); inline upload errors (the 2.3.7 typed trio — too ' +
        'large / unsupported type / rate-limited) as a rose-tint AA banner (the 2.4.9 error ' +
        'grammar).\n' +
        '- **Pagination** — "Show more (N)" at the strip/list end (finding #57); the loading ' +
        'skeleton; the empty state ("No attachments yet" + Attach affordance, never blank); ' +
        '`ErrorState`.\n' +
        '- **Delete confirm** — popover naming the file ("Delete <name>? Attachments can\'t be ' +
        'restored." — the hard-delete truth; `--el-danger` confirm + ghost cancel, the 2.4.9 ' +
        'remove grammar).\n' +
        '- **Preview lightbox (for 5.2.6)** — a full-screen `Modal` over a focused attachment: ' +
        'image centered (contain-fit, dark scrim) or PDF in an embedded frame; header bar with ' +
        'filename + size, a Download button, and the close ×; non-previewable types never ' +
        'open it (the card downloads instead). No prev/next navigation (unverified in the ' +
        'mirror — documented out).\n' +
        '- **Viewer (read-only)** — panel + preview visible; no Attach, no delete, no ' +
        'dropzone.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/work-items/attachments.mock.html` + PNG + the design-notes section exist; ' +
        'composed from the shipped primitives + `--el-*`/element-shape tokens only; render ' +
        'checklist + AA + dark parity pass.\n' +
        '- Panels cover: placement, strip + list views with the toggle, per-card actions incl. ' +
        'the editor-sourced disabled-delete + tooltip, both upload affordances + uploading ' +
        'progress + the three inline errors, "Show more (N)" + skeleton + empty + error, the ' +
        'delete confirm, the preview lightbox (image AND pdf variants), and the viewer state.\n' +
        '- `design-notes.md` names the composing primitives + copy strings, the file-type ' +
        'glyph mapping (by MIME family), records "no prev/next in preview" and the ' +
        'public-unguessable-URL serving decision as documented slots, and states the panel is ' +
        'paged (50/“Show more”) not load-all.\n' +
        '- No improvised primitive; any new `--el-*`/shape token need is recorded for 5.2.5/6.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/design-notes.md` + `detail.pen` (placement context; the section ' +
        'card grammar) + `list.mock.html` (the view-switcher + row grammar to reuse)\n' +
        '- `components/ui/*` (`ContentSectionCard`, `Modal`, `Button`, `Pill`, `EmptyState`, ' +
        '`ErrorState`) + the 2.4.9 confirm/error grammar\n' +
        '- `lib/blob/allowlist.ts` — the MIME families the glyph map covers\n' +
        '- The verified Jira panel behaviours in the Story 5.2 description; findings #35/#54; ' +
        'the design-mockup render checklist',
    },
    {
      id: '5.2.5',
      title:
        'Attachments panel UI on the issue detail page — strip/list, upload (button + drag-drop), download, gated delete, "Show more" paging',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.2.2', '5.2.4'],
      descriptionMd:
        'The management surface: an `AttachmentsPanel` in ' +
        "`app/(authed)/issues/[key]/_components/`, mounted in the detail page's reserved " +
        'Epic-5 slot (between Relationships and Activity per the 5.2.4 design). Built on the ' +
        '5.2.2 service routes; design-gated by 5.2.4.\n\n' +
        '**Build:** the section card (count + view toggle + Attach button); strip and list ' +
        "views per the design (the toggle persisted like 5.1.5's sort preference); per-card " +
        'download (direct blob URL) + delete (confirm popover; hidden without permission; ' +
        'disabled + tooltip on editor-sourced); the whole-panel dropzone + multi-file picker ' +
        'feeding `POST /api/work-items/[id]/attachments` with per-file progress + inline typed ' +
        'errors (413/415/429 mapped to the localized messages `lib/blob/uploadClient.ts` ' +
        'already owns — reuse, don\'t fork); "Show more (N)" driving the cursor read; ' +
        'skeleton / empty / error states; viewer read-only. Mutations via Server Actions / ' +
        'route calls + `router.refresh()` (the shipped detail-page pattern). Image thumbnails ' +
        'render from the blob URL (unguessable-public — the recorded serving decision); ' +
        "non-images get the MIME-family glyph from the design's map.\n\n" +
        '**A11y:** cards/rows keyboard-reachable with text-conveyed state (source, ' +
        'permissions); the dropzone is an enhancement over the always-present labelled Attach ' +
        'button (drag-only upload would be a keyboard hole); confirm popover focus-managed; ' +
        'extends the detail-route strict axe sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The panel matches `attachments.mock.html` panel-for-panel (strip + list + toggle, ' +
        'card anatomy, editor-sourced indicator + disabled delete + tooltip, upload progress, ' +
        'inline errors, "Show more (N)", skeleton/empty/error, delete confirm, viewer ' +
        'read-only).\n' +
        '- Upload works via button AND drag-drop (multi-file, per-file progress + per-file ' +
        'error isolation); a viewer sees neither affordance; delete honours the role matrix ' +
        'and the editor-sourced block end-to-end.\n' +
        '- The list is paged (50 + Show-more, no scroll-position loss); an issue with 120+ ' +
        'attachments never triggers an unbounded read.\n' +
        '- Colour/shape only through `--el-*`/element tokens; the strict axe sweep over the ' +
        'detail route with a populated panel stays clean.\n' +
        '- Component/integration tests: role-matrix rendering, paging, upload error mapping, ' +
        'editor-sourced block; existing detail E2E stays green.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/attachments.mock.html` + design-notes (5.2.4) — THE layout ' +
        'authority\n' +
        '- 5.2.2 routes/DTOs; `lib/blob/uploadClient.ts` (error-message mapping to reuse)\n' +
        '- `app/(authed)/issues/[key]/page.tsx` + `_components/` (the reserved slot, ' +
        '`ContentSectionCard`, the Server-Action + refresh pattern)\n' +
        '- 5.1.5 (the sibling section that lands beside it — coordinate placement order if ' +
        'both are in flight); finding #57',
    },
    {
      id: '5.2.6',
      title:
        'Preview lightbox — full-screen image/PDF preview modal from a panel card (download inside; non-previewable types download)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['5.2.4', '5.2.5'],
      descriptionMd:
        'The preview affordance: clicking an image or PDF card opens a full-screen lightbox ' +
        '(the Jira behaviour — verified: images + PDF preview, other types download). A ' +
        'reusable `AttachmentPreview` composed on the `Modal` primitive per the 5.2.4 design: ' +
        'dark-scrim full-screen panel, header (filename + size + Download + close ×), the ' +
        'image contain-fit centered, the PDF in an embedded frame (`<object>`/`<iframe>` over ' +
        "the blob URL with a download fallback message when the browser can't inline it). " +
        'Non-previewable cards never open it — their click/activation downloads (5.2.5 wires ' +
        "the split via the DTO's `isImage`/`isPdf` flags). NO prev/next navigation " +
        '(unverified in the mirror; documented out in 5.2.4).\n\n' +
        '**A11y:** the full Modal contract — focus trap, Esc closes, focus returns to the ' +
        'opening card; the dialog is labelled by the filename; the image carries the filename ' +
        'as alt; preview state conveyed as text in the header (name + size), not implied by ' +
        'imagery alone.\n\n' +
        '## Acceptance criteria\n\n' +
        '- An image card opens the lightbox (contain-fit, header with name/size/Download/×); a ' +
        'PDF previews in-frame with the fallback message path; a `.zip`/doc card downloads ' +
        'instead of opening; all matching the 5.2.4 mockup.\n' +
        '- Focus trap + Esc + return-focus verified; labelled dialog; axe-clean inside the ' +
        'open modal.\n' +
        '- Reuses `Modal` (adding a full-screen size token per the growth pattern only if the ' +
        'design notes call for it); colour/shape through the token tiers; no new primitive ' +
        'beyond the composed preview.\n' +
        '- Component tests cover the three type branches (image / pdf / download-only) and ' +
        'the keyboard path.\n\n' +
        '## Context refs\n\n' +
        '- `design/work-items/attachments.mock.html` (5.2.4) — the lightbox panels\n' +
        '- `components/ui/Modal.tsx` (focus-trap/Esc/return-focus contract; the 2.5.19 ' +
        'size-token growth precedent)\n' +
        '- 5.2.5 (the card click wiring + DTO flags)\n' +
        '- The verified Jira preview contract (images+PDF only; no guaranteed prev/next) in ' +
        'the Story 5.2 description',
    },
    {
      id: '5.2.7',
      title:
        'Orphan-GC job — scheduled sweep of unlinked attachment rows past the safety window (blob + row), the blob-failure backstop',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 24,
      dependsOn: ['5.2.1'],
      descriptionMd:
        'The lifecycle backstop. Unlinked rows accumulate by design: create-modal uploads ' +
        'whose modal was cancelled, embeds removed from bodies (5.2.3 unlinks), issue ' +
        'deletions (5.2.1 SetNull), and best-effort blob deletes that failed (5.2.2). A real ' +
        'product does not leak storage forever (the stub\'s "workspace-scoped access" + ' +
        'finding #57 discipline applied to storage).\n\n' +
        '**Job** (`lib/jobs/definitions/attachmentGc.ts`, the 1.6 `defineJob` harness on a ' +
        'cron schedule like `dailyHealthCheck`): page through `listOrphans({ olderThan: 7 ' +
        'days })` (the safety window — long enough that an in-flight create/edit never loses ' +
        'its upload; constant, admin-configurable is Epic-8), and per row delete the blob ' +
        'then the row (blob first — if the blob delete fails the row survives for the next ' +
        'pass; the inverse strands the blob unfindably). Cursor-bounded batches per run (e.g. ' +
        '200) so a backlog never produces an unbounded run; idempotent (a re-run after ' +
        'partial failure converges); per-run summary logged through the JobRun ledger. NOT ' +
        'swept: linked rows, and orphans younger than the window. (Blobs with NO row — e.g. ' +
        "workspace-cascade deletions — are out of this job's reach; recorded as the known " +
        'Epic-8 hardening extension: a prefix-listing sweep against the blob store.)\n\n' +
        '## Acceptance criteria\n\n' +
        '- The scheduled job exists on the 1.6 harness (cron, workspace-nullable system ' +
        'scope), sweeps unlinked rows older than the window in bounded cursor batches, ' +
        'deleting blob-then-row; younger orphans and linked rows are never touched.\n' +
        '- A failed blob delete leaves the row for the next pass (verified via a stubbed blob ' +
        "error); re-runs are idempotent; the JobRun ledger records each run's summary " +
        '(scanned/deleted counts).\n' +
        '- The 5.2.2 post-commit blob-failure case is demonstrably swept by the next GC pass ' +
        '(the backstop contract).\n' +
        '- `@inngest/test` coverage of the batch/window/failure paths; `pnpm test:coverage` ' +
        'holds the gate; the known no-row-blob limitation is documented in the job header + ' +
        'design-notes.\n\n' +
        '## Context refs\n\n' +
        '- `lib/jobs/defineJob.ts` + `definitions/dailyHealthCheck.ts` (1.6 — the scheduled ' +
        'system-job exemplar) + the JobRun/DLQ ledger\n' +
        '- `lib/blob/uploader.ts` (the blob delete API) + `attachmentRepository.listOrphans` ' +
        '(5.2.1)\n' +
        '- The lifecycle decisions (SetNull, best-effort-after-commit, 7-day window) in the ' +
        'Story 5.2 description',
    },
    {
      id: '5.2.8',
      title:
        'Story tests — Vitest lifecycle/permission matrix + Playwright E2E (upload→panel→preview→delete, editor-sourced block, paged walk) + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.2.3', '5.2.5', '5.2.6'],
      descriptionMd:
        'The story-closing verification (Principle #18): the end-to-end journey + the ' +
        "cross-cutting assertions the per-subtask tests don't own. (Epic-wide journeys stay " +
        'Story 5.6; this is the 5.2-scoped story E2E, the 5.1.7 split.)\n\n' +
        '**Vitest (integration, real Postgres):** the full lifecycle walk — upload (panel + ' +
        'editor paths) → link states → body-edit relink/unlink → delete (role matrix × ' +
        'own/all × editor-sourced block) → GC sweep of the strays — asserting row/blob/' +
        'revision-trail state at each step; the cross-workspace 404; the still-referenced-' +
        'elsewhere guard from 5.2.3.\n\n' +
        '**Playwright E2E (`tests/e2e/attachments.spec.ts`):** as the PM — Attach two files ' +
        '(an image + a zip) via the button → cards render (thumbnail vs glyph) and the count ' +
        'updates; drag-drop a PDF → progress → card; click the image → lightbox (Esc returns ' +
        'focus) → Download visible; click the zip → downloads, no modal; paste an image into ' +
        'the description (edit form) → it appears editor-sourced with disabled delete + ' +
        'tooltip; delete the zip (confirm warns unrestorable) → gone + History entry. ' +
        '**At-scale fixture** (120+ attachments): first paint 50 + "Show more (N)", extend ' +
        'appends, list/strip toggle holds, no unbounded request. **Role pass:** member ' +
        'deletes own only; viewer sees no upload/delete. Run against the standing dev-server ' +
        'harness (OOM-safe reuse pattern).\n\n' +
        '**Strict a11y sweep:** the detail route with a populated panel + the open lightbox ' +
        'passes the strict axe config (extends the 2.4.6/5.1.7 sweep scope).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Vitest lifecycle + permission matrix covers every cell named above; ' +
        '`pnpm test:coverage` keeps all 5.2 files ≥90% branch/fn/line.\n' +
        '- `attachments.spec.ts` passes the full journey + the scale walk + the role pass ' +
        "green in CI's Playwright lane (uploads use small fixture files; the blob store is " +
        'the provisioned dev/CI token).\n' +
        '- The strict axe sweep (panel populated + lightbox open) reports zero violations.\n' +
        '- The Story 5.2 verification recipe runs clean top to bottom; shared-DB flake ' +
        'isolation respected.\n\n' +
        '## Context refs\n\n' +
        "- `tests/attachments/attachments-service.test.ts` (2.3.7) — extend, don't fork; " +
        '`tests/e2e/issue-detail-flow.spec.ts` + `_helpers/` conventions\n' +
        '- The 5.1.7 story-test shape (the sibling split between story E2E and Epic story ' +
        '5.6)\n' +
        '- The E2E harness memories (standing dev server + inngest stub; Playwright upload ' +
        'fixtures); the strict-a11y sweep config\n' +
        '- The Story 5.2 verification recipe — the checklist this subtask automates',
    },
  ],
};
