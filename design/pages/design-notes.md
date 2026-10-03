# Pages — design notes

**Story MOTIR-5752 · design subtask MOTIR-7271.** The project's **Pages** section: a primary rail row,
the `/pages` index with **New page**, and the page at its own address, `/pages/<id>`, in every state
the story ships — fresh, being written, saved / saving / offline, refused as too large, read-only,
loading and not found.

| Surface                 | Asset                     | States | Gates                                                 |
| ----------------------- | ------------------------- | ------ | ----------------------------------------------------- |
| The rail row and index  | `pages.mock.html`         | 1–5    | MOTIR-7300 (section, rail row, ⌘K, index, New page)   |
| The page at its address | `page.mock.html`          | 6–12   | MOTIR-7275 (editor, toolbar, indicator), MOTIR-7280   |
| A page’s history        | `page--history.mock.html` | 1–14   | MOTIR-5754 (History control, panel, compare, restore) |

## ⚠️ This is a REDRAW, and it follows a refusal

The first version of this card put **New page** in the `/items` toolbar and page rows in the work-item
tree. **Yue refused it on 2026-10-02**: _"wrong design, pages should not be in /items, it should have
its own page"_, then clarified: _"page will have its own nav item in the sidebar, but pages and items
share the same folder system — that's the same 'tree' about. but we don't need to show them in the
same tree yet"_.

So, binding on everything below and on the cards it gates:

- **Nothing is added to `/items`.** No toolbar button, no page rows, no filter. The work-item tree is
  untouched by this story.
- **Pages have their own section**: a primary rail row and their own index.
- **Pages and work items share the project's folder system** (a page can be filed in a folder,
  `page.folder_id`), but showing them in one tree is the next story, **MOTIR-5753**. Here a page is
  reached from the flat `/pages` index or by its address.

The area is new (`design/pages/` did not exist), so these are full mocks, not delta mocks.

## Conventions both assets follow

- **Colour** is `--el-*` only; **shape** is the element shape tokens (`--radius-*`, `--spacing-*`,
  `--height-*`, `--shadow-*`). The token block is copied from `packages/design-system/theme.css` and
  the Tier-3 layer is declared on every `[data-theme]` scope, so a nested dark board really is dark.
- **Ink.** Every secondary line is `--el-text-secondary` (AA on every surface in both themes).
  `--el-text-muted` appears only as placeholder ink directly on the white page (the title placeholder
  and the body placeholder). `--el-text-faint` is not used.
- **Every state is drawn in light and dark.** zh boards: panel 1 (dark), 2 (dark), 3 (light, viewer),
  6, 7, 8, 9 and 12 (dark).
- **Page content is the writer's and is never translated** — a zh board shows English page titles
  beside zh chrome, and the index carries one page titled in Chinese.
- **The rail** is `components/ui/Sidebar`'s expanded row grammar in `SidebarNav.tsx`'s real order.
  Panel 1 draws all fifteen rows; every other board draws the first five and an elided line.

---

## The ACCESS PATH (state 1)

### Position — directly after Work Items

The primary section becomes: Workbench · Work Items · **Pages** · Ready · Runs · My agents · Boards ·
Roadmap · Plans · Backlog · Dashboard · Triage · Reports · Approval records · Codebase.

- **Work Items are the work; Pages are what is written about it.** They are the only two surfaces that
  will share the project's folder system (MOTIR-5753 puts them in one tree), so they sit together.
- **It sits above the run surfaces, not among them.** Ready → Runs → My agents is a sequence ("Ready is
  where you dispatch, Runs is where you watch", then your own agents). Putting Pages anywhere inside it
  would break a run of rows that reads as one flow.
- **It is a primary row** because every top-level project view is one — the convention
  `SidebarNav.tsx` records in a comment on each row, and the one `design/runs/design-notes.md` §
  "The ACCESS PATH" applied to Runs.
- `tests/components/SidebarNav-primary-order.test.tsx` asserts the order; MOTIR-7300 updates it.

### Glyph — `NotebookText`

- **Unused anywhere in the app** (`git grep NotebookText` finds nothing).
- **Not `FileText`**, the obvious first choice: it is already the **`content` work-item type** glyph
  (`lib/issues/workItemTypeMeta.ts`) and the plan-page destination tag
  (`components/planning/PlanDestinationTag.tsx`). Once pages and work items share one tree, a page row
  drawn with the content-type glyph would read as a content-type work item.
- **Not a peer's glyph**: House (Workbench), CircleDot (Work Items), CirclePlay (Ready), Waypoints
  (Runs), SquareTerminal (My agents), Columns3 (Boards), Map (Roadmap), Sparkles (Plans), LayoutList
  (Backlog), LayoutDashboard (Dashboard), Inbox (Triage), BarChart3 (Reports), Stamp (Approval
  records), Code (Codebase), History (Resume onboarding), Settings. **Not `BookOpen`** — the Help
  menu's Docs. **Not `NotebookPen`** — the AI planning settings use it.
- The row comment MOTIR-7300 writes should say all of this, the way every peer's comment does.

### The nav-access row

`lib/settings/projectNavAccess.ts` gains:

```ts
{
  href: '/pages',
  requires: 'page:view',
  evidence:
    'MOTIR-7277: every `pagesService` read asserts `page:view`; the page and the index answer ' +
    '`notFound()` to a reader without it (`docs/decisions/pages.md`).',
},
```

Without the row, `canOfferNavDestination` answers **false** and the rail silently drops the entry.
A reader **without `page:view`** gets **no Pages row**; the rows below close up and nothing marks the
gap (no disabled row — panel 1, third rail). The ⌘K "Go to" list reads the same map, so it offers
**Pages** under the same rule and the same label key.

### Active state

`isActive(pathname, '/pages')` is a prefix test, so the row is active on `/pages` **and** on every
`/pages/<id>` — drawn in panel 1 (second rail) and on every board of `page.mock.html`.

| Element        | Primitive                | Colour / shape                                                                                                               |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Row, resting   | `Sidebar` row (expanded) | ink `--el-text-secondary`, glyph `--el-icon-muted` 18px · `h-(--height-control)` · `--radius-control`                        |
| Row, active    | `Sidebar` row, `active`  | bg `--el-sidebar-item-bg-active`, border `--el-sidebar-border`, `--shadow-subtle`, ink `--el-text`, glyph `--el-icon-active` |
| Review outline | board annotation only    | `--el-highlight` dashed outline — **not shipped**                                                                            |

| Key               | en    | zh   |
| ----------------- | ----- | ---- |
| `shell.nav.pages` | Pages | 页面 |

(The rail's keys live under `shell.nav.*` — `shell.nav.runs`, `shell.nav.myAgents`. The permission
catalog already carries the domain label `page` → "Pages" / "页面".)

---

## The index — `/pages` (states 2–5)

### Composition

- **Header** — every authed page's `<h1 class="font-serif text-2xl font-semibold">` (`--el-text`) and
  subtitle `<p class="text-sm">` (`--el-text-secondary`); **New page** at the header's trailing end,
  `Button` `variant="primary"` (`--el-accent` fill, `--el-accent-text` ink, `--radius-btn`,
  `--height-btn-md`, `--spacing-btn-x`) with a `Plus` glyph.
- **List** — a `<ul aria-label>` inside a Card frame (`--el-card`, `--el-border`, `--radius-card`), soft
  rules between rows (`--el-border-soft`). Each row is **one link** to `/pages/<id>`, padded
  `10px var(--spacing-card-padding)`:
  - `NotebookText` 18px, `--el-icon-muted`, decorative;
  - the **title**, 14px medium `--el-text`, one line, truncated with an ellipsis (the page's own heading
    carries the full title);
  - **untitled**: the copy _Untitled_, italic, `--el-text-secondary` — a blank page is still a findable
    row;
  - the **meta line**, 12.5px `--el-text-secondary`: _Edited {time} by {name}_, or _by you_ when the
    last editor is the reader. `{time}` is the app's relative-time formatter (`Intl.RelativeTimeFormat`
    in the active locale).
  - **hover**: the row takes `--el-surface-soft`; both inks clear AA on it (drawn on row 3).
