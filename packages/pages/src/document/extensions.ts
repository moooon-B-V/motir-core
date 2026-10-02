import type { Extensions } from '@tiptap/core';
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
  ];
}
