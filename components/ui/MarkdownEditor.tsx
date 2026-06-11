'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Code2,
  Heading2,
  List,
  ListOrdered,
  ListChecks,
  Link as LinkIcon,
  Quote,
  Paperclip,
} from 'lucide-react';
import { useOptionalTheme } from '@/lib/contexts/theme-context';
import { ALLOWED_UPLOAD_TYPES, isImageType } from '@/lib/blob/allowlist';
import { cn } from '@/lib/utils/cn';
import { MarkdownView } from './MarkdownView';
import {
  buildMentionExtension,
  type MentionCandidate,
  type MentionWiring,
} from './markdownEditorMentions';
import './markdown-editor.css';

// MarkdownEditor — the WYSIWYG editor over Story 1.4's `descriptionMd` storage
// shape (Subtask 2.3.5, rebuilt as a true rendered-view editor in 2.3.10,
// finding #53). The source of truth is — still — Markdown TEXT. The user edits
// the RENDERED document inline (no split source/preview pane); Markdown is the
// load + save boundary, never shown raw.
//
// Library: Tiptap v3 (ProseMirror) + `tiptap-markdown`. `tiptap-markdown` makes
// the editor's canonical serialization Markdown: it parses the incoming
// `descriptionMd` into the ProseMirror document on load and serializes back to
// Markdown via `editor.storage.markdown.getMarkdown()` on every edit. The
// round-trip fidelity over our supported feature set (headings, bold, italic,
// strike, links, ordered/unordered/TASK lists, inline code, code blocks,
// blockquotes) is pinned by a unit test — that test is the library-choice gate.
// Tables are intentionally out of v1 scope (tiptap-markdown's table round-trip
// is lossy); typing a Markdown table degrades to text rather than corrupting.
//
// SSR: `immediatelyRender: false` is Tiptap v3's first-class SSR switch — the
// editor builds its view on the client only, so there's no `next/dynamic`
// wrapper and no hydration mismatch (it supersedes 2.3.5's dynamic import).
//
// Safety: `html: false` on the Markdown extension means any raw HTML in the
// source (or pasted) is treated as plain text, never rendered — there is no
// HTML/script injection surface through the editor.

export type { MentionCandidate };

// `compact` is the comment-composer mode (Story 5.1 · the comments mockup's
// panel 3): the shortest editing area (~72px) with the inline-format toolbar.
type Size = 'compact' | 'min' | 'full';

/**
 * The canonical extension set. Exported so the round-trip fidelity test builds a
 * headless editor over the EXACT same schema the UI uses — the test would be
 * meaningless against a different extension list.
 *
 * Markdown is the document model: `html: false` keeps raw HTML inert, and
 * `linkify`/`breaks` stay off so serialization matches our stored Markdown
 * conventions rather than markdown-it's permissive defaults.
 *
 * `mentions` (Subtask 5.1.4) appends the configured Mention extension — the
 * `@`-picker plus the `[@Name](mention:<userId>)` token round-trip. Absent, the
 * schema (and so every existing consumer) is exactly what it was before 5.1.4.
 */
export function buildEditorExtensions(opts?: { mentions?: MentionWiring }) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({
      html: false,
      linkify: false,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    ...(opts?.mentions ? [buildMentionExtension(opts.mentions)] : []),
  ];
}

/** Read the current document back as Markdown (tiptap-markdown storage). */
function getMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>).markdown as
    | { getMarkdown?: () => string }
    | undefined;
  return storage?.getMarkdown?.() ?? '';
}

/**
 * First allowed file in a clipboard/drop/picker payload, or null (2.3.7,
 * finding #52: ANY allowed file, not just images). Restricted to the shared
 * upload allowlist the endpoint enforces server-side — an unsupported type
 * falls through to the editor's normal paste rather than kicking off an upload
 * the server would reject. Images embed as an inline image node; other allowed
 * files insert as a link.
 */
