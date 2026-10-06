// The page editor's OWN rules (Story MOTIR-5752 · MOTIR-7275).
//
// The body is styled by the shipped `.motir-prose` rules
// (`components/ui/markdown-editor.css`), which the host loads — the package
// cannot import an app file. What follows is only what a PAGE changes or adds,
// per `design/pages/design-notes.md` § _The body_:
//
//  • links take `--el-link`, not the description editor's `--el-highlight`
//    (about 2.6:1 on the white page — under AA, and a page is mostly read);
//  • blockquotes take `--el-text-secondary`, so a quote stays AA on any surface;
//  • an image is a block at full column width, `--radius-control`;
//  • a table scrolls inside its own wrapper rather than escaping the column, and
//    a selected cell carries the 2px inset `--el-highlight` ring;
//  • the empty body shows its placeholder in `--el-text-muted`, which the notes
//    allow only as placeholder ink directly on the white page.
//
//  • the work-item mention (MOTIR-7574, § _Mention a work item_): the typed
//    `@query` keeps the description editor's `--el-tint-yellow` mark; a selected
//    chip carries the focus ring; the archived chip's key and title are lifted
//    from the shipped muted / faint to `--el-text-secondary` (AA); and the
//    unavailable chip — deleted or hidden, drawn the same — is `.is-deleted`'s
//    shape (no border, no fill, struck through, not a link) in
//    `--el-text-secondary`. The live chip itself is the shipped `.wi-chip`.
//
// It is rendered as a React 19 hoisted `<style href precedence>`, so it is
// unlayered like the shipped stylesheet and each rule is scoped one class
// deeper (`.motir-page-editor .motir-prose …`), which is what lets it win.
// Colour is `--el-*` only; shape is the element shape tokens only.

export const PAGE_EDITOR_CSS = `
.motir-page-editor .motir-prose a { color: var(--el-link); }
.motir-page-editor .motir-prose blockquote { color: var(--el-text-secondary); }
.motir-page-editor .motir-prose img { display: block; max-width: 100%; border-radius: var(--radius-control); }
.motir-page-editor .motir-prose .tableWrapper { overflow-x: auto; }
.motir-page-editor .motir-prose .selectedCell { box-shadow: inset 0 0 0 2px var(--el-highlight); }
.motir-page-editor .motir-prose p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: var(--el-text-muted);
}
.motir-page-editor .motir-prose .suggestion {
  background: var(--el-tint-yellow);
  border-radius: var(--radius-kbd);
  padding: 0 1px;
  color: var(--el-text);
}
.motir-page-editor .motir-prose .motir-wi-mention.ProseMirror-selectednode {
  outline: var(--focus-ring-width) solid var(--focus-ring-color);
  outline-offset: 1px;
  border-radius: var(--radius-control);
}
.motir-page-editor .motir-prose .wi-chip.is-archived,
.motir-page-editor .motir-prose .wi-chip.is-archived .wi-key,
.motir-page-editor .motir-prose .wi-chip.is-archived .wi-title { color: var(--el-text-secondary); }
.motir-page-editor .motir-prose .wi-chip.is-unavailable,
.motir-page-editor .motir-prose .wi-chip.is-unavailable:hover {
  padding-left: 0;
  padding-right: 0;
  border-color: transparent;
  background: transparent;
  color: var(--el-text-secondary);
  text-decoration: line-through;
  cursor: default;
}
.motir-page-editor .motir-prose .wi-chip .wi-label { color: var(--el-text-secondary); text-decoration: line-through; }
`;