- **Order**: newest edit first (`updated_at DESC`). **Flat** — no tree, no folders, no sub-pages
  (MOTIR-5753).
- **Data**: `PageSummaryDto` carries `updatedAt` but not who edited. MOTIR-7300 adds the last editor's
  display name (`page.updated_by_id` → `User.name`) to the summary.
- **Paging** is not drawn. If MOTIR-7300 pages the read, it uses the shipped "Show more" below the list
  at `PAGE_LEVEL_PAGE_SIZE` (50).

### New page

Pressing **New page** sends `POST /api/pages` (an empty page at the project root) and moves the browser
to `/pages/<id>`, where the title has focus (state 6). **No dialog and no title prompt** — the page
itself asks for its title first. While the POST is in flight the button is disabled and shows the
spinner with _Creating page…_ (panel 2, below the list). A failure is a `Toast` and the button returns.

### State 3 — empty

The design system's `EmptyState` (a Card: `NotebookText` 48px in `--el-icon-muted`, serif title in
`--el-text`, description in `--el-text-subtitle`). Member: the action is **New page** (primary) and the
header keeps its own New page too. Viewer: **no action anywhere**; the description says who writes
pages, so the empty room does not read as broken.

### State 4 — viewer, populated

Identical list and row links; the header has no button. Nothing is drawn disabled — a disabled button
is a promise the product then refuses. A viewer opens each page read-only (state 10).

### State 5 — loading

`PageSkeleton` **with a real header** (the heading, subtitle and — for a member — New page are known
before the read: static strings and a permission the gate has already resolved). The body is five
row-shaped `Block`s (`--el-muted`, `--radius-control`): an 18px glyph block, a title bar, a meta bar,
inside the same Card frame, so the list settles with no vertical shift. Mounted as an in-page
`<Suspense>` **after** the gate — never a `loading.tsx` (both page routes call `notFound()`;
`design/shell/design-notes.md` § The navigation-pending grammar). Announced once via the existing
`shell.pageLoading`; the blocks are `aria-hidden`.

### Copy — the index