function pickAllowedFile(files: FileList | null | undefined): File | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (ALLOWED_UPLOAD_TYPES.includes(file.type)) return file;
  }
  return null;
}

export interface MarkdownEditorProps {
  /** Controlled Markdown source. */
  value: string;
  /** Called with the next Markdown source on every edit. */
  onChange: (value: string) => void;
  /** Accessible label for the editing surface (required — drives aria-label). */
  label: string;
  /**
   * Optional inline content rendered next to the visible label (e.g. a "— why
   * it matters" gloss + an "AI-drafted" badge). Lets a caller enrich the field
   * header WITHOUT adding a second external label that duplicates `label`.
   */
  labelAccessory?: ReactNode;
  /** Size variant. `min` for the create modal, `full` for the edit form,
   * `compact` for the comment composer (5.1.5 — the mockup's ~72px area). */
  size?: Size;
  /**
   * Render the label for screen readers only (the editing surface keeps its
   * aria-label). The comment composer (5.1.5) is visually led by the author's
   * avatar per the comments mockup — a visible field label would double it.
   */
  labelHidden?: boolean;
  /**
   * Persist a pasted/dropped/picked FILE (2.3.7, finding #52 — any allowed
   * type, not just images) and resolve to its URL. An image inserts as an
   * inline image node; any other file inserts as a link, by the File's MIME.
   * Omit to disable uploads — paste/drop/attach then surfaces a polite inline
   * notice and the file is NOT inserted (never silently dropped).
   */
  onFileUpload?: (file: File) => Promise<string>;
  /** Render read-only — the rendered document with no toolbar or editing. */
  readOnly?: boolean;
  /**
   * Members the `@` mention picker offers (Subtask 5.1.4) — the host surface
   * supplies the issue-scoped VIEWABLE members (the 5.1.2 candidate read); the
   * editor stays data-source-agnostic. Omit and mention support is off — the
   * editor behaves exactly as before. Presence is read at mount (the tiptap
   * schema is fixed per editor instance); the LIST may update freely while
   * mounted. A picked member inserts a mention node that serializes to
   * `[@Display Name](mention:<userId>)`.
   */
  mentionCandidates?: MentionCandidate[];
}

