# Pages — design notes

**Story MOTIR-5752 · design subtask MOTIR-7271.** The project's **Pages** section: a primary rail row,
the `/pages` index with **New page**, and the page at its own address, `/pages/<id>`, in every state
the story ships — fresh, being written, saved / saving / offline, refused as too large, read-only,
loading and not found.

| Surface                 | Asset             | States | Gates                                               |
| ----------------------- | ----------------- | ------ | --------------------------------------------------- |
| The rail row and index  | `pages.mock.html` | 1–5    | MOTIR-7300 (section, rail row, ⌘K, index, New page) |
| The page at its address | `page.mock.html`  | 6–12   | MOTIR-7275 (editor, toolbar, indicator), MOTIR-7280 |

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
