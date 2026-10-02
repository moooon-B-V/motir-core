'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { History, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { PageVersionListDto, PageVersionListItemDto } from '@/lib/dto/pages';
import { cn } from '@/lib/utils/cn';

// The page's HISTORY PANEL (Story MOTIR-5754 · MOTIR-7387), drawn by
// `design/pages/page--history.mock.html` states 2–6 and 14 and specified in
// `design/pages/design-notes.md` § History.
//
// It reads `GET /api/pages/<id>/versions` and pages it by FOLLOWING `nextBefore`
// — never a client-side slice: a page keeps up to 100 versions and each response
// is bounded. `refreshKey` re-reads from the top (a version the panel listed was
// pruned, or a restore added one).
//
// ⚠️ WHERE IT SITS. At `xl` (1280px+) it is a column BESIDE the page, so the page
// stays readable while the list is open. Below that it is an overlay sheet from
// the right over the scrim — the design's narrow board. Same element, two
// placements, so focus and state never depend on the viewport.

const SKELETON_ROWS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The design's avatar ramp for a version row, picked by user id. */
const AVATAR_TINTS = [
  'bg-(--el-avatar-lavender)',
  'bg-(--el-avatar-sky)',
  'bg-(--el-avatar-mint)',
] as const;

function tintFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]!;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/** A version's author avatar — decorative; the name beside it carries the meaning. */
export function VersionAvatar({ id, name }: { id: string; name: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-(--el-text-strong)',
        tintFor(id),
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Relative under 24 hours, absolute after — the design's one rule for a version's time. */
export function VersionTime({ iso, now }: { iso: string; now: Date }) {
  const format = useFormatter();
  const date = new Date(iso);
  const label =
    now.getTime() - date.getTime() < DAY_MS
      ? format.relativeTime(date, now)
      : format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <time
      dateTime={iso}
      title={format.dateTime(date, { dateStyle: 'full', timeStyle: 'long' })}
      className="shrink-0 text-[12.5px] text-(--el-text-secondary)"
    >
      {label}
    </time>
  );
}

export interface PageHistoryPanelProps {
  pageId: string;
  /** The reader's id, so their own versions read "You". */
  viewerId: string;
  /** The version shown in compare, or `null`. */
  selected: number | null;
  /** Press a row: a number opens it in compare; `null` (the Current row, or the selected row again) closes compare. */
  onSelect: (number: number | null) => void;
  onClose: () => void;
  /** Bump to re-read the list from the top. */
  refreshKey: number;
  /** A callout drawn above the list (a version that is gone, a restore's refusal). */
  notice?: React.ReactNode;
  /** The rows to look busy for: while a restore is in flight nothing can be pressed. */
  busy?: boolean;
  /** Where focus lands on open. */
  initialFocusRef?: RefObject<HTMLButtonElement | null>;
}

interface ListState {
  kind: 'loading' | 'failed' | 'ready';
  items: PageVersionListItemDto[];
  nextBefore: number | null;
  /** The instant the rows' relative times are measured from. */
  now: Date;
  more: 'idle' | 'loading' | 'failed';
}

const INITIAL: ListState = {
  kind: 'loading',
  items: [],
  nextBefore: null,
  now: new Date(0),
  more: 'idle',
};

async function readVersions(pageId: string, before?: number): Promise<PageVersionListDto> {
  const query = before === undefined ? '' : `?before=${before}`;
  const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/versions${query}`);
  if (!res.ok) throw new Error(`History read failed with HTTP ${res.status}`);
  return (await res.json()) as PageVersionListDto;
}

export function PageHistoryPanel({
  pageId,
  viewerId,
  selected,
  onSelect,
  onClose,
  refreshKey,
  notice,
  busy = false,
  initialFocusRef,
}: PageHistoryPanelProps) {
  const t = useTranslations('pages.history');
  const [state, setState] = useState<ListState>(INITIAL);
  const [attempt, setAttempt] = useState(0);
  const ownCloseRef = useRef<HTMLButtonElement>(null);
  const closeRef = initialFocusRef ?? ownCloseRef;

  // Focus moves into the panel on open.
  useEffect(() => {
    closeRef.current?.focus();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The first page. A refresh keeps the rows already shown until the new read
  // lands; a retry sets loading in its own handler. An answer to a read that a
  // newer one replaced (or to a closed panel) is dropped.
  useEffect(() => {
    let live = true;
    readVersions(pageId).then(
      (list) => {
        if (live) {
          setState({
            kind: 'ready',
            items: list.items,
            nextBefore: list.nextBefore,
            now: new Date(),
            more: 'idle',
          });
        }
      },
      () => {
        if (live) setState((prev) => ({ ...prev, kind: 'failed' }));
      },
    );
    return () => {
      live = false;
    };
  }, [pageId, refreshKey, attempt]);

  // The next page, appended in place. A row already shown is never added twice,
  // so a refresh that lands while this reads cannot duplicate one.
  const loadMore = (before: number) => {
    setState((prev) => ({ ...prev, more: 'loading' }));
    readVersions(pageId, before).then(
      (list) =>
        setState((prev) => ({
          ...prev,
          items: [
            ...prev.items,
            ...list.items.filter((v) => !prev.items.some((p) => p.number === v.number)),
          ],
          nextBefore: list.nextBefore,
          more: 'idle',
        })),
      () => setState((prev) => ({ ...prev, more: 'failed' })),
    );
  };

  const retry = () => {
    setState(INITIAL);
    setAttempt((n) => n + 1);
  };
  const before = state.nextBefore;

  return (
    <>
      <div
        aria-hidden
        data-testid="page-history-scrim"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-(--el-overlay-scrim) xl:hidden"
      />
      <aside
        id="page-history"
        aria-labelledby="page-history-title"
        aria-busy={busy || undefined}
        inert={busy || undefined}
        className="fixed inset-y-0 right-0 z-50 flex w-[340px] max-w-full flex-col border-l border-(--el-border) bg-(--el-page-bg) shadow-(--shadow-modal) xl:sticky xl:top-0 xl:z-auto xl:max-h-dvh xl:shrink-0 xl:shadow-none"
      >
        <div className="flex items-center gap-2 border-b border-(--el-border) px-4 py-3">
          <History className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
          <h2 id="page-history-title" className="flex-1 text-sm font-semibold text-(--el-text)">
            {t('title')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-icon-muted) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {busy ? <div aria-hidden className="h-0.5 w-full animate-pulse bg-(--el-accent)" /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {notice}
          {state.kind === 'loading' ? (
            <>
              <p role="status" className="sr-only">
                {t('loading')}
              </p>
              <div
                aria-hidden
                data-testid="page-history-skeleton"
                className="flex flex-col gap-0.5"
              >
                {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 px-(--spacing-control-x) py-(--spacing-control-y)"
                  >
                    <span className="h-6 w-6 shrink-0 rounded-full bg-(--el-muted)" />
                    <span className="flex flex-1 flex-col gap-1.5">
                      <span className="h-3 w-[70%] rounded-(--radius-control) bg-(--el-muted)" />
                      <span className="h-3 w-[45%] rounded-(--radius-control) bg-(--el-muted)" />
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : state.kind === 'failed' ? (
            <LoadFailed onRetry={retry} />
          ) : (
            <>
              <ol aria-label={t('listLabel')} className="flex flex-col gap-0.5">
                {state.items.map((version) => (
                  <li key={version.number}>
                    <VersionRow
                      version={version}
                      viewerId={viewerId}
                      now={state.now}
                      selected={selected === version.number}
                      onPress={() =>
                        onSelect(
                          version.isCurrent || selected === version.number ? null : version.number,
                        )
                      }
                    />
                  </li>
                ))}
              </ol>
              {state.items.length === 1 && state.nextBefore === null ? (
                <p className="px-(--spacing-control-x) pt-2 text-[12.5px] text-(--el-text-secondary)">
                  {t('onlyVersion')}
                </p>
              ) : null}
              {before === null ? null : state.more === 'failed' ? (
                <LoadFailed onRetry={() => loadMore(before)} />
              ) : (
                <div className="px-(--spacing-control-x) pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    loading={state.more === 'loading'}
                    onClick={() => loadMore(before)}
                  >
                    {t('loadMore')}
                  </Button>
                </div>
              )}
              {before !== null || state.items.length > 1 ? (
                <p className="px-(--spacing-control-x) pt-2 text-[12.5px] text-(--el-text-secondary)">
                  {t('keepsLatest')}
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('pages.history');
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-(--spacing-control-x) py-(--spacing-control-y)"
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <span className="flex-1 text-sm text-(--el-text)">{t('loadFailed')}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

function VersionRow({
  version,
  viewerId,
  now,
  selected,
  onPress,
}: {
  version: PageVersionListItemDto;
  viewerId: string;
  now: Date;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTranslations('pages.history');
  const author = version.authorId === viewerId ? t('you') : version.authorName;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-current={version.isCurrent ? 'true' : undefined}
      onClick={onPress}
      data-testid={`page-version-${version.number}`}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
        selected
          ? 'border border-(--el-border) bg-(--el-surface)'
          : 'border border-transparent hover:bg-(--el-surface-soft)',
      )}
    >
      <VersionAvatar id={version.authorId} name={version.authorName} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-(--el-text) tabular-nums">
            <span aria-hidden>{t('version', { number: version.number })}</span>
            <span className="sr-only">{t('versionLabel', { number: version.number })}</span>
          </span>
          {version.isCurrent ? (
            <span className="rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11.5px] text-(--el-text-strong)">
              {t('current')}
            </span>
          ) : null}
          <span className="flex-1" />
          <VersionTime iso={version.savedAt} now={now} />
        </span>
        <span className="truncate text-[13px] text-(--el-text-secondary)">{author}</span>
        {version.restoredFromNumber !== null ? (
          <span className="flex items-center gap-1 text-[12.5px] text-(--el-text-secondary)">
            <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
            <span>
              {t('restoredFrom', { number: version.restoredFromNumber })}
              {version.restoredFromKept ? null : (
                <>
                  {' '}
                  <em>{t('noLongerKept')}</em>
                </>
              )}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** The danger callout the history draws for a refusal (states 11 and 12). */
export function HistoryNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="mb-2 flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] text-(--el-danger-surface-text)"
    >
      <TriangleAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
        aria-hidden
      />
      <span>{children}</span>
    </div>
  );
}
