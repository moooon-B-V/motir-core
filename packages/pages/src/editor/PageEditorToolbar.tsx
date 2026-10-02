import type { ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Code2,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Table as TableIcon,
  type LucideIcon,
} from 'lucide-react';
import type { PageEditorMessages } from './messages';

// The page editor's toolbar (Story MOTIR-5752 · MOTIR-7275), to
// `design/pages/design-notes.md` § _The toolbar — composes `MarkdownEditor.tsx`'s_.
//
// It is `components/ui/MarkdownEditor.tsx`'s `Toolbar`, size `full`, button for
// button and in its order — COPIED, not imported, because the package may not
// import `@/…` and that file stays untouched. Then, after a hairline, what a page
// adds: Insert image and Insert table; and, only while the caret is in a table,
// the table group's text buttons after a second hairline. The code block's
// Language field is the `codeBlockLanguage` node view, not a toolbar control.
//
// Differences from the description editor, each from the notes: every label
// comes from `messages` (the description editor's are hard-coded English);
// Attach file becomes Insert image; the strip is sticky on the page canvas, not
// the head of a boxed field; and the button ink is `--el-icon-muted`.

const ICON_BUTTON =
  'inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-icon-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

const TEXT_BUTTON =
  'inline-flex items-center rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-[12.5px] whitespace-nowrap text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

interface IconButtonDef {
  key: string;
  icon: LucideIcon;
  label: string;
  run: () => void;
}

interface TextButtonDef {
  key: string;
  text: string;
  label: string;
  run: () => void;
}

function Separator() {
  return <span aria-hidden className="mx-1 h-[18px] w-px bg-(--el-border)" />;
}

export interface PageEditorToolbarProps {
  editor: Editor;
  messages: PageEditorMessages;
  /** Opens the image picker; the host's `uploadImage` does the rest. */
  onInsertImage: () => void;
  /** Rendered at the trailing end — the save indicator. */
  trailing?: ReactNode;
}

export function PageEditorToolbar({
  editor,
  messages,
  onInsertImage,
  trailing,
}: PageEditorToolbarProps) {
  const t = messages.toolbar;
  // Re-render on selection moves only for the one thing the strip shows
  // conditionally: whether the caret is in a table.
  const inTable = useEditorState({
    editor,
    selector: ({ editor: e }) => e.isActive('table'),
  });

  const chain = () => editor.chain().focus();

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(t.linkPrompt, previous ?? '');
    if (url === null) return; // cancelled
    if (url === '') {
      chain().extendMarkRange('link').unsetLink().run();
      return;
    }
    chain().extendMarkRange('link').setLink({ href: url }).run();
  };

  const shipped: IconButtonDef[] = [
    { key: 'bold', icon: Bold, label: t.bold, run: () => chain().toggleBold().run() },
    { key: 'italic', icon: Italic, label: t.italic, run: () => chain().toggleItalic().run() },
    {
      key: 'strike',
      icon: Strikethrough,
      label: t.strike,
      run: () => chain().toggleStrike().run(),
    },
    {
      key: 'heading',
      icon: Heading2,
      label: t.heading,
      run: () => chain().toggleHeading({ level: 2 }).run(),
    },
    { key: 'quote', icon: Quote, label: t.quote, run: () => chain().toggleBlockquote().run() },
    {
      key: 'codeBlock',
      icon: Code2,
      label: t.codeBlock,
      run: () => chain().toggleCodeBlock().run(),
    },
    {
      key: 'bulletList',
      icon: List,
      label: t.bulletList,
      run: () => chain().toggleBulletList().run(),
    },
    {
      key: 'orderedList',
      icon: ListOrdered,
      label: t.orderedList,
      run: () => chain().toggleOrderedList().run(),
    },
    {
      key: 'taskList',
      icon: ListChecks,
      label: t.taskList,
      run: () => chain().toggleTaskList().run(),
    },
    { key: 'link', icon: LinkIcon, label: t.link, run: setLink },
  ];

  const pageAdds: IconButtonDef[] = [
    { key: 'image', icon: ImageIcon, label: t.image, run: onInsertImage },
    {
      key: 'table',
      icon: TableIcon,
      label: t.table,
      run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
  ];

  const tb = messages.table;
  const tableGroup: TextButtonDef[] = [
    {
      key: 'addRow',
      text: tb.addRow,
      label: tb.addRowLabel,
      run: () => chain().addRowAfter().run(),
    },
    {
      key: 'addColumn',
      text: tb.addColumn,
      label: tb.addColumnLabel,
      run: () => chain().addColumnAfter().run(),
    },
    {
      key: 'deleteRow',
      text: tb.deleteRow,
      label: tb.deleteRowLabel,
      run: () => chain().deleteRow().run(),
    },
    {
      key: 'deleteColumn',
      text: tb.deleteColumn,
      label: tb.deleteColumnLabel,
      run: () => chain().deleteColumn().run(),
    },
    {
      key: 'deleteTable',
      text: tb.deleteTable,
      label: tb.deleteTable,
      run: () => chain().deleteTable().run(),
    },
  ];

  const iconButton = (b: IconButtonDef) => {
    const Icon = b.icon;
    return (
      <button
        key={b.key}
        type="button"
        aria-label={b.label}
        title={b.label}
        onClick={b.run}
        className={ICON_BUTTON}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </button>
    );
  };

  return (
    <div
      role="toolbar"
      aria-label={t.label}
      className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-y border-(--el-border) bg-(--el-page-bg) px-1.5 py-1"
    >
      {shipped.map(iconButton)}
      <Separator />
      {pageAdds.map(iconButton)}
      {inTable ? (
        <>
          <Separator />
          {tableGroup.map((b) => (
            <button
              key={b.key}
              type="button"
              aria-label={b.label}
              onClick={b.run}
              className={TEXT_BUTTON}
            >
              {b.text}
            </button>
          ))}
        </>
      ) : null}
      {trailing}
    </div>
  );
}
