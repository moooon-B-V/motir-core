'use client';

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { PageVersionDto } from '@/lib/dto/pages';
import { VersionAvatar, VersionTime } from './PageHistoryPanel';

// One version shown BESIDE the current page (Story MOTIR-5754 · MOTIR-7387),
// drawn by `design/pages/page--history.mock.html` state 7's version column.
//
// ⚠️ NO SECOND RENDERER. The version is rendered by the same `PageEditorHost`
// the page uses, read-only (`canEdit={false}`) over the version's own Yjs state,
// so a version looks exactly as it did. It is keyed by the version number: each
// version is its own editor and its own `Y.Doc`, and never shares one with the
// live editor beside it. A read-only host registers no leave guard and sends
// nothing.
//
// Its own `<Suspense>`: the editor's code is lazy, and a suspension here must
// not bubble to the route's boundary and swap the whole page for its frame.
const PageEditorHost = lazy(() => import('@/components/pages/PageEditorHost'));

export interface PageVersionViewProps {
  pageId: string;
  number: number;
  viewerId: string;
  onClose: () => void;
  /** `GET …/versions/<n>` answered 404 `PAGE_VERSION_NOT_FOUND`: the version was pruned. */
  onGone: (number: number) => void;
  /** Where the restore card mounts its control, beside the version's head. */
  restoreSlot?: (version: PageVersionDto) => ReactNode;
  /** Drawn under the head (a restore's refusal or hold). */
  notice?: ReactNode;
}

/** The version, `'gone'` for a 404 `PAGE_VERSION_NOT_FOUND`, or `null` for any other failure. */
async function readVersion(
  pageId: string,
  number: number,
): Promise<PageVersionDto | 'gone' | null> {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/versions/${number}`);
    const body = (await res.json()) as PageVersionDto | { code?: unknown };
    if (res.ok) return body as PageVersionDto;
    return 'code' in body && body.code === 'PAGE_VERSION_NOT_FOUND' ? 'gone' : null;
  } catch {
    return null;
  }
}

type VersionState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; version: PageVersionDto; now: Date };

export function PageVersionView({
  pageId,
  number,
  viewerId,
  onClose,
  onGone,
  restoreSlot,
  notice,
}: PageVersionViewProps) {
  const t = useTranslations('pages.history');
  const [state, setState] = useState<VersionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const onGoneRef = useRef(onGone);
  useEffect(() => {
    onGoneRef.current = onGone;
  }, [onGone]);

  // Keyed by number in `PageView`, so a mount starts at loading and a retry sets
  // it in its own handler. An answer for a closed view is dropped.
  useEffect(() => {
    let live = true;
    void readVersion(pageId, number).then((result) => {
      if (!live) return;
      if (result === 'gone') onGoneRef.current(number);
      else if (result === null) setState({ kind: 'failed' });
      else setState({ kind: 'ready', version: result, now: new Date() });
    });
    return () => {
      live = false;
    };
  }, [pageId, number, attempt]);

  const ready = state.kind === 'ready' ? state : null;
  const author = ready
    ? ready.version.authorId === viewerId
      ? t('you')
      : ready.version.authorName
    : null;

  return (
    <section
      aria-label={t('versionLabel', { number })}
      data-testid="page-version-view"
      className="flex min-w-0 flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft)"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-(--el-border) px-(--spacing-card-padding) py-2.5">
        <span className="text-[13.5px] font-semibold text-(--el-text) tabular-nums">
          {t('version', { number })}
        </span>
        {ready ? (
          <>
            <VersionAvatar id={ready.version.authorId} name={ready.version.authorName} />
            <span className="truncate text-[13px] text-(--el-text-secondary)">{author}</span>
            <VersionTime iso={ready.version.savedAt} now={ready.now} />
          </>
        ) : null}
        <span className="flex-1" />
        {ready && restoreSlot ? restoreSlot(ready.version) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('compare.close', { number })}
          className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-icon-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {notice}
      <div className="px-(--spacing-card-padding) py-3">
        {state.kind === 'ready' ? (
          <Suspense fallback={<VersionFrame />}>
            <PageEditorHost
              key={state.version.number}
              pageId={pageId}
              bodyState={state.version.bodyState}
              canEdit={false}
            />
          </Suspense>
        ) : state.kind === 'failed' ? (
          <div role="alert" className="flex items-center gap-2">
            <TriangleAlert className="h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
            <span className="flex-1 text-sm text-(--el-text)">{t('loadFailed')}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setState({ kind: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : (
          <VersionFrame />
        )}
      </div>
    </section>
  );
}

/** The version's paragraph bars while it reads. */
function VersionFrame() {
  const t = useTranslations('pages.history');
  return (
    <div data-testid="page-version-loading">
      <p role="status" className="sr-only">
        {t('loading')}
      </p>
      <div aria-hidden className="flex flex-col gap-2.5">
        <div className="h-3.5 w-[92%] rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-3.5 w-[78%] rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-3.5 w-[86%] rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-3.5 w-[40%] rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </div>
  );
}
