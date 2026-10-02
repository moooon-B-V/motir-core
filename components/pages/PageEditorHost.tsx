'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PageBodyTooLargeError,
  PageEditor,
  type PageEditorMessages,
  type SaveStatus,
} from '@motir/pages';
import { useOptionalTheme } from '@/lib/contexts/theme-context';
import '@/components/ui/markdown-editor.css';

// THE one client host for `@motir/pages`' editor (Story MOTIR-5752 · MOTIR-7280),
// `docs/decisions/pages.md` §2. `<PageEditor>` knows no URL, no locale and no
// theme context — every piece of app wiring arrives as a prop, and this file is
// where each one is bound:
//
//  • `saveUpdate` — one Yjs update as raw bytes to `POST /api/pages/<id>/updates`.
//    200 resolves `{ revision }`. 413 rejects with a `PageBodyTooLargeError`,
//    which carries `code: 'PAGE_BODY_TOO_LARGE'` — the ONE rejection the editor
//    treats as final (`too_large`). Anything else (a fetch that never reached the
//    server, a 5xx) rejects as a plain error, which the editor reads as `offline`
//    and retries with backoff.
//  • `uploadImage` — multipart `POST /api/pages/<id>/images` → `{ url }`.
//  • `messages` — `pages.editor.*` from `next-intl`, plus the app's existing
//    `markdownEditor.codeLanguage`.
//  • `theme` — `useOptionalTheme()`'s resolved pattern, as `MarkdownEditor` reads it.
//  • `initialState` — the DTO's base64 Yjs state, decoded once.
//
// ⚠️ IT IMPORTS NOTHING SERVER-ONLY. `@motir/pages` is imported from its barrel,
// whose editor entry carries `'use client'`; `@/lib/pages` (the server
// composition root, which binds the Prisma store) is never reached from here.
// `tests/packages/importDirection.test.ts` holds that `@motir/pages` is imported
// only here and under `lib/pages/`.
//
// THE LEAVE GUARD. The editor's offline buffer lives in this tab, so leaving the
// page while a save is in flight, offline or refused loses the writer's edits.
// While the status is anything but `saved`, a `beforeunload` prompt asks first
// (design-notes § Open questions — MOTIR-7280 decides it). The callout's own
// **Reload saved version** is the writer choosing to discard, so it lifts the
// guard before reloading.

/** Decode the DTO's base64 Yjs state. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The save door's refusal, read from its 413 body. */
async function tooLargeFrom(res: Response): Promise<PageBodyTooLargeError> {
  let limit = 0;
  let size = 0;
  try {
    const body = (await res.json()) as { limit?: unknown; size?: unknown };
    if (typeof body.limit === 'number') limit = body.limit;
    if (typeof body.size === 'number') size = body.size;
  } catch {
    // The status alone is the refusal; the numbers are detail.
  }
  return new PageBodyTooLargeError(limit, size);
}

