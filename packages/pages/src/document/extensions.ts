import { Node, mergeAttributes, type Extensions } from '@tiptap/core';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-task-item';
import { TaskList } from '@tiptap/extension-task-list';
import { StarterKit } from '@tiptap/starter-kit';

// The page document's extension list (Story MOTIR-5752 · MOTIR-7272), under
// `docs/decisions/pages.md` §2–§3.
//
// ⚠️ THIS IS THE ONE LIST. The schema the server derives formats from
// (`schema.ts`), the markdown parser and serializer (`markdown.ts`) and the
// editor (MOTIR-7275, which composes this list plus its React-only extensions)
// all read it, so a node the editor can produce is a node the conversions can
// read. It is HEADLESS: nothing here needs a DOM to build a schema.
//
// It mirrors `components/ui/MarkdownEditor.tsx`'s `buildEditorExtensions()` as
// read on `origin/main` — headings 1–3, links that do not open on click, block
// images with no base64 — and adds the table nodes that editor does not carry.
// It cannot import that file: the package may not import `@/…`.

/**
 * The `motir:` href payload — a work-item cuid, non-empty. It is the same
 * character set the app's `WORKITEM_TOKEN_RE` / `WORKITEM_HREF_RE`
 * (`lib/mentions/workItemRefs.ts`) accept, restated because the package may
 * not import the app.
 */
export const WORK_ITEM_MENTION_HREF_RE = /^motir:([A-Za-z0-9_-]+)$/;

/**
 * A MENTION of a work item (Story MOTIR-5747 · MOTIR-7570), the page schema's
 * copy of the description editor's `workItemMention` node
 * (`components/ui/markdownEditorMentions.tsx`): inline, atomic, `id` the work
 * item's cuid and `label` its key when it was inserted. Its markdown is that
 * editor's durable token, `[KEY](motir:<id>)` (`markdown.ts`), so a page body
 * and a description carry mentions the same way, and a body write derives a
 * `mention` link from every one (`links.ts`, `docs/decisions/pages.md` §8.1).
 *
 * Headless: the HTML rules below are what a paste and the schema need. The
 * page editor gives it a live chip as a node view.
 */
/** A mention's attrs from a pasted element, or `false` when its href is not one. */
function mentionAttrs(
  href: string,
  element: HTMLElement,
): false | { id: string; label: string | null } {
  const match = WORK_ITEM_MENTION_HREF_RE.exec(href);
  if (!match) return false;
  return { id: match[1]!, label: String(element.textContent).trim() || null };
}

export const WorkItemMention = Node.create({
  name: 'workItemMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    // Not rendered as attributes of their own — an `id` attribute would collide
    // with the DOM's — the node's `renderHTML` writes them.
    return {
      id: { default: null, rendered: false },
      label: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-work-item-id]',
        getAttrs: (element) =>
          mentionAttrs(`motir:${(element as HTMLElement).dataset.workItemId}`, element),
      },
      // Higher than the Link mark's `a[href]`, so a pasted `motir:` anchor is a
      // mention and not a link the mark's protocol check would drop.
      {
        tag: 'a[href^="motir:"]',
        priority: 1000,
        getAttrs: (element) => mentionAttrs(String(element.getAttribute('href')), element),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'workItemMention',
        'data-work-item-id': node.attrs.id as string,
      }),
      label,
    ];
  },

  renderText({ node }) {
    return (node.attrs.label as string | null) ?? (node.attrs.id as string | null) ?? '';
  },
});

export function pageExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Link is configured on its own below, so the list names it once.
      link: false,
      // Markdown has no underline; a mark the serializer cannot write would be
      // lost on the first markdown round-trip, so the page schema does not
      // carry one.
      underline: false,
      // The editor binds history to the Yjs document (the collaboration
      // extension's undo), so ProseMirror's own history must stay off.
      undoRedo: false,
      // Opening a page must not write it. The trailing node appends an empty
      // paragraph to a body that ends in a code block or a table, and under the
      // collaboration binding that append is a Yjs write — a save on open, and
      // one duplicated by every tab that opened the same stale body (MOTIR-7275).
      // It adds no node, so the schema is unchanged; the gap cursor and the code
      // block's arrow-down exit still reach past a last block.
      trailingNode: false,
    }),
    // A block image, `src` + `alt` (+ `title`); never inlined base64 — page
    // images are uploads filed under the page (MOTIR-7279).
    Image.configure({ inline: false, allowBase64: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    WorkItemMention,
  ];
}