| Key                          | en                                                                                                   | zh                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pages.index.title`          | Pages                                                                                                | 页面                                                                     |
| `pages.index.subtitle`       | Specs, runbooks and notes for this project — most recently edited first.                             | 此项目的规格说明、运行手册和笔记——最近编辑的排在最前。                   |
| `pages.index.newPage`        | New page                                                                                             | 新建页面                                                                 |
| `pages.index.creating`       | Creating page…                                                                                       | 正在创建页面…                                                            |
| `pages.index.createFailed`   | Couldn’t create the page. Try again.                                                                 | 无法创建页面，请重试。                                                   |
| `pages.index.listLabel`      | Pages in this project                                                                                | 此项目中的页面                                                           |
| `pages.untitled`             | Untitled                                                                                             | 无标题                                                                   |
| `pages.index.edited`         | Edited {time} by {name}                                                                              | {name}于{time}编辑                                                       |
| `pages.index.editedByYou`    | Edited {time} by you                                                                                 | 你于{time}编辑                                                           |
| `pages.index.empty.title`    | No pages yet                                                                                         | 还没有页面                                                               |
| `pages.index.empty.member`   | Write down a spec, a runbook or the notes from a meeting — it stays here, beside the project’s work. | 写下规格说明、运行手册或会议记录——它们会留在这里，与项目的工作放在一起。 |
| `pages.index.empty.viewer`   | When someone in this project writes a page, it appears here.                                         | 当项目成员写下页面后，它会显示在这里。                                   |
| `shell.pageLoading` (exists) | Loading page                                                                                         | 页面加载中                                                               |

`pages.untitled` is shared by the index row, the title placeholder and the browser tab of an untitled
page.

---

## The page — `/pages/<id>` (states 6–12)

### Layout

A reading column (`max-width: 760px`) inside `<main>`:

1. **"← Pages"** — the way back (below);
2. **the title** — a field for a writer, a plain `<h1>` for a viewer, at the same size and place;
3. **the toolbar** — sticky, with the **save indicator** at its trailing end (writer only);
4. **the body** — the Tiptap document, styled by the shipped `.motir-prose` rules.

### The way back — "← Pages" above the title

Drawn, not left to the rail. The rail's Pages row is active on the whole subtree, but the rail is
behind the drawer on a phone, and a reader who finishes a page has their eye at the top of it, not at
the rail. A quiet link — `ArrowLeft` 14px + _Pages_, 13px, `--el-text-secondary` — is enough. It is the
placeholder for the page's breadcrumb, which MOTIR-5753 adds with the tree and which replaces it.

### The title

- **Writer**: an unboxed `<input>` at the page heading's exact size (`font-serif text-2xl
font-semibold`, a 32px line box, `--el-text`), `maxLength={255}` (`PAGE_TITLE_MAX_LENGTH`, so
  `PAGE_TITLE_TOO_LONG` 422 cannot be reached from the UI), placeholder _Untitled_ in
  `--el-text-muted` on the page. Renames go through `PATCH /api/pages/<id>`, debounced like the body,
  and report through the same save indicator.
- **On arrival from New page**, focus is in the title. **Enter** moves focus to the body.
- **Viewer**: a plain `<h1>`, same class, so nothing moves between the two.

### The toolbar — composes `MarkdownEditor.tsx`'s

`components/ui/MarkdownEditor.tsx`'s `Toolbar`, size `full`, **button for button, in its order**:
`role="toolbar"`, `flex flex-wrap items-center gap-0.5 px-1.5 py-1`; each button
`rounded-(--radius-control) p-1.5` with a 16px lucide glyph, `aria-label` = `title` = its label.

| Group (in the shipped file)                                                        | Buttons                                                                                              | Glyph                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Inline marks                                                                       | Bold · Italic · Strikethrough                                                                        | `Bold`, `Italic`, `Strikethrough`   |
| Blocks (`fullExtras`)                                                              | Heading (H2) · Quote · Code block                                                                    | `Heading2`, `Quote`, `Code2`        |
| Lists (`fullExtras`)                                                               | Bulleted list · Numbered list · Task list                                                            | `List`, `ListOrdered`, `ListChecks` |
| Link                                                                               | Link                                                                                                 | `Link`                              |
| **Page adds** (after a hairline)                                                   | **Insert image** · **Insert table**                                                                  | `Image`, `Table`                    |
| **Page adds — table group** (only while the caret is in a table, after a hairline) | **+ Row · + Column · − Row · − Column · Delete table** — text buttons, each with a full `aria-label` | none                                |

What changes from the description editor, and why:

- **Attach file → Insert image.** A page has no attachment list; its images are uploads filed under the
  page (`attachment.page_id`, MOTIR-7279) and inserted as block image nodes. Paste and drop do the same.
- **Tables** are in the page schema and not in the description editor's, so the insert button and the
  table group are new. The table group uses **text** buttons because lucide has no unambiguous glyphs for
  row/column deletion; the labels are short and the `aria-label`s say the whole action.
- **Placement**: on a page the toolbar is a **sticky strip on the canvas** (`--el-page-bg`, top and bottom
  rules in `--el-border`), not the head of a boxed `--el-surface` field — the page _is_ the document.
- **Button ink** is `--el-icon-muted` (the icon role token; same value as the shipped `--el-text-muted`
  on these icon-only buttons). Hover: `--el-surface` fill, `--el-text` glyph.
- The **code block's Language field** is the shipped `markdownEditorCodeBlock.ts` node view and
  `markdown-editor.css` bar: it shows only while the caret is in that block (`data-focused`), label
  `markdownEditor.codeLanguage`, field `--el-page-bg` / `--el-input-border` / `--radius-control` /
  `--height-control`.
- **The page title is not in the toolbar's reach** — it is a separate field, outside the editor.

### The body — every node the schema carries (state 7)

`packages/pages/src/document/extensions.ts`: StarterKit (paragraph, headings 1–3, bold, italic, strike,
inline code, bullet and ordered lists, blockquote, code block with a `language`, horizontal rule, hard
break; no underline, no ProseMirror history), Image (block, no base64), Link (no open on click,
autolink), TaskList / TaskItem (nested), Table / TableRow / TableHeader / TableCell. All are drawn.
Body headings use H2/H3 (the title is the page's H1).

Styled by the shipped `.motir-prose` rules (`components/ui/markdown-editor.css`), with **two
deviations**, both for contrast on a reading surface:

- **Links take `--el-link`**, not `--el-highlight`. The description editor's brand pink is about 2.6:1 on
  the white page — under AA — and a page is mostly read.
- **Blockquotes take `--el-text-secondary`**, not `--el-text-muted`, so a quote stays AA wherever it lands.

The caret-in-a-cell mark is a 2px inset `--el-highlight` ring on the current cell. An image is a block
at full column width, `--radius-control`.

### State 6 — a fresh page

Focus in the empty title (placeholder _Untitled_), the body placeholder, the toolbar, and the indicator
already reading **Saved** — the page exists and is empty. Rail: Pages active.

### State 8 — the save indicator

**Where:** the trailing end of the toolbar (`margin-left: auto`). The toolbar is sticky, so the
indicator is in view wherever the writer is in a long page, at the place their eyes already are. It is a
polite live region (`role="status"`). Chip shape: `--radius-badge`, `--spacing-chip-x/y`, 12.5px, a
14px glyph. **Not rendered for a viewer.**

The behaviour is MOTIR-7275's autosave loop: local-origin Yjs updates are buffered and sent as one merged
update after **1 s of quiet**, capped at **5 s** of continuous typing, **one request in flight**.

| Value (`SaveStatus`) | Drawn as                                                                                                                                                | Means                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saved`              | `Check` + _Saved_, `--el-text-secondary`, no fill                                                                                                       | Nothing is waiting. The resting state, so the quietest.                                                                                                                                                    |
| `saving`             | `LoaderCircle` + _Saving…_, `--el-text-secondary`, no fill                                                                                              | A batch is in flight (or buffered and about to go).                                                                                                                                                        |
| `offline`            | `CloudOff` + _Offline — edits kept_, `--el-warning-surface` fill, `--el-warning-text` ink; tooltip (`Tooltip`, `--el-tooltip-bg/-text`) with the detail | The last save failed for lack of network. Edits stay buffered in the tab and are resent with backoff (2 s → 4 s → 8 s … capped at 30 s) and on the browser's `online` event; the next success reads Saved. |
| `too_large`          | `TriangleAlert` + _Not saved_, `--el-danger-on-surface`, 500                                                                                            | State 9.                                                                                                                                                                                                   |

`offline` is the only value with a fill because it is the only one that asks something of the writer:
the buffer lives in the tab, so the tooltip says to keep the tab open until it reads Saved.

### State 9 — refused as too large

`POST /api/pages/<id>/updates` answers **413** `{ code: 'PAGE_BODY_TOO_LARGE', error, limit, size }` when
the merged body would pass **2 MiB** (`PAGE_BODY_MAX_BYTES`) or one request passes **1 MiB**
(`PAGE_SAVE_MAX_BYTES`); nothing is written either way (`lib/pages/routeErrors.ts`,
`packages/pages/src/errors.ts`). The editor reports `too_large` and **stops sending** (MOTIR-7275) —
it does not resume on its own.

- **The indicator** reads **Not saved** (danger ink).
- **A callout** opens under the toolbar, `role="alert"`: `--el-danger-surface` fill, a 1px `--el-danger`
  border, `TriangleAlert` in `--el-danger-on-surface`, copy in `--el-danger-surface-text`,
  `--radius-card`. It says **what happened** (the edits since the last save are not saved, and nothing
  more will be from this tab) and **what to do**: copy out what to keep and reload to the last saved
  version; to make room, move long sections into a new page or remove large tables and pasted text.
