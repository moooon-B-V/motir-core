'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import {
  bold,
  italic,
  strikethrough,
  hr,
  divider,
  title,
  link,
  quote,
  code,
  codeBlock,
  image,
  unorderedListCommand,
  orderedListCommand,
  checkedListCommand,
  table,
  codeEdit,
  codePreview,
  type ICommand,
} from '@uiw/react-md-editor/commands';
import '@uiw/react-md-editor/markdown-editor.css';
import { useOptionalTheme } from '@/lib/contexts/theme-context';
import { MarkdownView } from './MarkdownView';

// MarkdownEditor — the rich-text editor over Story 1.4's `descriptionMd`
// storage shape (Subtask 2.3.5). The source of truth is Markdown TEXT (not a
// CRDT, not ProseMirror JSON, not HTML); concurrent multi-user editing is out
// of v1 scope (last-write-wins, surfaced with optimistic-concurrency rejection
// in 2.3.6's edit form).
//
// Library: `@uiw/react-md-editor` — the most-downloaded React Markdown editor
// (MIT). It pairs natively with our `react-markdown` render path: the live
// preview is overridden to render through `MarkdownView` / `renderMarkdown`,
// so the editing preview and the read surface share the ONE pipeline (no
// Tiptap-style lossy ProseMirror↔Markdown serialization).
//
// SSR: the editor touches the DOM at module load, so it's pulled in via
// `next/dynamic({ ssr: false })`. The command set is isomorphic (pure data +
// icon components) and imported statically so the toolbar config is
// deterministic and unit-testable without mounting the editor.

// Loaded client-only — the editor reads `window`/`document` at module init.
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => (
    <div
      className="border-border bg-surface text-muted-foreground flex items-center rounded-md border px-3 py-2 text-sm"
      aria-hidden
    >
      Loading editor…
    </div>
  ),
});

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Compact toolbar for the `min` variant (the create modal). A focused set —
// the formatting users reach for inline — plus the edit/preview tab toggle.
const MIN_COMMANDS: ICommand[] = [bold, italic, code, link];
// Full toolbar for the `full` variant (the edit form): the complete set.
const FULL_COMMANDS: ICommand[] = [
  bold,
  italic,
  strikethrough,
  hr,
  divider,
  title,
  link,
  quote,
  code,
  codeBlock,
  image,
  divider,
  unorderedListCommand,
  orderedListCommand,
  checkedListCommand,
  divider,
  table,
];
// Right-aligned edit/preview tab toggle, shared by both editable variants.
const TAB_COMMANDS: ICommand[] = [codeEdit, codePreview];

type Size = 'min' | 'full';

interface EditorConfig {
  preview: 'live' | 'edit' | 'preview';
  hideToolbar: boolean;
  height: number;
  commands: ICommand[];
  extraCommands: ICommand[];
}

/**
 * Pure mapping from the public (`size`, `readOnly`) surface to the underlying
 * editor's toolbar/preview/height config. Exported so the contract is unit-
 * testable without mounting the (heavy, DOM-bound) editor.
 *
 * - `readOnly` → no toolbar, no tabs, preview-only render.
 * - `min`      → compact toolbar + edit/preview tabs, ~6 lines, edit-first.
 * - `full`     → full toolbar + edit/preview tabs, ~16 lines, live split-pane.
 */
export function editorConfigFor(size: Size, readOnly: boolean): EditorConfig {
  if (readOnly) {
    return { preview: 'preview', hideToolbar: true, height: 200, commands: [], extraCommands: [] };
  }
  if (size === 'min') {
    return {
      preview: 'edit',
      hideToolbar: false,
      height: 160,
      commands: MIN_COMMANDS,
      extraCommands: TAB_COMMANDS,
    };
  }
  return {
    preview: 'live',
    hideToolbar: false,
    height: 420,
    commands: FULL_COMMANDS,
    extraCommands: TAB_COMMANDS,
  };
}

/**
 * First supported image file in a clipboard/drop payload, or null. Restricted
 * to the same MIME allowlist the 2.3.7 upload endpoint enforces server-side —
 * so an unsupported type (e.g. SVG) falls through to the editor's normal paste
 * rather than kicking off an upload that the server would reject anyway.
 */