export function MarkdownEditor({
  value,
  onChange,
  label,
  labelAccessory,
  size = 'full',
  labelHidden = false,
  onFileUpload,
  readOnly = false,
  mentionCandidates,
}: MarkdownEditorProps) {
  const theme = useOptionalTheme();
  const colorMode = theme?.resolvedPattern ?? 'light';

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);

  // Latest `onChange` read inside Tiptap's `onUpdate` without re-creating the
  // editor on every parent render. Synced via effect, never written in render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Mention wiring (5.1.4). The extension list is fixed at editor creation, so
  // mention support keys off the prop's presence AT MOUNT; the candidate LIST
  // itself is read through a ref on every keystroke, so updates (e.g. the host
  // finishing its members fetch with the prop already `[]`-present) flow into
  // the open picker without re-creating the editor. The popup mounts into the
  // editor's bordered wrapper (anchorRef) — absolute positioning inside the
  // dialog-safe wrapper, never a body portal (the Combobox in-dialog lesson).
  const mentionCandidatesRef = useRef(mentionCandidates);
  useEffect(() => {
    mentionCandidatesRef.current = mentionCandidates;
  }, [mentionCandidates]);
  const anchorRef = useRef<HTMLDivElement>(null);
  // Created ONCE (lazy initializer) so the wiring closures are stable; they
  // dereference the refs only when the suggestion plugin invokes them (typing
  // `@`), never during render.
  const [mentionOpts] = useState<{ mentions: MentionWiring } | undefined>(() =>
    mentionCandidates !== undefined
      ? {
          mentions: {
            getCandidates: () => mentionCandidatesRef.current ?? [],
            getAnchor: () => anchorRef.current,
          },
        }
      : undefined,
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: buildEditorExtensions(mentionOpts),
    content: value,
    editorProps: {
      attributes: {
        class: 'motir-prose',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
      },
      handlePaste: (_view, event) => {
        const file = pickAllowedFile(event.clipboardData?.files);
        if (!file) return false; // not an allowed file — let the editor paste
        event.preventDefault();
        void handleFileRef.current(file);
        return true;
      },
      handleDrop: (_view, event) => {
        const file = pickAllowedFile((event as DragEvent).dataTransfer?.files);
        if (!file) return false;
        event.preventDefault();
        void handleFileRef.current(file);
        return true;
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(getMarkdown(editor)),
  });

  // Reflect readOnly toggles onto a live editor (it's created once).
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // Controlled sync: when the parent's `value` diverges from what the editor
  // holds (e.g. a form reset, or programmatic set), reparse the Markdown WITHOUT
  // emitting an update (which would echo back into `onChange` and loop).
  useEffect(() => {
    if (!editor) return;
    if (value !== getMarkdown(editor)) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!editor) return;
      if (!onFileUpload) {
        showNotice("File uploads aren't enabled here.");
        return;
      }
      showNotice(`Uploading ${file.name}…`);
      try {
        const url = await onFileUpload(file);
        if (isImageType(file.type)) {
          editor.chain().focus().setImage({ src: url, alt: file.name }).run();
        } else {
          // Insert a link node, then a plain space so the link mark doesn't
          // bleed into whatever the user types next.
          editor
            .chain()
            .focus()
            .insertContent({
              type: 'text',
              text: file.name,
              marks: [{ type: 'link', attrs: { href: url } }],
            })
            .insertContent(' ')
            .run();
        }
        setNotice(null);
      } catch (err) {
        // Never silently drop the file — tell the user.
        showNotice(err instanceof Error ? err.message : 'Upload failed — please try again.');
      }
    },
    [editor, onFileUpload, showNotice],
  );

  // Stable ref so the editor's (create-time) paste/drop handlers always call the
  // latest upload closure without re-instantiating the editor.
  const handleFileRef = useRef(handleFile);
  useEffect(() => {
    handleFileRef.current = handleFile;
  }, [handleFile]);

  const onAttachClick = useCallback(() => fileInputRef.current?.click(), []);
  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = pickAllowedFile(event.target.files);
      event.target.value = ''; // allow re-picking the same file
      if (file) void handleFile(file);
      else showNotice("That file type isn't supported.");
    },
    [handleFile, showNotice],
  );

  return (
    // suppressHydrationWarning: `colorMode` is 'light' on the server (the theme
    // provider's stable SSR snapshot) but resolves to the OS preference on the
    // client — an intentional, sanctioned attribute mismatch, not a bug.
    <div className="flex flex-col gap-1" data-color-mode={colorMode} suppressHydrationWarning>
      {labelHidden ? null : (
        <span className="text-(--el-text) flex items-center gap-2 font-sans text-sm font-medium">
          {label}
          {labelAccessory}
        </span>
      )}
      {readOnly ? (
        <div className="border-(--el-border) bg-(--el-surface) rounded-(--radius-input) border px-3 py-2">
          <MarkdownView value={value} />
        </div>
      ) : (
        <div
          ref={anchorRef}
          className="border-(--el-border) bg-(--el-surface) focus-within:border-(--el-highlight) relative rounded-(--radius-input) border transition-colors"
        >
          <Toolbar
            editor={editor}
            size={size}
            canUpload={Boolean(onFileUpload)}
            onAttach={onAttachClick}
          />
          <div
            className={cn(
              'overflow-y-auto px-3 py-2',
              size === 'compact'
                ? 'min-h-[4.5rem]'
                : size === 'min'
                  ? 'min-h-[8rem]'
                  : 'min-h-[22rem]',
            )}
          >
            {editor && <EditorContent editor={editor} />}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ALLOWED_UPLOAD_TYPES.join(',')}
            className="hidden"
            onChange={onFileInputChange}
            tabIndex={-1}
            aria-hidden
          />
        </div>
      )}
      {notice && (
        <p role="status" aria-live="polite" className="text-(--el-text-muted) text-xs">
          {notice}
        </p>
      )}
    </div>
  );
}