- **The content stays in the editor** (still selectable) so it can be copied.
- **Two secondary buttons** (`Button variant="secondary" size="sm"`): **Reload saved version** (a full
  reload; the body has already said the unsaved edits go) and **New page in a new tab** (creates a page
  and opens it in a new tab, so a section can be pasted across without losing this tab's text). Neither
  is primary: neither is the right next step for every writer.
- The limit is shown as **2 MB** — the unit a writer reads; the constant is 2 MiB.

### State 10 — read-only

The read returns `canEdit: false`; `PageEditor` mounts with `editable: false`: **no toolbar, no save
indicator, no autosave subscription**. The title is a plain `<h1>` at the field's size and place. The
body is the same document, not editable; the code block shows no Language field, because a read-only
document never holds a caret (the block draws only its own frame: `--el-surface`, `--el-border`,
`--radius-input`). No "view only" label is added — the absent toolbar is the signal, and the index has
already said who writes.

### State 11 — loading

**No `loading.tsx`** above `/pages` or `/pages/<id>`: both decide existence (CLAUDE.md § _A
`loading.tsx` may NOT sit above a route that decides existence_). The page resolves the project and the
reader's access, then renders an in-page `<Suspense>` whose fallback is `PageSkeleton`:

- **"← Pages"** is static, so it paints above the boundary;
- the **generic header** pair of bars — the title is not known until the read returns. The page has no
  subtitle, so the settle moves up by the subtitle bar, the upward settle the grammar accepts;
- **paragraph bars** for the body;
- **no toolbar block** — whether there is a toolbar depends on `canEdit`, which the same read answers,
  and a frame must not promise a toolbar a viewer will not get.

Announced once via `shell.pageLoading`; the bars are `aria-hidden`.

### State 12 — not found, deliberately indistinguishable

An unknown id, a page in another project, and a non-member all get the routes' **same bytes**,
`404 { code: 'PAGE_NOT_FOUND', error: 'Page not found.' }` — `pageErrorResponse` maps a browse denial,
`ProjectNotFoundError` and `PageNotFoundError` to one body. The page does the same: it calls
`notFound()` in every case, and the shared **`app/(authed)/not-found.tsx`** boundary renders —
`EmptyState` with `FileQuestion`, `errors.notFound.title` / `.description`, and _Go to work items_. That
is the screen **every** unknown authed address gets, so it does not even confirm the address was a page.
**No page-specific copy is added** — a page-specific message would be the leak. A reader without
`page:view` gets the same screen (and has no Pages row). The rail's Pages row is still active (the path
is under `/pages`).

### Copy — the page

