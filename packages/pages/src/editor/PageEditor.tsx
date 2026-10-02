'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Placeholder } from '@tiptap/extensions';
import { TriangleAlert } from 'lucide-react';
import * as Y from 'yjs';
import { pageExtensions } from '../document/extensions';
import { PAGE_FRAGMENT } from '../document/schema';
import { startAutosave, type SaveStatus } from './autosave';
import { codeBlockLanguage } from './codeBlockLanguage';
import type { PageEditorMessages } from './messages';
import { PageEditorToolbar } from './PageEditorToolbar';
import { SaveIndicator } from './SaveIndicator';
import { PAGE_EDITOR_CSS } from './styles';

// The page editor (Story MOTIR-5752 · MOTIR-7275), under
// `docs/decisions/pages.md` §2–§3 and drawn by `design/pages/page.mock.html`
// states 6–10.
//
// ⚠️ THE BODY IS A YJS DOCUMENT AND THE EDITOR SENDS UPDATES. `initialState` is
// the stored `Y.encodeStateAsUpdate(doc)`; it is applied to a fresh `Y.Doc`, and
// Tiptap's collaboration extension binds that doc's `default` fragment
// (`PAGE_FRAGMENT`) — the field a co-editing provider will attach to later
// without a migration. Every local change becomes a Yjs update, and
// `autosave.ts` sends them, merged, through `saveUpdate`.
//
// ⚠️ EVERY PIECE OF APP WIRING IS A PROP. The save route, the image upload, the
// copy and the theme all arrive from the host (`components/pages/PageEditorHost.tsx`,
// MOTIR-7280), so nothing here imports `@/…` and the component knows no URL.
//
// It grows from `components/ui/MarkdownEditor.tsx` by COPY (ADR §2): the same
// Tiptap 3 `useEditor` + `EditorContent`, `immediatelyRender: false` for SSR, the
// same paste / drop interception, the same toolbar. The extension list is the
// document card's `pageExtensions()` — the ONE schema the server reads — plus the
// React-side extensions only an editor needs: the collaboration binding, the
// placeholder and the code block's Language field.

/** The colour mode the host resolved; the package reads no theme context. */
export type PageEditorTheme = 'light' | 'dark';

export interface PageEditorProps {
  /** The stored body, `Y.encodeStateAsUpdate(doc)`. Read at mount. */
  initialState: Uint8Array;
  /**
   * Whether the reader may write. `false` is the read-only page: no toolbar, no
   * save indicator, no autosave subscription, and a body that cannot be edited.
   */
  editable: boolean;
  /**
   * Send ONE Yjs update to the page's save door. Reject with an error carrying
   * `code: 'PAGE_BODY_TOO_LARGE'` for the size refusal; any other rejection is
   * treated as a failure to reach the server and retried.
   */
  saveUpdate: (update: Uint8Array) => Promise<{ revision: number }>;
  /** Store an image filed under this page and resolve to its URL. */
  uploadImage: (file: File) => Promise<{ url: string }>;
  /** Every string the editor renders. */
  messages: PageEditorMessages;
  /** The colour mode, written as `data-color-mode` on the editor's root. */
  theme: PageEditorTheme;
  /** Told each time the save status changes. */
  onSaveStatusChange?: (status: SaveStatus) => void;
  /**
   * The too-large callout's **Reload saved version**. The button is drawn only
   * when the host supplies it (a full reload is the host's to perform).
   */
  onReloadSaved?: () => void;
  /** The too-large callout's **New page in a new tab**, likewise. */
  onNewPage?: () => void;
}

/** The first image in a paste, drop or picker payload, if any. */
function pickImage(files: FileList | null | undefined): File | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

function loadDoc(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  // No origin: this is the stored body arriving, not an edit of this tab's.
  Y.applyUpdate(doc, state);
  return doc;
}

