// The page editor's copy (Story MOTIR-5752 · MOTIR-7275).
//
// ⚠️ THE PACKAGE RENDERS NO STRING OF ITS OWN. Every word `<PageEditor>` puts on
// the screen — a label, a tooltip, a status, the refusal — arrives in this
// object, which the app's host (`components/pages/PageEditorHost.tsx`) fills from
// its `next-intl` catalogue in en and zh. So the package carries no i18n library
// and no locale.
//
// The shape mirrors the keys `design/pages/design-notes.md` § _Copy — the page_
// proposes under `pages.editor.*`: `pages.editor.toolbar.bold` is
// `messages.toolbar.bold`, `pages.editor.status.saved` is `messages.status.saved`.
// Two departures, both because one key in the notes carries two strings:
//
//  • the table group's text buttons each have a short visible label and a full
//    `aria-label` (`+ Row` / `Add row below`), so each key splits into
//    `addRow` + `addRowLabel`;
//  • the code block's Language field reuses the app's existing
//    `markdownEditor.codeLanguage`, which arrives here as `codeLanguage`.
//
// `bodyLabel` is the editing surface's accessible name. The notes give the body
// a placeholder but no name; a `role="textbox"` without one is an axe failure.

/** Every string `<PageEditor>` renders. */
export interface PageEditorMessages {
  /** The editing surface's accessible name (e.g. "Page body"). */
  bodyLabel: string;
  /** `pages.editor.bodyPlaceholder` — shown in an empty body. */
  bodyPlaceholder: string;
  /** `markdownEditor.codeLanguage` — the code block's Language field. */
  codeLanguage: string;
  /** `pages.editor.imageUploadFailed`. */
  imageUploadFailed: string;
  /** `pages.editor.toolbar.*`. */
  toolbar: {
    label: string;
    bold: string;
    italic: string;
    strike: string;
    heading: string;
    quote: string;
    codeBlock: string;
    bulletList: string;
    orderedList: string;
    taskList: string;
    link: string;
    linkPrompt: string;
    image: string;
    table: string;
  };
  /** `pages.editor.table.*` — the group shown while the caret is in a table. */
  table: {
    addRow: string;
    addRowLabel: string;
    addColumn: string;
    addColumnLabel: string;
    deleteRow: string;
    deleteRowLabel: string;
    deleteColumn: string;
    deleteColumnLabel: string;
    deleteTable: string;
  };
  /** `pages.editor.status.*` — the save indicator. */
  status: {
    saved: string;
    saving: string;
    offline: string;
    offlineDetail: string;
    tooLarge: string;
  };
  /** `pages.editor.tooLarge.*` — the refusal callout. */
  tooLarge: {
    title: string;
    body: string;
    reload: string;
    newPageNewTab: string;
  };
  /**
   * `pages.archive.refusal.editingArchived*` — the same callout when the page was
   * archived under this tab (MOTIR-7423). `status.tooLarge` ("Not saved") is the
   * indicator's word for both.
   */
  archived: {
    title: string;
    body: string;
    reload: string;
  };
}