/** Send one update; resolve the new revision or reject as the editor expects. */
export async function sendPageUpdate(
  pageId: string,
  update: Uint8Array,
): Promise<{ revision: number }> {
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/updates`, {
    method: 'POST',
    // A copy over a plain `ArrayBuffer` — what `BodyInit` accepts.
    body: new Uint8Array(update),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (res.status === 413) throw await tooLargeFrom(res);
  if (!res.ok) throw new Error(`Page save failed with HTTP ${res.status}`);
  return (await res.json()) as { revision: number };
}

/** Upload one image filed under the page. */
export async function uploadPageImage(pageId: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/images`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Image upload failed with HTTP ${res.status}`);
  return (await res.json()) as { url: string };
}

/** The editor's copy, from the `pages.editor` catalogue. */
function usePageEditorMessages(): PageEditorMessages {
  const t = useTranslations('pages.editor');
  const tMarkdown = useTranslations('markdownEditor');
  return useMemo(
    () => ({
      bodyLabel: t('bodyLabel'),
      bodyPlaceholder: t('bodyPlaceholder'),
      codeLanguage: tMarkdown('codeLanguage'),
      imageUploadFailed: t('imageUploadFailed'),
      toolbar: {
        label: t('toolbar.label'),
        bold: t('toolbar.bold'),
        italic: t('toolbar.italic'),
        strike: t('toolbar.strike'),
        heading: t('toolbar.heading'),
        quote: t('toolbar.quote'),
        codeBlock: t('toolbar.codeBlock'),
        bulletList: t('toolbar.bulletList'),
        orderedList: t('toolbar.orderedList'),
        taskList: t('toolbar.taskList'),
        link: t('toolbar.link'),
        linkPrompt: t('toolbar.linkPrompt'),
        image: t('toolbar.image'),
        table: t('toolbar.table'),
      },
      table: {
        addRow: t('table.addRow'),
        addRowLabel: t('table.addRowLabel'),
        addColumn: t('table.addColumn'),
        addColumnLabel: t('table.addColumnLabel'),
        deleteRow: t('table.deleteRow'),
        deleteRowLabel: t('table.deleteRowLabel'),
        deleteColumn: t('table.deleteColumn'),
        deleteColumnLabel: t('table.deleteColumnLabel'),
        deleteTable: t('table.deleteTable'),
      },
      status: {
        saved: t('status.saved'),
        saving: t('status.saving'),
        offline: t('status.offline'),
        offlineDetail: t('status.offlineDetail'),
        tooLarge: t('status.tooLarge'),
      },
      tooLarge: {
        title: t('tooLarge.title'),
        body: t('tooLarge.body'),
        reload: t('tooLarge.reload'),
        newPageNewTab: t('tooLarge.newPageNewTab'),
      },
    }),
    [t, tMarkdown],
  );
}

export interface PageEditorHostProps {
  pageId: string;
  /** `PageDto.bodyState` — the stored Yjs state, base64. */
  bodyState: string;
  /** `PageDto.canEdit`. */
  canEdit: boolean;
}

export function PageEditorHost({ pageId, bodyState, canEdit }: PageEditorHostProps) {
  const messages = usePageEditorMessages();
  const theme = useOptionalTheme()?.resolvedPattern ?? 'light';
  // Read once: the editor reads `initialState` at mount and owns the doc after.
  const [initialState] = useState(() => decodeBase64(bodyState));

  const saveUpdate = useCallback((update: Uint8Array) => sendPageUpdate(pageId, update), [pageId]);
  const uploadImage = useCallback((file: File) => uploadPageImage(pageId, file), [pageId]);

  // ── The leave guard ───────────────────────────────────────────────────────
  const statusRef = useRef<SaveStatus>('saved');
  const discardingRef = useRef(false);
  const onSaveStatusChange = useCallback((status: SaveStatus) => {
    statusRef.current = status;
  }, []);
  useEffect(() => {
    if (!canEdit) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (discardingRef.current || statusRef.current === 'saved') return;
      event.preventDefault();
      // Older browsers read the prompt from `returnValue`; the text is ignored.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [canEdit]);

  const onReloadSaved = useCallback(() => {
    discardingRef.current = true;
    window.location.reload();
  }, []);

  // **New page in a new tab**: the tab is opened INSIDE the click so no popup
  // blocker refuses it, then pointed at the page once `POST /api/pages` answers.
  const onNewPage = useCallback(() => {
    const tab = window.open('about:blank', '_blank');
    void (async () => {
      try {
        const res = await fetch('/api/pages', { method: 'POST' });
        if (!res.ok) throw new Error(`Page create failed with HTTP ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        if (tab) {
          tab.opener = null;
          tab.location.href = `/pages/${encodeURIComponent(id)}`;
        }
      } catch {
        tab?.close();
      }
    })();
  }, []);

  return (
    <PageEditor
      initialState={initialState}
      editable={canEdit}
      saveUpdate={saveUpdate}
      uploadImage={uploadImage}
      messages={messages}
      theme={theme}
      onSaveStatusChange={onSaveStatusChange}
      onReloadSaved={onReloadSaved}
      onNewPage={onNewPage}
    />
  );
}

export default PageEditorHost;
