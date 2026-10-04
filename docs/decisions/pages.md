# ADR: Pages — the page model, the package boundary, the stored body, the tree, permissions, versions and limits

- **Status:** Proposed (2026-10-01). Accepted when a person approves this record's decision gate.
  This is a `decision` card: it fixes shapes and ships no behaviour. Nothing here is built by
  this change, and nothing here is a precondition a sibling may assume is present.
- **Epic / Story / Subtask:** Epic **MOTIR-5746** (Pages) · Story **MOTIR-5751** (the
  `@motir/pages` module and its record) · Subtask **MOTIR-5756** (this record).
- **Builds on:** [`app-shell-over-packages.md`](./app-shell-over-packages.md) (the package
  contract this applies, §1 item by item), the shipped `folder` table and `WorkItem.folderId`
  (Epic MOTIR-5307, `prisma/migrations/20260913090000_folder`), the permission catalog
  (`lib/permissions/catalog.ts`, [`permission-inventory.md`](./permission-inventory.md)), the
  role sets (`lib/permissions/builtinRoles.ts`, [`role-model.md`](./role-model.md)), and the
  product's Tiptap 3 editor (`components/ui/MarkdownEditor.tsx`).
- **Consumed by:** MOTIR-5757 (scaffold `packages/pages`) · MOTIR-5758 (the `pages` CI lane) ·
  MOTIR-5759 (the story's vitest gate) · MOTIR-5752 (write a page and read it back: schema,
  adapter, composition root, editor, routes) · MOTIR-5753 (pages in the project tree) ·
  MOTIR-5754 (a page's history) · MOTIR-5755 (archive, delete and restore) · MOTIR-5760 (agents
  read and write a page over the MCP) · and the epics MOTIR-5747 (linking), MOTIR-5748 (agents
  and search), MOTIR-5749 (comments) and MOTIR-5750 (co-editing), through §8.
- **Supersedes / superseded by:** none.
- **Evidence:** every non-requester decision names what Confluence, Plane, Linear and monday do,
  in §9. Those readings are of each product's public API reference or public source, dated
  2026-10-01, and are cited by URL there.

---

## Context

A Motir team writes its specs, runbooks and notes somewhere else today, and loses the link
between the note and the work it describes. Epic MOTIR-5746 puts a page tree inside the
project. Every other pages story, and four later epics, build on four choices that are
expensive to change once a page is stored: **where the code lives**, **what the stored body
is**, **what a page may sit under**, and **who may do what to it**. Settling each piece inside
the card that first needs it is how two cards end up storing the same page two ways. This
record settles them once, before the first page is stored.

The requester's hard requirement is that pages does not make the monolith heavier to
type-check or test. [`app-shell-over-packages.md`](./app-shell-over-packages.md) §1 already
says what a package is. This record applies it to a feature that is born in a package rather
than extracted into one, which is the first time that has happened.

---

## Decision

### §1 — Requester decisions (Yue, 2026-09-19), recorded as decided

These come from the epic and are not re-argued here:

1. **Its own module.** Pages is the workspace package `@motir/pages`, with its own composite
   tsconfig, its own vitest config and its own CI lane that runs only when `packages/pages/**`
   changes.
2. **Project-scoped.** A page lives in one project. There are no workspace-level pages.
3. **Shared folders.** Pages file into the same `folder` rows work items use.
4. **Link, never parent.** A page and a work item may link both ways. Neither ever parents
   the other.