export function PageEditor({
  initialState,
  editable,
  saveUpdate,
  uploadImage,
  messages,
  theme,
  onSaveStatusChange,
  onReloadSaved,
  onNewPage,
}: PageEditorProps) {
  // The document lives as long as the component; `initialState` is read once.
  const [doc] = useState(() => loadDoc(initialState));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [uploadFailed, setUploadFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The latest callbacks, read through refs so a parent re-render never
  // re-creates the editor or restarts the autosave loop.
  const saveUpdateRef = useRef(saveUpdate);
  const uploadImageRef = useRef(uploadImage);
  const onStatusRef = useRef(onSaveStatusChange);
  useEffect(() => {
    saveUpdateRef.current = saveUpdate;
    uploadImageRef.current = uploadImage;
    onStatusRef.current = onSaveStatusChange;
  }, [saveUpdate, uploadImage, onSaveStatusChange]);

  const insertImage = useCallback(async (editor: Editor, file: File) => {
    try {
      const { url } = await uploadImageRef.current(file);
      setUploadFailed(false);
      editor.chain().setImage({ src: url, alt: file.name }).run();
    } catch {
      // Never drop the file silently.
      setUploadFailed(true);
    }
  }, []);

  // Autosave: subscribed only for a writer.
  //
  // ⚠️ A LAYOUT effect, declared BEFORE `useEditor`, and it must stay both. The
  // editor is created in `useEditor`'s passive effect, and binding it can WRITE
  // to the doc at once — a plugin's `appendTransaction` normalising the loaded
  // body is recorded in Yjs with the binding's own origin. (StarterKit's
  // trailing node did exactly that until `pageExtensions()` turned it off.)
  // Every later keystroke depends on such a write, so a loop that subscribed
  // after it would send updates the server could never integrate. Layout
  // effects run before passive ones, so the loop hears the first write.
  useLayoutEffect(() => {
    if (!editable) return;
    const autosave = startAutosave({
      doc,
      saveUpdate: (update) => saveUpdateRef.current(update),
      onStatusChange: (next) => {
        setStatus(next);
        onStatusRef.current?.(next);
      },
    });
    return () => autosave.dispose();
  }, [doc, editable]);

  // Created once; the paste / drop handlers reach the editor through this.
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      ...pageExtensions(),
      Collaboration.configure({ document: doc, field: PAGE_FRAGMENT }),
      Placeholder.configure({ placeholder: messages.bodyPlaceholder }),
      codeBlockLanguage(messages.codeLanguage),
    ],
    editorProps: {
      attributes: {
        class: 'motir-prose',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': messages.bodyLabel,
      },
      handlePaste: (_view, event) => {
        const file = pickImage(event.clipboardData?.files);
        const current = editorRef.current;
        if (!file || !current) return false;
        event.preventDefault();
        void insertImage(current, file);
        return true;
      },
      handleDrop: (_view, event) => {
        const file = pickImage(event.dataTransfer?.files);
        const current = editorRef.current;
        if (!file || !current) return false;
        event.preventDefault();
        void insertImage(current, file);
        return true;
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const onPickImage = useCallback(() => fileInputRef.current?.click(), []);
  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = pickImage(event.target.files);
      event.target.value = ''; // the same file can be picked again
      if (file && editor) void insertImage(editor, file);
    },
    [editor, insertImage],
  );

  const tooLarge = editable && status === 'too_large';

  return (
    // suppressHydrationWarning: the host may resolve the colour mode only on
    // the client, as `MarkdownEditor` does.
    <div className="motir-page-editor" data-color-mode={theme} suppressHydrationWarning>
      <style href="motir-page-editor" precedence="default">
        {PAGE_EDITOR_CSS}
      </style>
      {editable && editor ? (
        <PageEditorToolbar
          editor={editor}
          messages={messages}
          onInsertImage={onPickImage}
          trailing={<SaveIndicator status={status} messages={messages.status} />}
        />
      ) : null}
      {tooLarge ? (
        <div
          role="alert"
          className="mt-4 flex gap-3 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) p-(--spacing-card-padding) text-(--el-danger-surface-text)"
        >
          <TriangleAlert
            className="mt-px h-[18px] w-[18px] flex-none text-(--el-danger-on-surface)"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold">{messages.tooLarge.title}</p>
            <p className="mt-1 text-[13.5px] leading-normal">{messages.tooLarge.body}</p>
            {onReloadSaved || onNewPage ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {onReloadSaved ? (
                  <button type="button" onClick={onReloadSaved} className={SECONDARY_BUTTON}>
                    {messages.tooLarge.reload}
                  </button>
                ) : null}
                {onNewPage ? (
                  <button type="button" onClick={onNewPage} className={SECONDARY_BUTTON}>
                    {messages.tooLarge.newPageNewTab}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {uploadFailed ? (
        <p role="alert" className="mt-2 text-xs text-(--el-danger-on-surface)">
          {messages.imageUploadFailed}
        </p>
      ) : null}
      <div className="pt-4 pb-2">{editor ? <EditorContent editor={editor} /> : null}</div>
      {editable ? (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
          tabIndex={-1}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

// `Button variant="secondary" size="sm"` from the design system, copied: the
// package does not depend on `@motir/design-system`.
const SECONDARY_BUTTON =
  'inline-flex h-(--height-btn-sm) items-center justify-center rounded-(--radius-btn) border border-(--el-button-border) bg-transparent px-(--spacing-btn-x-sm) text-xs font-medium text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