| Key                                        | en                                                                                                                                                                                                                                                                                                                            | zh                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages.page.back`                          | Pages                                                                                                                                                                                                                                                                                                                         | 页面                                                                                                                                                                                                                       |
| `pages.page.backLabel`                     | Back to Pages                                                                                                                                                                                                                                                                                                                 | 返回页面                                                                                                                                                                                                                   |
| `pages.page.titleLabel`                    | Page title                                                                                                                                                                                                                                                                                                                    | 页面标题                                                                                                                                                                                                                   |
| `pages.untitled` (title placeholder)       | Untitled                                                                                                                                                                                                                                                                                                                      | 无标题                                                                                                                                                                                                                     |
| `pages.editor.bodyPlaceholder`             | Start writing. Use the toolbar for headings, lists, tables, code and images.                                                                                                                                                                                                                                                  | 开始写作。使用工具栏添加标题、列表、表格、代码和图片。                                                                                                                                                                     |
| `pages.editor.toolbar.label`               | Formatting                                                                                                                                                                                                                                                                                                                    | 格式                                                                                                                                                                                                                       |
| `pages.editor.toolbar.bold`                | Bold                                                                                                                                                                                                                                                                                                                          | 粗体                                                                                                                                                                                                                       |
| `pages.editor.toolbar.italic`              | Italic                                                                                                                                                                                                                                                                                                                        | 斜体                                                                                                                                                                                                                       |
| `pages.editor.toolbar.strike`              | Strikethrough                                                                                                                                                                                                                                                                                                                 | 删除线                                                                                                                                                                                                                     |
| `pages.editor.toolbar.heading`             | Heading                                                                                                                                                                                                                                                                                                                       | 标题                                                                                                                                                                                                                       |
| `pages.editor.toolbar.quote`               | Quote                                                                                                                                                                                                                                                                                                                         | 引用                                                                                                                                                                                                                       |
| `pages.editor.toolbar.codeBlock`           | Code block                                                                                                                                                                                                                                                                                                                    | 代码块                                                                                                                                                                                                                     |
| `pages.editor.toolbar.bulletList`          | Bulleted list                                                                                                                                                                                                                                                                                                                 | 项目符号列表                                                                                                                                                                                                               |
| `pages.editor.toolbar.orderedList`         | Numbered list                                                                                                                                                                                                                                                                                                                 | 编号列表                                                                                                                                                                                                                   |
| `pages.editor.toolbar.taskList`            | Task list                                                                                                                                                                                                                                                                                                                     | 任务列表                                                                                                                                                                                                                   |
| `pages.editor.toolbar.link`                | Link                                                                                                                                                                                                                                                                                                                          | 链接                                                                                                                                                                                                                       |
| `pages.editor.toolbar.linkPrompt`          | Link URL                                                                                                                                                                                                                                                                                                                      | 链接地址                                                                                                                                                                                                                   |
| `pages.editor.toolbar.image`               | Insert image                                                                                                                                                                                                                                                                                                                  | 插入图片                                                                                                                                                                                                                   |
| `pages.editor.toolbar.table`               | Insert table                                                                                                                                                                                                                                                                                                                  | 插入表格                                                                                                                                                                                                                   |
| `pages.editor.table.addRow`                | + Row (`aria-label`: Add row below)                                                                                                                                                                                                                                                                                           | + 行（`aria-label`：在下方添加行）                                                                                                                                                                                         |
| `pages.editor.table.addColumn`             | + Column (`aria-label`: Add column to the right)                                                                                                                                                                                                                                                                              | + 列（`aria-label`：在右侧添加列）                                                                                                                                                                                         |
| `pages.editor.table.deleteRow`             | − Row (`aria-label`: Delete row)                                                                                                                                                                                                                                                                                              | − 行（`aria-label`：删除行）                                                                                                                                                                                               |
| `pages.editor.table.deleteColumn`          | − Column (`aria-label`: Delete column)                                                                                                                                                                                                                                                                                        | − 列（`aria-label`：删除列）                                                                                                                                                                                               |
| `pages.editor.table.deleteTable`           | Delete table                                                                                                                                                                                                                                                                                                                  | 删除表格                                                                                                                                                                                                                   |
| `markdownEditor.codeLanguage` (exists)     | Language                                                                                                                                                                                                                                                                                                                      | 语言                                                                                                                                                                                                                       |
| `pages.editor.status.saved`                | Saved                                                                                                                                                                                                                                                                                                                         | 已保存                                                                                                                                                                                                                     |
| `pages.editor.status.saving`               | Saving…                                                                                                                                                                                                                                                                                                                       | 正在保存…                                                                                                                                                                                                                  |
| `pages.editor.status.offline`              | Offline — edits kept                                                                                                                                                                                                                                                                                                          | 离线——编辑已保留                                                                                                                                                                                                           |
| `pages.editor.status.offlineDetail`        | Your last save didn’t reach Motir. Your edits are kept in this tab and are sent as soon as you’re back online — keep the tab open until it says Saved.                                                                                                                                                                        | 上次保存未能送达 Motir。你的编辑保留在此标签页中，网络恢复后会立即发送——在显示“已保存”之前请保持此标签页打开。                                                                                                             |
| `pages.editor.status.tooLarge`             | Not saved                                                                                                                                                                                                                                                                                                                     | 未保存                                                                                                                                                                                                                     |
| `pages.editor.tooLarge.title`              | This page is too large to save                                                                                                                                                                                                                                                                                                | 页面过大，无法保存                                                                                                                                                                                                         |
| `pages.editor.tooLarge.body`               | Your edits since the last save would take the page past its 2 MB limit, so they were not saved — and nothing more will be saved from this tab. Copy out anything you want to keep, then reload to go back to the last saved version. To make room, move long sections into a new page or remove large tables and pasted text. | 自上次保存以来的编辑会使页面超过 2 MB 的上限，因此未被保存——此标签页之后的编辑也不会再保存。请先复制需要保留的内容，然后重新加载以回到上次保存的版本。如需腾出空间，可将较长的部分移到新页面，或删除大型表格和粘贴的文本。 |
| `pages.editor.tooLarge.reload`             | Reload saved version                                                                                                                                                                                                                                                                                                          | 重新加载已保存版本                                                                                                                                                                                                         |
| `pages.editor.tooLarge.newPageNewTab`      | New page in a new tab                                                                                                                                                                                                                                                                                                         | 在新标签页中新建页面                                                                                                                                                                                                       |
| `pages.editor.imageUploadFailed`           | Couldn’t upload the image. Try again.                                                                                                                                                                                                                                                                                         | 无法上传图片，请重试。                                                                                                                                                                                                     |
| `shell.pageLoading` (exists)               | Loading page                                                                                                                                                                                                                                                                                                                  | 页面加载中                                                                                                                                                                                                                 |
| `errors.notFound.title` (exists)           | We couldn’t find that page                                                                                                                                                                                                                                                                                                    | 找不到该页面                                                                                                                                                                                                               |
| `errors.notFound.description` (exists)     | The address may be mistyped, or whatever it pointed at may have been deleted — or moved somewhere you can’t reach.                                                                                                                                                                                                            | 地址可能有误，或者它指向的内容已被删除——也可能被移到了你无权访问的位置。                                                                                                                                                   |
| `errors.notFound.workItemsAction` (exists) | Go to work items                                                                                                                                                                                                                                                                                                              | 前往工作项                                                                                                                                                                                                                 |

The `pages.editor.*` strings are the values of MOTIR-7275's `PageEditorMessages` prop: the package
renders no string of its own, and the app supplies en and zh. (The description editor's toolbar labels
are hard-coded English today; the page editor's are not.)

---

## Open questions handed to the cards

- **Leaving with unsent edits.** The offline buffer lives in the tab. MOTIR-7275 carries no leave-page
  guard; the tooltip asks the writer to keep the tab open. A `beforeunload` prompt while the status is
  `saving`, `offline` or `too_large` is the obvious complement and is MOTIR-7280's to decide.
- **Recovering from `too_large` without a reload.** The loop stops for good; trimming the page does not
  restart it. That is MOTIR-7275's stated behaviour and the copy is written to it.

## Not drawn here

- **The page tree, sub-pages, filing into folders, moving and reordering, the breadcrumb** — MOTIR-5753
  (_Pages in the project tree_). The "← Pages" link is the breadcrumb's placeholder.
- **History, versions and restore** — MOTIR-5754.
- **Archive, delete and restore** — MOTIR-5755.
- **Mentions of work items, and the backlinks on a work item** — MOTIR-5747.
- **Co-editing, cursors and presence** — MOTIR-5750. **Page comments** — MOTIR-5749.
- **The mobile drawer** — the rail row is the same row in the drawer variant; nothing else changes.

---

## History (MOTIR-5754 · MOTIR-7381)

**Story MOTIR-5754 · design subtask MOTIR-7381.** Any reader of a page (`page:view`) opens its
**history**: the list of saved versions, each opened on its own beside the current page; an editor
(`page:edit`) restores one. This section **amends** § _The page — `/pages/<id>` (states 6–12)_ above,
drawn in `design/pages/page.mock.html`, by a new delta mock; the approved mock is not edited. It composes
with MOTIR-7367's approved design for the same route (§ _The page tree_, `page--tree-sidebar.mock.html`):
the sidebar tree and the breadcrumb are that design's, drawn here only as context and not redrawn.

| Amends                                                     | By                        | Panels |
| ---------------------------------------------------------- | ------------------------- | ------ |
| § The page — `/pages/<id>` (states 6–12), `page.mock.html` | `page--history.mock.html` | 1–14   |

**References.** Confluence Cloud's page history (a list of versions with author and date; a version opened
on its own; _Restore this version_ makes a copy that becomes current and keeps every earlier one) for the
model. Notion's page-history side panel for the layout: history opens **beside** the page, not on a
separate screen.

**What it rests on** (`docs/decisions/pages.md` §6): a version is a snapshot with a number, an author,
`saved_at` and an optional `restored_from_version_id`; saves by one author within 10 minutes fold into one
version; a page keeps **100** versions (writing the 101st deletes the oldest); **restore creates a new
version** and rewinds nothing. Reading versions needs `page:view`; restoring needs `page:edit`.

### Conventions

The base design's (§ _Conventions both assets follow_): `--el-*` colour only, the element shape tokens,
the Tier-3 layer declared on every `[data-theme]` scope, every state in light and dark, zh on the dark board
of panels 1–6 and 8–14, and **page content never translated**. Every secondary line is
`--el-text-secondary`; `--el-text-muted` and `--el-text-faint` are not used anywhere in the asset.

### The access path — History in the title row (state 1)

- **Where:** the trailing end of the page's **title row**. The breadcrumb (MOTIR-7367) stays above the
  title; the title keeps the row's leading edge and its `font-serif text-2xl` 32px line box; **History**
  is top-aligned to that line box, so the row's height does not change.
- **What:** `Button variant="secondary" size="sm"` with the lucide **`History`** glyph and a visible label
  _History_. A visible label rather than an icon button, because the glyph alone reads as "recent" or
  "undo" and this is the only door to a feature a viewer has never seen.
- **Why the title row, not the toolbar:** the toolbar is a writer's (it is not rendered for a viewer, base
  state 10). History is every reader's, so it sits where a viewer and a writer both have something: the
  title row. A viewer gets the same control in the same place (state 14).
- **Open:** `aria-expanded="true"`, `aria-controls="page-history"`, and the pressed look —
  `--el-surface` fill, `--el-border-strong` border — while the panel is open. Pressing it again closes
  the panel.
- **The rail and the tree:** unchanged. The rail's Pages row stays active; the tree's selected row stays
  this page.

### The panel — where it opens, how it closes (states 2–6)

- **Wide, ≥ 1440px:** a right-hand column **beside** the page — rail · page tree (248px) · page · history
  (**340px**). It pushes the reading column instead of covering it, so the page stays readable while the
  list is open. `<aside id="page-history" aria-labelledby>`, `--el-page-bg`, a left rule in
  `--el-border`.
- **1280–1439px:** the same column; the **page tree sidebar hides while History is open** and returns
  when it closes. This does **not** write the reader's stored hide/show preference (MOTIR-7367's
  `localStorage` convenience) — it is a layout yield, not a choice.
- **Below 1280px** (where MOTIR-7367 already starts the tree hidden): History opens as an **overlay sheet
  from the right**, 340px, over `--el-overlay-scrim`, with `--shadow-modal` — the mirror of the tree's
  narrow drawer (panel 4, third board). Focus moves into the sheet and is returned to the History control
  on close.
- **Closes by:** the close button (`X` icon button, _Close history_), **Esc** (when no confirm is open; a
  first Esc inside compare closes compare, the next closes the panel), pressing **History** again, the
  scrim (narrow only), and **navigating away** — to another page through the tree or the breadcrumb, or
  anywhere else. The panel does not persist across pages: a page opens with history closed.
- **Head:** the `History` glyph 16px in `--el-text-secondary` + _History_, 14px semibold `--el-text`; the
  close button at its end. A 1px `--el-border` rule under it.

### A version row

One `<button aria-pressed>` per version in an `<ol aria-label="Versions of this page">`, newest first, 8px
list padding, 2px gaps. Padding `--spacing-control-y` / `--spacing-control-x`, `--radius-control`:

1. **Avatar** — 24px circle (`rounded-full`, genuinely circular), the author's initials, 10px bold
   `--el-text-strong` on one of `--el-avatar-lavender` / `-sky` / `-mint` (picked by the user id, the same
   person always the same tint). `aria-hidden`; the name beside it carries the meaning.
2. **Version** — `v{number}`, 13.5px semibold `--el-text`, tabular numerals; its accessible name is
   _Version {number}_.
3. **Current** — on the newest row only: a `Pill`-shaped chip, `--el-tint-lavender` fill,
   `--el-text-strong` ink, `--radius-badge`, `--spacing-chip-x/y`, 11.5px. The row also carries
   `aria-current="true"`. It is never compared and never restored; pressing it closes compare and returns
   to the page.
4. **Time** — at the trailing end of the first line, 12.5px `--el-text-secondary`, a `<time datetime>`
   of `saved_at` with the full timestamp in `title`. **Under 24 hours: relative** (`Intl.RelativeTimeFormat`
   in the active locale: _12 minutes ago_ / _12 分钟前_, _just now_ / _刚刚_ under a minute). **24 hours
   and older: absolute** (`Intl.DateTimeFormat`, medium date + short time: _28 Sep 2026, 11:05_ /
   _2026年9月28日 11:05_). The same formatter the index's _Edited {time}_ uses; no message key.
5. **Author** — the display name on the second line, 13px `--el-text-secondary`; _You_ / _你_ when the
   author is the reader.
6. **Restore line** (restore rows only) — `RotateCcw` 12px + _Restored from v{n}_, 12.5px
   `--el-text-secondary`. When v{n} has been pruned by the 100-version cap, _(no longer kept)_ follows in
   italic — the line still says what happened; it just cannot link to it (panel 5, v71; panel 12, v5).

| Row state | Treatment                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------- |
| resting   | transparent                                                                                    |
| hover     | `--el-surface-soft` (every ink on it is `--el-text` / `--el-text-secondary`, AA)               |
| selected  | `--el-surface` + 1px `--el-border`, `aria-pressed="true"` — the version shown in compare       |
| new       | `--el-tint-mint` for the moment after a restore (state 10), then resting; reduced motion: none |
| focus     | the app's `--focus-ring-color` ring                                                            |

### Loading, one version, Load more, failed (states 2, 3, 5, 6)

- **2 · Loading.** The panel's head paints at once; the list is **six skeleton rows** — a 24px circle and
  two bars (70% / 45%), `--el-muted`, `--radius-control` — `aria-hidden`, with one polite
  _Loading history_ in a `role="status"`. The History control is already pressed.
- **3 · One version.** A page that has only been created: one row, **v1**, **Current**, and a line under
  the list (12.5px `--el-text-secondary`): _This is the only version so far. Each editing session adds
  one._ No Restore exists anywhere — there is nothing to restore to.
- **5 · At the page size.** The service pages versions **50 at a time** (`PAGE_LEVEL_PAGE_SIZE`, the same
  keyset-cursor read as the tree). When there are more, the list ends in **Load more** — `Button