5. **One tree view.** A single project tree view shows folders, pages and work items together.
   _Superseded by [AMENDMENT 1 (2026-10-02)](#amendment-1-2026-10-02--pages-get-their-own-tree-in-pages):
   pages have their own tree in `/pages`, and a combined tree is deferred._
6. **Co-editing later.** Live co-editing is planned, at low priority.
7. **Descriptions stay separate.** Work-item descriptions are not pages, now or later.

### §2 — What the package owns, what the app owns, and the ports between them

**`@motir/pages` (`packages/pages`) owns:**

- **The page model types**: `Page`, `PagePlacement`, `PageVersion`, `PageBody` (the stored
  body and its three derived formats), and the typed refusals listed in §3, §4 and §6.
- **The tree rules**, as pure functions: placement validation, cycle refusal, the depth limit,
  ancestor computation, and fractional position keys (it depends on `fractional-indexing`
  directly, the library `lib/workItems/positioning.ts` wraps today).
- **The document conversions**: Yjs ↔ ProseMirror JSON ↔ markdown ↔ plain text, all headless
  (no DOM), over ONE editor schema.
- **The Tiptap editor schema and the React page editor**, grown from
  `components/ui/MarkdownEditor.tsx`. The editor takes its app wiring (image upload, mention
  search, theme, copy) as props, because that file imports `@/lib/...` today and the package
  may not.
- **Link extraction** from a document (§8.1).
- **The version-coalescing policy** (§6).
- **The save procedure** that applies those rules through the `PageStore` port below.

**The app owns:**

- the Prisma schema and migrations (`page`, `page_version`), RLS, and the tenancy triggers;
- the repositories and the **adapter** that implements `PageStore` over them;
- the services that open the transaction and call the package (`lib/services/pagesService.ts`);
- the routes, Server Actions and MCP tools;
- the permission keys (§5) and their gates in `lib/projects/access.ts`;
- the **composition root**, **`lib/pages/index.ts`**, which is the one app file that names what
  is injected into `@motir/pages`, as `lib/orchestrator/index.ts` is for
  `@motir/orchestrator`. The page editor runs in the browser and cannot import a server file,
  so its props are bound in ONE client host, **`components/pages/PageEditorHost.tsx`**. That
  file is the editor's half of the composition and imports nothing server-only.

**The transaction stays the app's.** `CLAUDE.md`'s four layers still hold: the service opens
`db.$transaction`, builds a `PageStore` bound to that `tx` from single-operation repositories,
and hands it to the package's procedure. The package decides; the app persists. So the package
never sees Prisma, and the app never re-implements a rule.

**The ports, with their methods:**

`PageStore`, built per transaction by `pageStoreFor(tx)` in `lib/pages/index.ts`:

| method                                                                            | does                                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lockPage(pageId)`                                                                | reads one page `FOR UPDATE`, body state included; `null` if absent or out of scope                          |
| `findPage(pageId)`                                                                | reads one page without its body                                                                             |
| `findFolder(folderId)`                                                            | reads a folder's id and project, to validate a placement                                                    |
| `lockSiblings(projectId, parent)`                                                 | locks the sibling set of one parent, the `folderRepository.lockStructure` precedent                         |
| `lastSiblingPosition(projectId, parent)` / `siblingPosition(pageId)`              | read the neighbours a position key is minted between                                                        |
| `findSubtree(pageId)`                                                             | the page and every descendant, with each one's ancestor array                                               |
| `insertPage(row)`                                                                 | creates a page                                                                                              |
| `updateBody(pageId, body)`                                                        | writes the state and the three derived formats together                                                     |
| `updatePlacement(pageId, placement)`                                              | writes parent, folder, position and ancestor array                                                          |
| `updateTitle(pageId, title)`                                                      | renames                                                                                                     |
| `setArchived(pageIds, archivedAt, archiveRootId)`                                 | archives or restores a set                                                                                  |
| `deletePages(pageIds)`                                                            | removes a set permanently                                                                                   |
| `latestVersion(pageId)`                                                           | the newest version row                                                                                      |
| `insertVersion(row)` / `updateVersion(versionId, row)` / `findVersion(versionId)` | version writes and the read a restore needs                                                                 |
| `countVersions(pageId)` / `deleteOldestVersions(pageId, keep)`                    | the retention cap                                                                                           |
| `replaceDerivedLinks(pageId, links)`                                              | rewrites the derived link rows (§8.1), owned by the linking epic until it lands; a no-op adapter until then |

`Clock`: `now(): Date`. Injected so the coalescing window is testable without fake timers.

Editor props, bound in `components/pages/PageEditorHost.tsx`:

| prop                    | does                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `uploadImage(file)`     | stores an image through the existing attachment door and returns its URL |
| `searchMentions(query)` | people and work items for `@` and work-item mentions                     |
| `saveUpdate(update)`    | sends one Yjs update to the save route (§3)                              |
| `messages` / `theme`    | copy and theme, so the package carries no `next-intl` or theme context   |

**No `@/…` import may appear under `packages/pages/src`.** `tests/packages/importDirection.test.ts`
already globs `packages/*`, so it covers the package with no change to the test.

### §3 — Storage: a Yjs document is the body, and three formats are derived from it

- **The canonical body is a Yjs document**, stored as `page.body_state bytea NOT NULL`, the
  encoding of `Y.encodeStateAsUpdate(doc)` (update format v1). The ProseMirror content lives in
  the XML fragment named `default`, the name Tiptap's collaboration extension uses, so the
  co-editing epic binds the same field without a migration.
- **Three formats are derived in the SAME transaction as every save**: `body_json jsonb`
  (ProseMirror JSON), `body_markdown text` and `body_text text` (plain text, for search and
  previews). No derived column is ever written on its own, and nothing reads a derived column
  to produce the canonical one.
- **A save is a Yjs UPDATE, merged on the server.** The editor sends the update it produced.
  The service locks the row (`lockPage`), applies the update to the stored state, recomputes
  the three formats, and writes all four with `updateBody`. Two people who saved the same page
  from stale copies both keep their edits, because applying two Yjs updates in either order
  converges. This is what lets the co-editing epic arrive without a data migration.
- **Every save increments `page.revision`** (an integer, 1 at creation). A writer that replaces
  the whole body rather than merging an update (the markdown write, §8.2) states the revision it
  read, and a stale one is refused with `PageRevisionConflictError` (`PAGE_REVISION_CONFLICT`,
  409). A Yjs update is never refused for staleness, because it merges.
- **A markdown write is the same save.** The package parses the markdown with the page schema,
  turns it into ONE Yjs update that replaces the fragment's content, and the service applies it
  through the path above (§8.2).
- **Images are not in the body.** An image is an attachment; the body holds its URL.
- **The body size limit is 2 MiB (2,097,152 bytes) of `body_state` after the merge.** A save
  that would exceed it is refused with `PageBodyTooLargeError`, code `PAGE_BODY_TOO_LARGE`,
  HTTP **413**, carrying the limit and the size it would have reached. Nothing is written. A
  single save request is also capped at **1 MiB** of update bytes, refused the same way, so
  the cap is checked before any work is done.
- **The conversion libraries** are `yjs` and `y-prosemirror` (fragment ↔ ProseMirror JSON) and
  `prosemirror-markdown` with `markdown-it` (markdown both ways, GFM tables and task lists),
  all over the schema `@tiptap/core`'s `getSchema` derives from the page editor's extensions.
  They are the package's `dependencies`, not the app's.

### §4 — The tree

- **A page's parent is exactly one of: a page, a `folder`, or the project root. Never a work
  item.** Two nullable columns carry it, `page.parent_page_id` and `page.folder_id`, with the
  CHECK **`page_parent_xor_folder`** (`num_nonnulls(parent_page_id, folder_id) <= 1`). Both
  null is the root. This is the `work_item_parent_xor_folder` precedent from MOTIR-5307. There
  is no column that could point at a work item, so "never a work item" is structural, not a
  rule a service remembers.
- **A sub-page sits under its parent page only.** It carries no `folder_id`; it is "in" a folder
  because its topmost ancestor is.
- **Tenancy and cycles are backstopped in the database**, the folder pattern: a trigger keeps
  `parent_page_id` and `folder_id` in the page's own project
  (`trg_page_cotenancy`), and a cycle trigger refuses a page placed under itself or a
  descendant (`trg_page_cycle`). The service refuses both first, under `lockSiblings`, with
  `PageCycleError` (`PAGE_CYCLE`, 422) and `CrossProjectPageParentError`
  (`CROSS_PROJECT_PAGE_PARENT`, 422). RLS is the folder pair: `page_active_workspace` and the
  restrictive `page_project_narrow`.
- **The depth limit is 10 levels of pages.** A root-level page or a page filed in a folder is
  level 1; its sub-page is level 2; a page may not be placed at level 11. Folders do not count,
  because folders have no depth limit today and the limit exists to bound the page walk, not
  the folder walk. A move is checked against the deepest page of the moving subtree. The
  refusal is `PageDepthExceededError` (`PAGE_DEPTH_EXCEEDED`, 422, carrying the limit).
- **Ancestor data for breadcrumbs is stored**: `page.ancestor_page_ids text[]`, the page ids
  root-first, excluding the page itself. It is written on create, and rewritten for the page
  and its whole subtree in the same transaction as a move. The depth limit is a CHECK on it
  (`cardinality(ancestor_page_ids) < 10`). The folder part of a breadcrumb is read at render
  from the topmost page's `folder_id` and the folder chain, as the shipped folder breadcrumb
  reads it, because folders carry no ancestor array.
- **Order within a level.** Pages carry `page.position`, a fractional key among the pages that
  share their parent. The page tree lives in the Pages section, `/pages`, and a level there
  shows its **folders first** (the shipped `/items` rule), **then its pages**, each kind in its
  own position order. `/items` is unchanged and shows no pages. A page is reordered among pages,
  not between a folder and a work item. (Rewritten by
  [AMENDMENT 1](#amendment-1-2026-10-02--pages-get-their-own-tree-in-pages); this sentence
  previously described one mixed tree view of three kinds.)
- **Paging per level.** A level's pages are read one parent at a time, ordered by
  `(position, id)`, with a keyset cursor on that pair: **50 per page by default, at most 100**.
  Children are fetched when a node is expanded, never as a whole-project walk.
- **Deleting a folder moves its pages up**, exactly as it already moves its work items and
  child folders (`foldersService.deleteFolder`).

### §5 — Permissions

A new **`page`** domain in `PERMISSION_DOMAINS`, and three keys:

| key               | governs                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **`page:view`**   | reading a page, its tree level and its versions                                                                                    |
| **`page:edit`**   | creating, editing, renaming, moving and reordering a page; restoring a version; archiving a page and restoring it from the archive |
| **`page:delete`** | permanently deleting an archived page and its archived sub-pages                                                                   |

| built-in role | holds                    |
| ------------- | ------------------------ |
| Manager       | all three                |
| Member        | `page:view`, `page:edit` |
| Viewer        | `page:view`              |

- **Archive rides `page:edit`, not `page:delete`.** It is reversible and the restore puts the
  page back, which is the reason MOTIR-3629 split `work_item:archive` out of
  `work_item:delete`. Pages take the split's conclusion without a fourth key: a member may
  tidy the tree and may not destroy it.
- **The project is the ceiling.** Every key is resolved per project through the project's own
  role resolution, and there are no page-level restrictions. A page is visible to exactly
  whoever may read its project and holds `page:view`.
- **So a page in a PUBLIC project is readable by its visitors.** `VISITOR_PERMISSIONS` derives
  from the Viewer set, and the Viewer holds `page:view`. That follows from "the project is the
  ceiling" and is stated here so it is approved, not discovered.
- **Each key lands `enforced`, in the change that first asserts it**, the catalog's own rule
  (`PLANNED_PERMISSIONS` is empty and pinned there): `page:view` and `page:edit` with MOTIR-5752,
  `page:delete` with MOTIR-5755. The predicates are `canViewPages`, `canEditPages` and
  `canDeletePages` in `lib/projects/access.ts`. `page:view` and `page:edit` join
  `CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`) with MOTIR-5760, so a dispatched agent can
  read and write a page; `page:delete` does not.

### §6 — Versions

- **A version is a snapshot**: `page_version` holds the version number, the author, the
  `body_state` and `body_markdown` at that point, `started_at` and `saved_at`, and an optional
  `restored_from_version_id`.
- **The coalescing window is 10 minutes per author.** A save folds into the latest version
  (updating its snapshot and `saved_at`) when that version has the same author and its
  `saved_at` is at most 10 minutes old. Any other save starts a new version. An agent's
  markdown write is a save by the token's user, coalesced the same way.
- **The retention cap is 100 versions per page.** Writing the 101st deletes the oldest, in the
  same transaction. The page's current body is never a version that can be pruned, because it
  lives on `page`.
- **A version may be SEALED or FROZEN** — [AMENDMENT 3](#amendment-3-2026-10-03--two-marks-on-a-version-sealed-and-frozen):
  a sealed version is never extended or pruned, and a page holding a frozen one cannot be
  deleted.
- **Restore creates a new version.** Restoring version N computes one Yjs update that replaces
  the current fragment with version N's content and applies it as a save, then records a new
  version with `restored_from_version_id = N`. The Yjs history is never rewound: a client
  holding newer state must still merge with the restored document.

### §7 — Archive and delete

- **Archive before delete.** Only an archived page can be deleted. There is no one-step delete.
- **Archive takes the sub-tree.** Archiving a page stamps `archived_at` on it and on every
  descendant not already archived, and sets each one's `archive_root_id` to the page that was
  archived. Archived pages leave the tree every list and search.
- **Restore brings back exactly that set** (`archive_root_id` = the restored page). A sub-page
  that was archived on its own earlier keeps its own archive root and stays archived.
- **Where a restore lands:** the page's original parent and position, when that parent still
  exists and is not archived. Otherwise the **nearest surviving ancestor**: the next page up
  `ancestor_page_ids` that exists and is not archived, then the topmost page's folder. The
  project root is used only when none of those survives, never as a shortcut. A folder deleted
  meanwhile has already moved the page up (§4), so its stored placement is still a real one.
  The position is kept when it still sorts among the new siblings, and appended otherwise.
- **Delete is permanent** and takes the same set, versions included. It needs `page:delete`.
  It is refused for a page holding a FROZEN version (AMENDMENT 3).
- [AMENDMENT 2](#amendment-2-2026-10-03--what-7-left-open-about-archive-restore-and-delete) records the
  depth-skip rung, delete's re-homing, root-only restore and delete, and the four refusals.

### §8 — What the other epics consume

1. **The link row (linking epic, MOTIR-5747).** A table `page_work_item_link` with columns
   `id`, `workspace_id`, `project_id`, `page_id`, `work_item_id`, `source`, `created_by_id` and
   `created_at`, where `source` is one of `mention`, `embed` or `manual`, unique on `(page_id, work_item_id, source)`. A page and a
   work item are both in the same project. `mention` and `embed` rows are DERIVED: every save
   runs the package's `extractLinks(body_json)` and `replaceDerivedLinks` rewrites them in the
   same transaction. `manual` rows are written by an explicit action. The table is that epic's
   to create; this record fixes its shape so the save path in MOTIR-5752 has a port to call.
2. **The markdown write path (agents epic and MOTIR-5760).** A markdown body goes through the
   package's `markdownToUpdate(state, markdown)` and then the ordinary save (§3), with the same
   size limit, the same coalescing and the same derived formats. It carries the `revision` it
   read (§3). A read returns `body_markdown`, the latest version's number and author, and the revision.
   There is no second writer of the body.
3. **The comment anchor (comments epic, MOTIR-5749).** An inline comment is anchored by a pair
   of Yjs relative positions (`Y.createRelativePositionFromTypeIndex` on the `default`
   fragment), stored as bytes, plus the quoted text at the time of commenting. A pair that no
   longer resolves to a non-empty range shows the comment as a page-level comment with its
   quote. A page-level comment has no anchor.
4. **The co-editing server (MOTIR-5750) saves through the app's API with each user's own
   credentials.** It holds no database credentials and writes no table. It forwards each
   connected user's updates to the same save route, authenticated as that user, so permissions,
   the size limit, versions and derived formats all run on the one path.

### §9 — Evidence: what the mirror products do, and where this record deviates

| decision                | Confluence                                                                                    | Plane                                                                                                              | Linear                                                                                                      | monday                                                       | this record                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical body          | `storage` (XHTML) and `atlas_doc_format` (ADF JSON) are the REST v2 body representations [C1] | `description_binary` (Yjs) beside `description_json`, `description_html` and `description_stripped` on `Page` [P1] | `DocumentContent.contentState`, a base64 Yjs state update, is canonical; `content` is derived markdown [L1] | a doc is a list of typed blocks, each with JSON content [M1] | Yjs canonical with derived JSON, markdown and text, as Plane and Linear converged on. Confluence's own body change is the cost of picking a format that cannot merge |
| Derived formats on save | n/a (server-side format)                                                                      | the HTML, JSON and stripped text are written beside the binary [P1]                                                | markdown derived from the Yjs state [L1]                                                                    | n/a                                                          | same transaction as the save, so a reader never sees a body and a derived format that disagree                                                                       |
| Tree                    | a page has `parentId` and `parentType` and an integer `position` [C1]                         | `Page.parent` is a self-FK, ordered by a float `sort_order` [P1]                                                   | documents are not nested                                                                                    | docs sit in workspace folders [M1]                           | Confluence's page tree under Motir's existing folders. Deviation: a fractional key instead of an integer or float position, the key every Motir tree already uses    |
| Depth limit             | none documented                                                                               | none in the model [P1]                                                                                             | n/a                                                                                                         | n/a                                                          | 10 page levels, because the ancestor array and the move rewrite are bounded by it                                                                                    |
| Permissions             | space permissions plus page restrictions                                                      | `Page.access` public or private per page [P1]                                                                      | team-scoped                                                                                                 | board and doc permissions                                    | project is the ceiling, no page-level restriction (requester's scope). Deviation from Confluence and Plane is deliberate                                             |
| Versions                | a `version.number` per publish, with author and `minorEdit` [C1]                              | one `PageVersion` per owner per 10 minutes (`PAGE_VERSION_TASK_TIMEOUT = 600`), oldest deleted past 20 [P2]        | document history                                                                                            | version history per doc                                      | Plane's per-author 10-minute window. Deviation: a cap of 100, not 20, because a page here is a long-lived spec and 20 ten-minute sessions is an afternoon            |
| Archive and delete      | pages are archived or trashed, then purged                                                    | `Page.archived_at` [P1]                                                                                            | archive and trash                                                                                           | archive and delete                                           | archive the sub-tree, restore it together, delete only from the archive                                                                                              |
| Co-editing saves        | n/a                                                                                           | the `live` server (Hocuspocus) saves through Plane's API [P3]                                                      | n/a                                                                                                         | n/a                                                          | the same shape: no database access for the collaboration server                                                                                                      |

Sources, read 2026-10-01:

- [C1] Confluence Cloud REST API v2, page group:
  <https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/>
- [P1] Plane, `apps/api/plane/db/models/page.py`:
  <https://github.com/makeplane/plane/blob/preview/apps/api/plane/db/models/page.py>
- [P2] Plane, `apps/api/plane/bgtasks/page_version_task.py`:
  <https://github.com/makeplane/plane/blob/preview/apps/api/plane/bgtasks/page_version_task.py>
- [P3] Plane, `apps/live`: <https://github.com/makeplane/plane/tree/preview/apps/live>
- [L1] Linear GraphQL schema, `DocumentContent`:
  <https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference>
- [M1] monday.com API, docs and blocks:
  <https://developer.monday.com/api-reference/reference/blocks>

Rows marked "n/a" are where the product has no equivalent; "none documented" means the
reference read names no limit, not that none exists.

### AMENDMENT 1 (2026-10-02) — Pages get their own tree in `/pages`

- **Decided by:** Yue, 2026-10-02. Recorded by MOTIR-7366.
- **Supersedes:** MOTIR-5753's earlier scope (_"page rows beside folders and work items in
  `/items`"_) and MOTIR-5746's "One tree view" requester-decision bullet (§1 item 5).
- **Consumed by:** MOTIR-5753 (pages in the project tree) · MOTIR-5755 (archive, delete and
  restore) · MOTIR-5760 (agents read and write a page over the MCP).
- **Amends:** the ordering sentence in §4 _Order within a level_, and the Consequences entry
  for MOTIR-5753. Every other §4 rule stands word for word: the parent kinds, the depth limit
  of 10, the stored `ancestor_page_ids`, fractional positions, keyset paging (50 / 100) and a
  folder delete moving pages up.

**What the requester said.** Yue refused the `/items` placement in the first design of
MOTIR-7271: _"wrong design, pages should not be in /items, it should have its own page"_. Then
clarified: _"page will have its own nav item in the sidebar, but pages and items share the same
folder system — that's the same 'tree' about. but we don't need to show them in the same tree
yet"_. The approved, redrawn design records both quotes in `design/pages/design-notes.md`
§"This is a REDRAW, and it follows a refusal", and the planning conversation for MOTIR-5753
re-confirmed that the tree lives in `/pages`.

**The decision.** Pages are organised in their **own tree in the Pages section (`/pages`)**,
not in the work-item tree in `/items`. Pages and work items **share one folder system**: a page
files into the same `folder` rows a work item does, and deleting a folder moves both up. But
each surface shows its own kind. `/pages` shows folders and pages; `/items` keeps showing
folders and work items, unchanged. One combined tree showing all three kinds together is **not
planned now**. A page's parent is still a page, a folder or the root and never a work item, and
a work item is never parented by a page.

**What this changes, and what it does not.**

- The page tree lives in `/pages`: folders and pages, sub-pages up to 10 levels of pages,
  filing into the project's shared folders, moving and reordering with fractional positions,
  stored ancestors for the breadcrumb, and a sidebar tree on the page route.
- `/items` shows no pages. A combined three-kind tree is deferred, and no card plans it.
- Unchanged from the 2026-09-19 decisions: no workspace-level pages; a page and a work item may
  link both ways and never parent each other; co-editing comes later, at low priority;
  work-item descriptions stay separate.

**What this amendment does NOT decide.**

- **The design of the `/pages` tree, its rows or its sidebar tree.** That is MOTIR-5753's
  design card.
- **Whether, when or how a combined tree is ever built.** It is deferred, not designed and not
  ruled out.
- **Any change to the data model.** The columns, CHECKs, triggers and limits of §4 are the same
  for a `/pages` tree as for the mixed one; nothing here adds or removes a column.
- **How a folder that holds only pages, or only work items, shows on the other surface.**
  That is a tree-view question for MOTIR-5753.

### AMENDMENT 2 (2026-10-03) — What §7 left open about archive, restore and delete

- **Decided by:** MOTIR-7418 (Story MOTIR-5755), building `packages/pages/src/archive.ts`.
- **Amends:** §7 _Archive and delete_. Every §7 rule stands; this records the four things it did
  not say and the package now does.

1. **A landing rung that would pass the depth limit is skipped as if it did not survive.** The
   ladder is: the original parent (page, folder, or the project root where the page was); the
   nearest page up `ancestor_page_ids` that exists and is live; the topmost ancestor's folder
   (the page's own when it has no ancestors), when that folder exists; the project root. A rung
   under a page is evaluated against that page's CURRENT chain, and is skipped when the restored
   subtree's deepest page would land past `PAGE_DEPTH_LIMIT`. The project root always fits.
   _Assumption, not observed in practice:_ the move procedure counts archived descendants in a
   subtree's height, so the depth skip is a backstop for a chain changed by something other than
   the procedures.
2. **Delete re-homes a separately-archived descendant.** A sub-page archived on its own before
   its ancestor is not in the ancestor's set, but it is still a descendant, and
   `parent_page_id NO ACTION` would refuse deleting its parent. So before the one-statement
   delete, the topmost page of each such group moves to the deleted root's own place — its parent
   page or folder, and its position — with its chain rebased, and stays archived. Its own restore
   later starts its ladder there.
3. **Restore and delete are root-only.** Either on an archived page that is not its archive's
   root is refused with `PAGE_ARCHIVE_ROOT_REQUIRED` (409), carrying the root's id: a sub-page
   that left with its parent comes back, or goes, with that parent.
4. **The four refusals.** `PAGE_ARCHIVED` (409): a save, rename, move, version restore or second
   archive of an archived page. `PAGE_NOT_ARCHIVED` (409): a restore, or a delete ("archive it
   first"), of a live page. `PAGE_ARCHIVE_ROOT_REQUIRED` (409), above. `PAGE_PARENT_ARCHIVED`
   (422, a tree refusal): a create or a move under an archived page. An archived page is also no
   neighbour for a move — it has left its level.

**Position on restore.** On the original level a page keeps its stored `position` unless a LIVE
sibling now holds that exact key — a create while it was archived can mint the same key, since
the level reads see live pages only — and then goes last; on every other rung it goes last. The
port gained `positionTaken(projectId, parent, position)` for that check, beside §2's
`setArchived` / `deletePages` and the set read `findArchiveSet`.

**A folder delete carries archived pages up, at their own positions** (MOTIR-7420, the
repository). The folder's LIVE filed pages are what the delete counts, shows and mints new
positions for; its archived filed pages move to the same destination in the same `UPDATE`
(`pageRepository.moveFiledPages`), keeping their stored `position` — they are in no level, and
a restore re-checks the key with `positionTaken`. Leaving them behind would fail the delete on
`page.folder_id NO ACTION`, and §7's "a folder deleted meanwhile has already moved the page up"
depends on it.

### AMENDMENT 3 (2026-10-03) — Two marks on a version: SEALED and FROZEN

- **Decided by:** MOTIR-7427 (Story MOTIR-5761, _Decisions become pages_), for
  `approval-gates.md` §8's NINTH AMENDMENT.
- **Amends:** §6 _Versions_ (the coalescing window, the retention cap, restore) and §7 _Archive and
  delete_ (what a delete must check). Every §6 and §7 rule stands for an unmarked version.

A decision can now be a page: an agent publishes a page version to a decision work item, and a
person approves it. An approval must keep meaning what the person read, and a version as §6
defines it cannot promise that — a same-author save within 10 minutes rewrites it in place, and
the cap deletes the oldest past 100. So a version can carry two marks.

1. **SEALED** — `page_version.sealed_at`, set by `publish_decision_page`, in the publish's
   transaction, on the version that is latest at that moment.
   - **A save never extends a sealed version.** §6's coalescing rule gains a fourth condition:
     the latest version must not be sealed. A save after a publish therefore starts version
     `latest.number + 1`, whoever saves and however soon.
   - **The cap never deletes a sealed version.**
   - A seal is set once and never cleared. It keeps nothing else alive: a sealed version may
     still be deleted with its page.
2. **FROZEN** — `page_version.frozen_at` and `page_version.frozen_by_gate_id`, set by the gate
   that approved it (a `decision_approval` Approve, or a `decision_confirmation` Confirm), in
   that gate's deciding transaction. A frozen version is always sealed first.
   - **Never extended, never pruned** — everything a seal forbids.
   - **Its page cannot be hard-deleted while it holds one.** The refusal is the domain's:
     `assertPageDeletable` in `@motir/pages` refuses by name (`PAGE_HOLDS_FROZEN_VERSION`, 409),
     and §7's delete calls it for every page in the set before the one-statement delete.
     Archiving is unaffected: an archived page keeps its versions, and the approval with them.
   - Only an approval freezes. **Request changes** and **Overturn** freeze nothing.
3. **Why the delete refusal is not a database trigger.** A project or workspace delete
   cascades through `page_version`, and must not be refused by a page's approval history: the
   tenant owns its data, and deleting a project is a decision about all of it. A trigger cannot
   tell a page delete from a cascade it is part of. The domain call can, because it is made
   only by the page delete.
4. **The cap counts every version but deletes only unmarked ones.** Writing a version past
   `PAGE_VERSION_CAP` deletes the oldest UNMARKED versions until the page holds 100, or until
   only marked versions remain. **So a page may hold more than 100 versions when more than 100
   of them are marked**, and that is correct: each marked version is a decision somebody made.
5. **Restore makes a NEW version, which carries no marks.** Restoring a frozen version copies its
   content into a new version (§6), with `restored_from_version_id` naming it. The frozen
   version itself is untouched, and the new one is not approved by anyone.

**What this does NOT decide.** Page ↔ work-item mention links (MOTIR-5747); archive and delete
themselves (§7, AMENDMENT 2); migrating historical `docs/decisions/` files into pages; read-only
pages — the page stays editable, and only the approved version is fixed. Which gate kinds may
freeze, and when, is `approval-gates.md` §8's NINTH AMENDMENT.

---

## Consequences

- **MOTIR-5757 scaffolds against §2**: the barrel exports the model types and the pure tree
  rules; the conversions, editor and save procedure arrive with MOTIR-5752.
- **MOTIR-5752 is the first migration**: `page` with the columns of §3 and §4, its CHECKs,
  triggers and RLS, and `lib/pages/index.ts`. It is also the first `bytea` column in the
  schema.
- **MOTIR-5753 builds the page tree in `/pages`** (AMENDMENT 1): a level holds folders, then
  pages; the `/items` tree view does not change.
  `foldersService.deleteFolder` gains pages in the set it moves up.
- **The package's dependencies grow** by `yjs`, `y-prosemirror`, `prosemirror-markdown`,
  `markdown-it` and the Tiptap packages the editor already uses. None of them enter the app's
  own dependency list for this reason.
- **Every number here is a constant in the package** (`PAGE_DEPTH_LIMIT = 10`,
  `PAGE_BODY_MAX_BYTES = 2_097_152`, `PAGE_SAVE_MAX_BYTES = 1_048_576`,
  `PAGE_VERSION_WINDOW_MS = 600_000`, `PAGE_VERSION_CAP = 100`, `PAGE_LEVEL_PAGE_SIZE = 50`,
  `PAGE_LEVEL_PAGE_SIZE_MAX = 100`), so a change to one is a one-line change with a test.

---

## What this does NOT decide

- **The design of any page surface.** The editor chrome, the tree row, the history list and the
  restore flow are each story's design card.
- **The REST API shape and the MCP tool arguments.** §8.2 fixes the write PATH; the doors are
  MOTIR-5760's and MOTIR-5748's.
- **Search.** `body_text` exists so search has something to index; how pages are indexed and
  ranked is MOTIR-5748's.
- **The co-editing server's hosting, presence or cursor protocol.** §8.4 fixes only how it saves.
- **Page templates, blog posts, workspace-level pages, moving a page between projects, and
  page-level restrictions.** The epic rules all of them out, and nothing here reopens them.
- ~~**Anything about the decision gate.** Whether it ever resolves a page is MOTIR-5748's question
  (its story MOTIR-5761); this record changes nothing about how decisions are gated today.~~
  **AMENDED (MOTIR-7427, 2026-10-03):** the decision gate now resolves a page —
  `approval-gates.md` §8's NINTH AMENDMENT. This record decides only the two marks a version can
  carry (AMENDMENT 3); how a gate raises, routes and decides stays that record's.