type IconType = typeof Bold;

interface ToolbarButtonDef {
  icon: IconType;
  label: string;
  run: () => void;
}

function Toolbar({
  editor,
  size,
  canUpload,
  onAttach,
}: {
  editor: Editor | null;
  size: Size;
  canUpload: boolean;
  onAttach: () => void;
}) {
  // First paint (SSR / pre-hydration) the editor is null — render a stable
  // placeholder bar of the same height so layout doesn't jump.
  if (!editor) return <div className="border-(--el-border) h-9 border-b" aria-hidden />;

  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? '');
    if (url === null) return; // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const bold: ToolbarButtonDef = {
    icon: Bold,
    label: 'Bold',
    run: () => editor.chain().focus().toggleBold().run(),
  };
  const italic: ToolbarButtonDef = {
    icon: Italic,
    label: 'Italic',
    run: () => editor.chain().focus().toggleItalic().run(),
  };
  const inlineCode: ToolbarButtonDef = {
    icon: Code,
    label: 'Inline code',
    run: () => editor.chain().focus().toggleCode().run(),
  };
  const linkBtn: ToolbarButtonDef = { icon: LinkIcon, label: 'Link', run: setLink };

  const fullExtras: ToolbarButtonDef[] = [
    {
      icon: Strikethrough,
      label: 'Strikethrough',
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      icon: Heading2,
      label: 'Heading',
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    { icon: Quote, label: 'Quote', run: () => editor.chain().focus().toggleBlockquote().run() },
    { icon: Code2, label: 'Code block', run: () => editor.chain().focus().toggleCodeBlock().run() },
    {
      icon: List,
      label: 'Bulleted list',
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      icon: ListOrdered,
      label: 'Numbered list',
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      icon: ListChecks,
      label: 'Task list',
      run: () => editor.chain().focus().toggleTaskList().run(),
    },
  ];

  // `compact` is the comments-mockup panel-3 set: inline marks + link + lists.
  const strike: ToolbarButtonDef = {
    icon: Strikethrough,
    label: 'Strikethrough',
    run: () => editor.chain().focus().toggleStrike().run(),
  };
  const bulletList: ToolbarButtonDef = {
    icon: List,
    label: 'Bulleted list',
    run: () => editor.chain().focus().toggleBulletList().run(),
  };
  const orderedList: ToolbarButtonDef = {
    icon: ListOrdered,
    label: 'Numbered list',
    run: () => editor.chain().focus().toggleOrderedList().run(),
  };

  const buttons: ToolbarButtonDef[] =
    size === 'compact'
      ? [bold, italic, strike, inlineCode, linkBtn, bulletList, orderedList]
      : size === 'min'
        ? [bold, italic, inlineCode, linkBtn]
        : [bold, italic, ...fullExtras, linkBtn];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="border-(--el-border) flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1"
    >
      {buttons.map((b) => {
        const Icon = b.icon;
        return (
          <button
            key={b.label}
            type="button"
            aria-label={b.label}
            title={b.label}
            onClick={b.run}
            className="text-(--el-text-muted) hover:bg-(--el-page-bg) hover:text-(--el-text) focus-visible:ring-(--el-highlight) rounded p-1.5 focus-visible:ring-2 focus-visible:outline-none"
          >
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        );
      })}
      {canUpload && (
        <button
          type="button"
          aria-label="Attach file"
          title="Attach file"
          onClick={onAttach}
          className="text-(--el-text-muted) hover:bg-(--el-page-bg) hover:text-(--el-text) focus-visible:ring-(--el-highlight) rounded p-1.5 focus-visible:ring-2 focus-visible:outline-none"
        >
          <Paperclip className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