variant="secondary" size="sm"`, full width — which appends the next 50 in place and keeps the
  selection; while it reads, the button shows the spinner. The foot also says _A page keeps its latest
  100 versions._, so a reader looking for something older knows why it is not there. With the 100 cap,
  Load more appears at most once.
- **6 · Load failed.** In place of the list: one inline row, `role="alert"` — `TriangleAlert` 16px in
  `--el-danger-on-surface`, _Couldn't load the history._ in `--el-text`, and **Try again** (secondary, sm).
  The page is untouched. A failed **Load more** puts the same row at the list foot and keeps the rows
  already shown.

### A version shown — before and after (state 7)

Pressing a row that is not Current opens **compare**:

- **The main column splits in two**, under the breadcrumb and title row: the **current page** on the
  left (where it already was — the reader's eye does not have to move to find it) and the **selected
  version** on the right, next to the panel. `role="region"`, _Comparing v{n} with the current page_.
  Each is a card frame (`--el-border`, `--radius-card`); the version's sits on **`--el-surface-soft`** so it
  never reads as the page.
- **Both are read-only**, rendered by the same `.motir-prose` rules as the page (base § _The body_), from
  the version's stored `body_state`. **No character diff** — two documents side by side, as the card asks.
  While compare is open the writer's editor is not mounted; closing compare returns to the editor with
  the caret where it was.
- **The page tree sidebar hides** while compare is open (MOTIR-7367's _Show page tree_ button leads the
  breadcrumb, panel 3 of that mock) and returns when compare closes; the stored preference is not
  written.
- **Current column head:** _Current page_ (13.5px semibold `--el-text`) · _v7_ (`--el-text-secondary`) ·
  for a writer, the **save indicator** (base state 8's chip, unchanged) at its end, because a save can
  still be in flight (state 13).
- **Version column head:** _v{n}_ · avatar + author · time · **Restore this version** (`Button
variant="secondary" size="sm"`, `RotateCcw`) — **editors only, never on the Current row** · a close
  icon button (_Close v{n}_).
- **Closes by:** the close button, **Esc**, pressing the selected row again, or pressing the Current row.
- **Viewer:** the same compare with **no Restore** and no save indicator. Nothing is drawn disabled.

### Restore (states 8–13)

- **8 · Confirm.** `Modal` size sm, `role="alertdialog"`, initial focus on **Cancel**. Title _Restore
  v3?_ (`font-serif text-xl`, `--el-text`); body _The page will show v3's content as a new version.
  Nothing is deleted._ (`--el-text-subtitle`); footer **Cancel** (secondary) and **Restore v3**
  (primary, `RotateCcw`). Esc / Cancel / × close it and nothing changes.
- **9 · Restoring.** The confirm stays open: **Restore v3** shows the spinner and _Restoring…_
  (`aria-busy`), Cancel and × are disabled — a restore cannot be abandoned half way. Behind it the panel is
  **`inert` + `aria-busy`**, with a 2px `--el-accent` indeterminate bar under its head: no row can be
  pressed while the request is in flight. Nothing is dimmed (dimming would lower the inks' contrast).
- **10 · Restored.** The modal and compare close. The page shows **v3's content**, now the body of the new
  version, in the editor (the save indicator reads _Saved_; a client holding newer state merges, ADR §6).
  The panel stays open with the **new row on top** — v8, the restorer, _just now_, **Current**,
  _Restored from v3_, briefly `--el-tint-mint` — and v7 loses its Current chip; **every earlier version is
  still listed**. A success `Toast` (border `--el-success`, `CircleCheck` in `--el-success`, title in
  `--el-text`): _Restored v3 as v8._ The tree sidebar returns.
- **11 · Refused, too large — `413 PAGE_BODY_TOO_LARGE`.** Restoring would take the page past its 2 MB
  limit (`PAGE_BODY_MAX_BYTES`, shown as **2 MB**, as in base state 9). The confirm closes and a **danger
  callout** opens under the version column's head, `role="alert"`: `--el-danger-surface` fill, 1px
  `--el-danger` border, `TriangleAlert` in `--el-danger-on-surface`, text in `--el-danger-surface-text`,
  `--radius-card`. It says what happened and that **nothing was changed**. Restore for that version is
  then disabled and described by the callout (it would fail the same way). No new row; v7 is still Current.
- **12 · Refused, the version is gone — `404 PAGE_VERSION_NOT_FOUND`.** The version was pruned between
  listing and restoring. The confirm and compare close (there is nothing left to show); the page is
  untouched; the panel **re-reads its list** and shows the same danger callout above it: the version is no
  longer kept, a page keeps its latest 100, nothing was changed, the list was refreshed. In the refreshed
  list the pruned rows are gone (pruning takes the oldest first, so in practice this happens only at the
  100-version cap, when other saves push the oldest out while the confirm is open) and any row restored
  from one now reads _(no longer kept)_.
- **13 · Unsaved edits — Restore held.** While the writer's save indicator is anything but **Saved**
  (`saving`, `offline`, `too_large` — `packages/pages/src/editor/SaveIndicator.tsx`'s `SaveStatus`),
  **Restore this version** is disabled and a line under the version's head (12.5px
  `--el-text-secondary`, `TriangleAlert` 14px, `aria-describedby` of the button) says why and when it
  returns: _Restore is held until your edits are saved. It becomes available as soon as the page says
  Saved._ It enables itself the moment the status is `saved`. A restore over a pending save would race
  it — the pending batch would land on top of the restored content. `too_large` never returns to `saved`
  without a reload, so Restore stays held there; base state 9's callout already tells the writer to
  reload.

### State 14 — viewer

`page:view` without `page:edit`: the title is the plain `<h1>`, there is no toolbar and no save indicator,
and **History** is the same control in the same place. The list is identical (the viewer's own versions,
if any, would read _You_). A version opened shows the same compare **with no Restore** (state 7, second
board). Nothing is drawn disabled for a viewer — a disabled control is a promise the product then refuses.

### Colour and shape — per element

| Element                 | Primitive / source                     | Colour                                                                                                          | Shape                                                                    |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| History control         | `Button` secondary sm + `History` 16px | `--el-text`, border `--el-button-border`; open: `--el-surface` fill, `--el-border-strong`                       | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                  |
| Panel                   | `<aside>`                              | `--el-page-bg`, left rule `--el-border`                                                                         | 340px                                                                    |
| Panel head              | heading + icon button                  | title `--el-text`, glyph `--el-text-secondary`; close `--el-text-secondary`, hover `--el-surface` / `--el-text` | close `--height-btn-sm` square, `--radius-control`, `--spacing-icon-btn` |
| Narrow sheet            | the same `<aside>` over the scrim      | `--el-overlay-scrim`                                                                                            | `--shadow-modal`                                                         |
| Version row             | `<button aria-pressed>`                | `--el-text` / `--el-text-secondary`; hover `--el-surface-soft`; selected `--el-surface` + `--el-border`         | `--radius-control`, `--spacing-control-x/y`                              |
| Avatar                  | initials circle                        | `--el-avatar-lavender/-sky/-mint`, ink `--el-text-strong`                                                       | 24px, `rounded-full`                                                     |
| Current chip            | `Pill` shape                           | `--el-tint-lavender`, ink `--el-text-strong`                                                                    | `--radius-badge`, `--spacing-chip-x/y`                                   |
| Restore line            | `RotateCcw` 12px + text                | `--el-text-secondary`                                                                                           | —                                                                        |
| New row (after restore) | the row                                | `--el-tint-mint`                                                                                                | as the row                                                               |
| Skeleton                | `PageSkeleton`'s `Block`               | `--el-muted`                                                                                                    | `--radius-control`; avatar block `rounded-full`                          |
| Load failed             | inline `ErrorState` grammar            | glyph `--el-danger-on-surface`, text `--el-text`; Try again secondary                                           | `--radius-btn`, `--height-btn-sm`                                        |
| Load more               | `Button` secondary sm, full width      | `--el-text`, `--el-button-border`                                                                               | `--radius-btn`, `--height-btn-sm`                                        |
| Busy bar                | 2px bar under the head                 | `--el-accent`                                                                                                   | —                                                                        |
| Compare columns         | card frames                            | current `--el-page-bg`; version `--el-surface-soft`; both `--el-border`                                         | `--radius-card`                                                          |
| Restore this version    | `Button` secondary sm + `RotateCcw`    | `--el-text`, `--el-button-border`; disabled at 50% opacity (the primitive's)                                    | `--radius-btn`, `--height-btn-sm`                                        |
| Hold line               | text + `TriangleAlert` 14px            | `--el-text-secondary` on `--el-surface-soft`                                                                    | —                                                                        |
| Confirm                 | `Modal` sm, `alertdialog`              | `--el-page-bg`, `--el-border`; title `--el-text`, body `--el-text-subtitle`; scrim `--el-overlay-scrim`         | `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`             |
| Restore vN (confirm)    | `Button` primary                       | `--el-accent` / `--el-accent-text`                                                                              | `--radius-btn`, `--height-btn-md`                                        |
| Refusal callout         | base state 9's callout                 | `--el-danger-surface`, border `--el-danger`, glyph `--el-danger-on-surface`, text `--el-danger-surface-text`    | `--radius-card`                                                          |
| Toast                   | `Toast` success                        | `--el-page-bg`, border `--el-success`, glyph `--el-success`, title `--el-text`                                  | `--radius-card`, `--shadow-elevated`                                     |

`--el-danger-text` is not used (no danger fill exists on this surface). The board annotations
(`.ph-panelNote`, `.ph-boardTag`) are `--el-text-secondary` on `--el-surface`.

### Copy — history

New keys live under `pages.history.*`. ICU arguments as in the shipped catalogue (`{number}`, `{from}`).

| Key                              | en                                                                                                                        | zh                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pages.history.open`             | History                                                                                                                   | 历史记录                                                                      |
| `pages.history.title`            | History                                                                                                                   | 历史记录                                                                      |
| `pages.history.close`            | Close history                                                                                                             | 关闭历史记录                                                                  |
| `pages.history.listLabel`        | Versions of this page                                                                                                     | 此页面的版本                                                                  |
| `pages.history.version`          | v{number}                                                                                                                 | v{number}                                                                     |
| `pages.history.versionLabel`     | Version {number}                                                                                                          | 第 {number} 版                                                                |
| `pages.history.current`          | Current                                                                                                                   | 当前                                                                          |
| `pages.history.you`              | You                                                                                                                       | 你                                                                            |
| `pages.history.restoredFrom`     | Restored from v{number}                                                                                                   | 从 v{number} 恢复                                                             |
| `pages.history.noLongerKept`     | (no longer kept)                                                                                                          | （已不再保留）                                                                |
| `pages.history.loading`          | Loading history                                                                                                           | 正在加载历史记录                                                              |
| `pages.history.loadFailed`       | Couldn’t load the history.                                                                                                | 无法加载历史记录。                                                            |
| `pages.history.retry`            | Try again                                                                                                                 | 重试                                                                          |
| `pages.history.loadMore`         | Load more                                                                                                                 | 加载更多                                                                      |
| `pages.history.keepsLatest`      | A page keeps its latest 100 versions.                                                                                     | 页面保留最近的 100 个版本。                                                   |
| `pages.history.onlyVersion`      | This is the only version so far. Each editing session adds one.                                                           | 这是目前唯一的版本。每次编辑会话都会新增一个版本。                            |
| `pages.history.compare.label`    | Comparing v{number} with the current page                                                                                 | 正在将 v{number} 与当前页面对比                                               |
| `pages.history.compare.current`  | Current page                                                                                                              | 当前页面                                                                      |
| `pages.history.compare.close`    | Close v{number}                                                                                                           | 关闭 v{number}                                                                |
| `pages.history.restore`          | Restore this version                                                                                                      | 恢复此版本                                                                    |
| `pages.history.confirm.title`    | Restore v{number}?                                                                                                        | 恢复 v{number}？                                                              |
| `pages.history.confirm.body`     | The page will show v{number}’s content as a new version. Nothing is deleted.                                              | 页面将以新版本的形式显示 v{number} 的内容。不会删除任何内容。                 |
| `pages.history.confirm.action`   | Restore v{number}                                                                                                         | 恢复 v{number}                                                                |
| `pages.history.restoring`        | Restoring…                                                                                                                | 正在恢复…                                                                     |
| `pages.history.restored`         | Restored v{from} as v{number}.                                                                                            | 已将 v{from} 恢复为 v{number}。                                               |
| `pages.history.refusal.tooLarge` | v{number} can’t be restored: the page would pass its 2 MB limit. Nothing was changed.                                     | 无法恢复 v{number}：页面将超过 2 MB 的上限。未做任何更改。                    |
| `pages.history.refusal.gone`     | v{number} is no longer kept — a page keeps its latest 100 versions. Nothing was changed, and the list has been refreshed. | v{number} 已不再保留——页面只保留最近的 100 个版本。未做任何更改，列表已刷新。 |
| `pages.history.unsavedHold`      | Restore is held until your edits are saved. It becomes available as soon as the page says Saved.                          | 在你的编辑保存之前无法恢复。页面显示“已保存”后即可恢复。                      |
| `common.cancel` (exists)         | Cancel                                                                                                                    | 取消                                                                          |
| `common.close` (exists)          | Close                                                                                                                     | 关闭                                                                          |
| `pages.editor.status.*` (exists) | Saved · Saving… · Offline — edits kept · Not saved                                                                        | 已保存 · 正在保存… · 离线——编辑已保留 · 未保存                                |

