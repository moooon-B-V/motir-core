'use client';

import { lazy, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

// The page at its own address (Story MOTIR-5752 · MOTIR-7280), drawn by
// `design/pages/page.mock.html` states 6–10: the title, then the editor. The
// "← Pages" link sits ABOVE this view in `page.tsx`, outside the boundary,
// because it is static (state 11).
//
// ⚠️ THE EDITOR IS LOADED LAZILY, and that is what the route's in-page
// `<Suspense>` waits on. The page's server read is its GATE — it decides
// existence, so it must settle before anything streams or a missing page would
// 404 under a 200 (CLAUDE.md § A `loading.tsx` may NOT sit above a route that
// decides existence). What is left to wait for after the gate is the editor's own
// code (Tiptap, ProseMirror and Yjs), so that is what the frame covers.
const PageEditorHost = lazy(() => import('@/components/pages/PageEditorHost'));

/** What the view needs of the page — `PageDto`, minus what it does not draw. */
export interface PageViewPage {
  id: string;
  title: string;
  /** The stored Yjs state, base64. */
  bodyState: string;
  canEdit: boolean;
}

export interface PageViewProps {
  page: PageViewPage;
  /** `PAGE_TITLE_MAX_LENGTH`, handed down so this client file imports no package. */
  titleMaxLength: number;
}

/** Quiet before a title edit is sent (the card: "after 800 ms of quiet"). */
export const TITLE_RENAME_QUIET_MS = 800;

/** The heading's size and place, shared by the field and the read-only `<h1>`. */
const TITLE_CLASS = 'block w-full font-serif text-2xl leading-8 font-semibold text-(--el-text)';

type RenameError = { kind: 'tooLong'; limit: number } | { kind: 'failed' } | null;

export function PageView({ page, titleMaxLength }: PageViewProps) {
  const t = useTranslations('pages');
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={rootRef} className="flex flex-col">
      {page.canEdit ? (
        <EditableTitle
          pageId={page.id}
          initialTitle={page.title}
          maxLength={titleMaxLength}
          onEnter={() =>
            rootRef.current
              ?.querySelector<HTMLElement>('.motir-page-editor [contenteditable]')
              ?.focus()
          }
        />
      ) : (
        <h1 className={`mt-3 ${TITLE_CLASS}`}>{page.title || t('untitled')}</h1>
      )}
      <div className="mt-3">
        <PageEditorHost pageId={page.id} bodyState={page.bodyState} canEdit={page.canEdit} />
      </div>
    </div>
  );
}

function EditableTitle({
  pageId,
  initialTitle,
  maxLength,
  onEnter,
}: {
  pageId: string;
  initialTitle: string;
  maxLength: number;
  onEnter: () => void;
}) {
  const t = useTranslations('pages');
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<RenameError>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The title last sent (or loaded), so nothing is sent twice; null after a failure. */
  const sentRef = useRef<string | null>(initialTitle);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stamps each rename so an older response never overwrites a newer one's verdict. */
  const seqRef = useRef(0);

  // A fresh page asks for its title first (state 6): focus lands in the field.
  useEffect(() => {
    if (initialTitle === '') inputRef.current?.focus();
    // Mount only: a later empty title is the writer's, not an arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const send = useCallback(
    async (next: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (next === sentRef.current) return;
      sentRef.current = next;
      const seq = ++seqRef.current;
      try {
        const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next }),
        });
        if (seq !== seqRef.current) return;
        if (res.ok) {
          setError(null);
          document.title = next || t('untitled');
          return;
        }
        // Not saved: let the next edit or blur try again.
        sentRef.current = null;
        if (res.status === 422) {
          const body = (await res.json().catch(() => ({}))) as { limit?: unknown };
          setError({
            kind: 'tooLong',
            limit: typeof body.limit === 'number' ? body.limit : maxLength,
          });
        } else {
          setError({ kind: 'failed' });
        }
      } catch {
        if (seq !== seqRef.current) return;
        sentRef.current = null;
        setError({ kind: 'failed' });
      }
    },
    [pageId, maxLength, t],
  );

  const onChange = (next: string) => {
    setTitle(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void send(next), TITLE_RENAME_QUIET_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onEnter();
  };

  const errorId = `page-title-error-${pageId}`;
  return (
    <div className="mt-3">
      <input
        ref={inputRef}
        type="text"
        value={title}
        maxLength={maxLength}
        placeholder={t('untitled')}
        aria-label={t('page.titleLabel')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => void send(title)}
        onKeyDown={onKeyDown}
        className={`${TITLE_CLASS} border-0 bg-transparent outline-none placeholder:text-(--el-text-muted)`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm text-(--el-danger-on-surface)">
          {error.kind === 'tooLong'
            ? t('page.titleTooLong', { limit: error.limit })
            : t('page.renameFailed')}
        </p>
      ) : null}
    </div>
  );
}
