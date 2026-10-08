'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
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
import { WorkItemPicker, defaultPickerRow } from './WorkItemPicker';
import {
  MentionChipContext,
  candidateView,
  defaultChip,
  openMentionTrigger,
  workItemMentionWithChip,
  workItemSuggestion,
  type AvailableWorkItemRefView,
  type MentionChipContextValue,
  type MentionSuggestionState,
  type WorkItemCandidate,
  type WorkItemRefView,
} from './workItemMention';

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

export interface PageEditorProps<C extends WorkItemCandidate = WorkItemCandidate> {
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
   * The refusal callout's reload (**Reload saved version**, or **Reload page**
   * for an archived page). The button is drawn only when the host supplies it
   * (a full reload is the host's to perform).
   */
  onReloadSaved?: () => void;
  /** The too-large callout's **New page in a new tab**, likewise. */
  onNewPage?: () => void;
  /**
   * The work-item search behind the mention picker (MOTIR-7574) — the page's
   * project only. Supplied → an editable page offers both doors (`@` and the
   * toolbar's **Work item**); omitted → neither. A rejection is the picker's
   * "search failed" state.
   */
  searchWorkItems?: (query: string) => Promise<C[]>;
  /**
   * The live summary of every work item the body mentions, by id, as the page
   * loaded with them. An id with no entry is a deleted item.
   */
  workItemRefs?: Record<string, WorkItemRefView>;
  /** Draws a live or archived chip; the unavailable chip is the package's. */
  renderWorkItemChip?: (view: AvailableWorkItemRefView) => ReactNode;
  /** Draws one picker row's content; the option around it is the package's. */
  renderPickerRow?: (candidate: C, active: boolean) => ReactNode;
  /**
   * A plain click on a live chip in the read-only page, when the chip the host
   * rendered did not open the item itself.
   */
  onOpenWorkItem?: (id: string) => void;
}

const NO_REFS: Record<string, WorkItemRefView> = {};

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

export function PageEditor<C extends WorkItemCandidate = WorkItemCandidate>({
  initialState,
  editable,
  saveUpdate,
  uploadImage,
  messages,
  theme,
  onSaveStatusChange,
  onReloadSaved,
  onNewPage,
  searchWorkItems,
  workItemRefs = NO_REFS,
  renderWorkItemChip = defaultChip,
  renderPickerRow = defaultPickerRow,
  onOpenWorkItem,
}: PageEditorProps<C>) {
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

  // ── Mention a work item (MOTIR-7574) ──────────────────────────────────────
  // The `@` suggestion reports here and the picker renders from this state. The
  // doors exist only on an editable page with a search wired; the extension list
  // is fixed per editor, so that is read once, at mount.
  const [mentionEnabled] = useState(() => editable && searchWorkItems !== undefined);
  const [suggestion, setSuggestion] = useState<
    (MentionSuggestionState & { position?: { left: number; top: number } }) | null
  >(null);
  // The chips inserted this session, shown from the picked candidate until the
  // page is read again.
  const [pickedRefs, setPickedRefs] = useState<Record<string, AvailableWorkItemRefView>>({});

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      // The document's list, its mention node given the live chip.
      ...pageExtensions().map((extension) =>
        extension.name === 'workItemMention' ? workItemMentionWithChip() : extension,
      ),
      // Read at creation only, like the rest of these options.
      ...(mentionEnabled
        ? [
            workItemSuggestion({
              // The picker sits 4px under the caret, inside the body's positioned
              // wrapper — never a body portal (`MentionList`'s placement).
              onChange: (next) => {
                const box = next.anchor?.getBoundingClientRect();
                setSuggestion({
                  ...next,
                  position:
                    next.rect && box
                      ? {
                          left: Math.round(next.rect.left - box.left),
                          top: Math.round(next.rect.bottom - box.top + 4),
                        }
                      : undefined,
                });
              },
              onClose: () => setSuggestion(null),
              onInsert: (candidate) =>
                setPickedRefs((prev) => ({ ...prev, [candidate.id]: candidateView(candidate) })),
            }),
          ]
        : []),
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
  const onMentionWorkItem = useCallback(() => {
    if (editor) openMentionTrigger(editor);
  }, [editor]);

  const chipContext = useMemo<MentionChipContextValue>(
    () => ({
      lookup: (id) => pickedRefs[id] ?? workItemRefs[id],
      renderChip: renderWorkItemChip,
      messages: messages.mention,
      editable,
      onOpen: onOpenWorkItem,
    }),
    [pickedRefs, workItemRefs, renderWorkItemChip, messages.mention, editable, onOpenWorkItem],
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = pickImage(event.target.files);
      event.target.value = ''; // the same file can be picked again
      if (file && editor) void insertImage(editor, file);
    },
    [editor, insertImage],
  );

  // The two final refusals share base state 9's callout: the page passed its size
  // limit, or someone archived it under this tab (MOTIR-7423). Either way the
  // loop has stopped and the content stays here to be copied out.
  const refusal =
    !editable || (status !== 'too_large' && status !== 'archived')
      ? null
      : status === 'archived'
        ? {
            title: messages.archived.title,
            body: messages.archived.body,
            reload: messages.archived.reload,
            newPage: null,
          }
        : {
            title: messages.tooLarge.title,
            body: messages.tooLarge.body,
            reload: messages.tooLarge.reload,
            newPage: messages.tooLarge.newPageNewTab,
          };
  const onNewPageHere = refusal?.newPage ? onNewPage : undefined;

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
          onMentionWorkItem={mentionEnabled ? onMentionWorkItem : undefined}
          mentionOpen={suggestion !== null}
          trailing={<SaveIndicator status={status} messages={messages.status} />}
        />
      ) : null}
      {refusal ? (
        <div
          role="alert"
          data-refusal={status}
          className="mt-4 flex gap-3 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) p-(--spacing-card-padding) text-(--el-danger-surface-text)"
        >
          <TriangleAlert
            className="mt-px h-[18px] w-[18px] flex-none text-(--el-danger-on-surface)"
            aria-hidden
          />
          <div>
            <p className="text-sm font-semibold">{refusal.title}</p>
            <p className="mt-1 text-[13.5px] leading-normal">{refusal.body}</p>
            {onReloadSaved || onNewPageHere ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {onReloadSaved ? (
                  <button type="button" onClick={onReloadSaved} className={SECONDARY_BUTTON}>
                    {refusal.reload}
                  </button>
                ) : null}
                {onNewPageHere ? (
                  <button type="button" onClick={onNewPageHere} className={SECONDARY_BUTTON}>
                    {refusal.newPage}
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
      <div data-mention-anchor className="relative pt-4 pb-2">
        <MentionChipContext.Provider value={chipContext}>
          {editor ? <EditorContent editor={editor} /> : null}
        </MentionChipContext.Provider>
        {suggestion && searchWorkItems ? (
          <div className="absolute z-50" style={suggestion.position}>
            <WorkItemPicker<C>
              query={suggestion.query}
              search={searchWorkItems}
              renderRow={renderPickerRow}
              onPick={suggestion.pick}
              label={messages.toolbar.workItemLabel}
              messages={messages.mention}
            />
          </div>
        ) : null}
      </div>
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