- **Times carry no key**: relative under 24 hours through `Intl.RelativeTimeFormat`, absolute after
  through `Intl.DateTimeFormat`, both in the active locale (§ _A version row_, item 4).
- `pages.history.unsavedHold` names **Saved** because that is the word the writer's indicator shows
  (`pages.editor.status.saved`); the zh string quotes 已保存 for the same reason. If the indicator's word
  changes, this string changes with it.
- `pages.history.retry` carries the same words as `common.retry`; a builder may reuse `common.retry`
  instead of adding the key — the words are what is specified.
- `{number}` in `pages.history.refusal.*` is the version the reader tried to restore; the 2 MB and 100 are
  written into the copy, as base state 9 writes 2 MB (`PAGE_BODY_MAX_BYTES`, `PAGE_VERSION_CAP`).

### Open questions handed to the cards

- **Esc order.** Drawn as: confirm → compare → panel, one layer per press. If the shell already binds Esc
  for something on this route, that binding wins and this order follows it.
- **The new-row tint** fades after a moment; the duration is the builder's (the toast's own lifetime is a
  fair default), and under `prefers-reduced-motion` the tint simply is not applied.
- **Restoring an agent's version.** An agent's markdown write is a save by the token's user (ADR §6), so
  its row shows that user; nothing marks it as an agent's. If agent authorship should be visible here,
  that is a model change, not a design one.

### Not drawn here

- **A character or block diff** between versions — out of scope by the card; compare is side by side.
- **Naming or pinning a version**, and **deleting a single version** — neither exists in the model.
- **History of an archived page** — MOTIR-5755 (archive and restore of a page).
- **The page tree sidebar and breadcrumb** — MOTIR-7367's, unchanged; drawn only as context.
- **Co-editing while comparing** — MOTIR-5750.