function pickImageFile(files: FileList | null | undefined): File | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (ALLOWED_IMAGE_TYPES.includes(file.type)) return file;
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
  /** Size variant. `min` for the create modal, `full` for the edit form. */
  size?: Size;
  /**
   * Persist a pasted/dropped image and resolve to its URL (spliced into the
   * Markdown). Omit to disable image upload — paste/drop then surfaces a polite
   * inline notice and the image is NOT inserted (never silently dropped).
   */
  onImageUpload?: (file: File) => Promise<string>;
  /** Render read-only (no toolbar, no tabs — preview only). */
  readOnly?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  label,
  size = 'full',
  onImageUpload,
  readOnly = false,
}: MarkdownEditorProps) {
  const theme = useOptionalTheme();
  const colorMode = theme?.resolvedPattern ?? 'light';
  const config = useMemo(() => editorConfigFor(size, readOnly), [size, readOnly]);

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest value + a monotonic token counter, read inside the async upload
  // callback without re-subscribing it on every keystroke. Synced via effect
  // (never written during render) so the upload continuation that runs after a
  // placeholder insert always replaces against the current document.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const uploadSeq = useRef(0);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  // Splice text into the controlled value at the textarea's caret (falling back
  // to append when the caret isn't available).
  const spliceAtCaret = useCallback(
    (textarea: HTMLTextAreaElement | null, insert: string) => {
      const current = valueRef.current;
      const start = textarea?.selectionStart ?? current.length;
      const end = textarea?.selectionEnd ?? current.length;
      const next = current.slice(0, start) + insert + current.slice(end);
      valueRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const uploadImage = useCallback(
    async (file: File, textarea: HTMLTextAreaElement | null) => {
      if (!onImageUpload) {
        showNotice("Image uploads aren't enabled here.");
        return;
      }
      // Unique placeholder per upload so concurrent pastes don't collide and a
      // later edit elsewhere in the doc doesn't shift the wrong token.
      const token = `uploading:${++uploadSeq.current}`;
      const placeholder = `![Uploading ${file.name}…](${token})`;
      spliceAtCaret(textarea, placeholder);
      try {
        const url = await onImageUpload(file);
        valueRef.current = valueRef.current.replace(placeholder, `![${file.name}](${url})`);
        onChange(valueRef.current);
      } catch {
        // Revert the placeholder and tell the user — never leave a dangling
        // "Uploading…" marker and never silently drop the image.
        valueRef.current = valueRef.current.replace(placeholder, '');
        onChange(valueRef.current);
        showNotice('Image upload failed — please try again.');
      }
    },
    [onImageUpload, onChange, showNotice, spliceAtCaret],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const file = pickImageFile(event.clipboardData?.files);
      if (!file) return; // not an image — let the editor handle the paste normally
      event.preventDefault();
      void uploadImage(file, event.currentTarget);
    },
    [uploadImage],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      const file = pickImageFile(event.dataTransfer?.files);
      if (!file) return;
      event.preventDefault();
      void uploadImage(file, event.currentTarget);
    },
    [uploadImage],
  );

  // Render the editor's preview pane through OUR single render module so the
  // edit-time preview and the read surface (MarkdownView) can never diverge.
  const previewRenderer = useCallback(
    (source: string): ReactElement => <MarkdownView value={source} />,
    [],
  );

  return (
    // suppressHydrationWarning: `colorMode` is 'light' on the server (the theme
    // provider's stable SSR snapshot) but resolves to the OS preference on the
    // client — an intentional, sanctioned attribute mismatch (same pattern the
    // ThemeProvider uses for <html data-theme>), not a bug to reconcile.
    <div className="flex flex-col gap-1" data-color-mode={colorMode} suppressHydrationWarning>
      <span className="text-foreground font-sans text-sm font-medium">{label}</span>
      <MDEditor
        value={value}
        onChange={(next) => onChange(next ?? '')}
        height={config.height}
        preview={config.preview}
        hideToolbar={config.hideToolbar}
        commands={config.commands}
        extraCommands={config.extraCommands}
        data-color-mode={colorMode}
        components={{ preview: previewRenderer }}
        textareaProps={{
          'aria-label': label,
          readOnly,
          onPaste: readOnly ? undefined : handlePaste,
          onDrop: readOnly ? undefined : handleDrop,
        }}
      />
      {notice && (
        <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
          {notice}
        </p>
      )}
    </div>
  );
}
