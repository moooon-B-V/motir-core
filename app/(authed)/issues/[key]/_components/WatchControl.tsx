'use client';

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Search, TriangleAlert, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { useShortcut } from '@/lib/hooks/useShortcut';
import { cn } from '@/lib/utils/cn';
import type { WatcherDto, WatchersPageDto } from '@/lib/dto/watchers';
import { Avatar } from '../../_components/issueCellPrimitives';
import { addWatcherAction, removeWatcherAction, toggleWatchAction } from '../watcherActions';

// The watch control + watchers popover (Story 5.4 · Subtask 5.4.9), per
// design/work-items/labels-components-watch.mock.html panels 4–6: the eye +
// count button in the detail header's ml-auto cluster (outline when not
// watching; the eye FILLS with --el-accent, accent border + semibold accent
// count when watching), toggling self-watch optimistically — reconciled from
// the action RESPONSE, no router.refresh (the inline-edit rule) — with the
// `W` shortcut (input-guarded via useShortcut) and the watchers popover.
//
// The click gesture is composite, per the Story 5.4 verification recipe
// ("click (or press W) → you watch, count bumps; the popover lists
// watchers"): a click on the closed control toggles self-watch AND opens the
// popover in the same gesture; `W` toggles quietly without opening it; Esc /
// outside click closes (Radix returns focus to the eye). A `viewer` gets the
// control too — watching is not editing (the verified permission split).
//
// The popover (a labelled dialog): `Watchers · N` head, paged Avatar · name
// rows ("Show more (N more)"), your own row marked with the neutral You
// pill; admins (the fetched page's `canManage` — project admin / workspace
// owner-admin) additionally get the `Add a watcher…` member-picker row and a
// per-row remove ×. The typed no-view-access 422 surfaces INLINE under the
// candidate row (role="alert") — never the Jira silent drop.

/** A workspace member the admin add-row can offer (the page's member set). */
export interface WatchCandidate {
  id: string;
  name: string;
  email: string;
}

// The mock's exact lucide-eye paths, classed so the watching state can fill
// the outer shape with accent and knock the pupil out in page-bg (panel 4) —
// a treatment the stock <Eye /> component can't express.
function EyeGlyph({ watching }: { watching: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-4 w-4', watching ? 'text-(--el-accent)' : 'text-(--el-text-muted)')}
      aria-hidden
    >
      <path
        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
        fill={watching ? 'var(--el-accent)' : 'none'}
      />
      <circle
        cx="12"
        cy="12"
        r="3"
        fill={watching ? 'var(--el-page-bg)' : 'none'}
        stroke={watching ? 'none' : 'currentColor'}
      />
    </svg>
  );
}

export function WatchControl({
  workItemId,
  initialCount,
  initialWatching,
  currentUserId,
  candidates,
}: {
  workItemId: string;
  initialCount: number;
  initialWatching: boolean;
  currentUserId: string;
  candidates: WatchCandidate[];
}) {
  const t = useTranslations('issueViews');
  const { toast } = useToast();
  const [, startTransition] = useTransition();

  const [watching, setWatching] = useState(initialWatching);
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(false);

  // The popover's paged roster — fetched on open from the 5.4.4 list route
  // (reads stay HTTP; mutations go through the actions). `page` is null
  // until the first window lands (the row-skeleton state).
  const [rows, setRows] = useState<WatcherDto[] | null>(null);
  const [pageMeta, setPageMeta] = useState<Pick<
    WatchersPageDto,
    'totalCount' | 'nextCursor' | 'canManage'
  > | null>(null);
  const [listError, setListError] = useState(false);
  const [query, setQuery] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  // Drops a stale list response that resolves after a newer one.
  const fetchSeq = useRef(0);
  // The popover state as a ref — the toggle's async success handler must see
  // the CURRENT open state, not the one its closure captured (the composite
  // click opens the popover in the same tick it fires the toggle).
  const openRef = useRef(false);

  const loadPage = useCallback(
    async (cursor?: string) => {
      const seq = ++fetchSeq.current;
      setListError(false);
      try {
        const url = `/api/work-items/${encodeURIComponent(workItemId)}/watchers${
          cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        }`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const page = (await res.json()) as WatchersPageDto;
        if (seq !== fetchSeq.current) return;
        setRows((cur) => (cursor && cur ? [...cur, ...page.watchers] : page.watchers));
        // The header count is NOT overwritten here — the list read races the
        // in-flight toggle on the composite click; the eye reconciles from
        // the toggle action's own response (the inline-edit rule).
        setPageMeta({
          totalCount: page.totalCount,
          nextCursor: page.nextCursor,
          canManage: page.canManage,
        });
      } catch {
        if (seq === fetchSeq.current) setListError(true);
      }
    },
    [workItemId],
  );

  // Self watch/unwatch — optimistic: state + count flip immediately and the
  // action response reconciles them; a failure rolls both back with the
  // toast grammar (panel 6). Tabular-nums keep the cluster from shifting.
  const toggle = useCallback(() => {
    const next = !watching;
    setWatching(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    startTransition(async () => {
      const res = await toggleWatchAction({ workItemId, watch: next });
      if (res.ok) {
        setWatching(res.watching);
        setCount(res.watcherCount);
        // Keep an open roster in sync with the committed toggle — the
        // composite click's initial list read races the toggle transaction,
        // so re-read the first window once the toggle has landed (the ref
        // sees the CURRENT open state, not the closure's).
        if (openRef.current) void loadPage();
      } else {
        setWatching(!next);
        setCount((c) => Math.max(0, c + (next ? -1 : 1)));
        toast({ variant: 'error', title: t('watchToggleFailedTitle'), description: res.error });
      }
    });
  }, [watching, workItemId, loadPage, toast, t]);

  useShortcut('w', toggle);

  // The composite click (see the header comment): toggle self-watch, and
  // open the roster when the popover is closed (a second click closes it —
  // and, consistently, toggles back).
  function setOpenSynced(next: boolean) {
    openRef.current = next;
    setOpen(next);
  }

  function onTriggerClick() {
    if (!open) {
      setOpenSynced(true);
      setRows(null);
      setPageMeta(null);
      setQuery('');
      setAddError(null);
      void loadPage();
    } else {
      setOpenSynced(false);
    }
    toggle();
  }

  function addWatcher(candidate: WatchCandidate) {
    setAddError(null);
    startTransition(async () => {
      const res = await addWatcherAction({
        workItemId,
        userId: candidate.id,
        userName: candidate.name,
      });
      if (res.ok) {
        setRows((cur) =>
          cur ? [...cur.filter((w) => w.userId !== res.watcher.userId), res.watcher] : cur,
        );
        setPageMeta((cur) => (cur ? { ...cur, totalCount: res.watcherCount } : cur));
        setCount(res.watcherCount);
        setQuery('');
      } else {
        setAddError(res.error);
      }
    });
  }

  function removeWatcher(target: WatcherDto) {
    startTransition(async () => {
      const res = await removeWatcherAction({ workItemId, userId: target.userId });
      if (res.ok) {
        setRows((cur) => (cur ? cur.filter((w) => w.userId !== target.userId) : cur));
        setPageMeta((cur) => (cur ? { ...cur, totalCount: res.watcherCount } : cur));
        setCount(res.watcherCount);
        if (target.userId === currentUserId) setWatching(false);
      } else {
        setAddError(res.error);
      }
    });
  }

  const trimmed = query.trim().toLowerCase();
  const watcherIds = useMemo(() => new Set((rows ?? []).map((w) => w.userId)), [rows]);
  const matches =
    trimmed.length === 0
      ? []
      : candidates
          .filter((c) => !watcherIds.has(c.id))
          .filter(
            (c) =>
              c.name.toLowerCase().includes(trimmed) || c.email.toLowerCase().includes(trimmed),
          )
          .slice(0, 8);

  const ariaLabel = watching ? t('stopWatchingAria', { count }) : t('watchAria', { count });
  const canManage = pageMeta?.canManage ?? false;
  const remaining = pageMeta ? pageMeta.totalCount - (rows?.length ?? 0) : 0;

  return (
    <Popover open={open} onOpenChange={setOpenSynced}>
      <Tooltip
        content={
          <span className="inline-flex items-center gap-1.5">
            {watching ? t('stopWatchingTooltip') : t('watchTooltip')}
            <kbd className="rounded-(--radius-kbd) bg-[rgba(255,255,255,0.18)] px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[10px]">
              W
            </kbd>
          </span>
        }
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            onClick={(e) => {
              // Radix toggles `open` on trigger click itself; the composite
              // gesture owns that state, so keep the default out of the way.
              e.preventDefault();
              onTriggerClick();
            }}
            aria-pressed={watching}
            aria-label={ariaLabel}
            className={cn(
              'inline-flex items-center gap-1.5 border font-sans text-[13px] font-medium',
              'h-(--height-control) rounded-(--radius-btn) px-(--spacing-control-x)',
              'bg-(--el-page-bg) hover:bg-(--el-surface)',
              'focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
              watching ? 'border-(--el-accent)' : 'border-(--el-border)',
            )}
          >
            <EyeGlyph watching={watching} />
            <span
              className={cn(
                'tabular-nums',
                watching ? 'font-semibold text-(--el-accent)' : 'text-(--el-text-secondary)',
              )}
            >
              {count}
            </span>
          </button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Content
        role="dialog"
        aria-label={t('watchersDialogLabel')}
        align="end"
        width={288}
        className="p-1"
      >
        <div className="px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-[11px] font-semibold tracking-[0.06em] text-(--el-text-faint) uppercase">
          {t('watchersHeading', { count: pageMeta?.totalCount ?? count })}
        </div>

        {canManage ? (
          <div className="mb-1">
            <div className="flex items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-sm">
              <Search className="h-3.5 w-3.5 shrink-0 text-(--el-text-muted)" aria-hidden />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setAddError(null);
                }}
                placeholder={t('watchersAddPlaceholder')}
                aria-label={t('watchersAddPlaceholder')}
                className="w-full bg-transparent text-(--el-text) placeholder:text-(--el-text-muted) focus:outline-none"
              />
            </div>
            {trimmed.length > 0 ? (
              matches.length > 0 ? (
                matches.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => addWatcher(candidate)}
                    className="flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <Avatar name={candidate.name} />
                    <span className="min-w-0 flex-1 truncate font-sans text-sm text-(--el-text)">
                      {candidate.name}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-muted)">
                  {t('watchersNoMatches')}
                </p>
              )
            ) : null}
            {addError ? (
              <p
                role="alert"
                className="mb-1 flex items-start gap-1.5 px-(--spacing-control-x) font-sans text-xs leading-[1.45] text-(--el-danger)"
              >
                <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}

        {listError ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-danger)"
          >
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('watchersLoadError')}
          </p>
        ) : rows === null ? (
          // The pulse skeleton at row size (panel 6's grammar).
          <div
            className="flex flex-col gap-1 px-(--spacing-control-x) py-(--spacing-control-y)"
            aria-busy
          >
            <span className="h-[22px] w-2/3 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span className="h-[22px] w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          </div>
        ) : (
          <>
            {rows.map((watcher) => {
              const isSelf = watcher.userId === currentUserId;
              return (
                <div
                  key={watcher.userId}
                  className="flex items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface)"
                >
                  <Avatar name={watcher.name} />
                  <span className="min-w-0 flex-1 truncate font-sans text-sm text-(--el-text)">
                    {watcher.name}
                  </span>
                  {isSelf ? (
                    <Pill tone="neutral">{t('watchersYou')}</Pill>
                  ) : canManage ? (
                    <button
                      type="button"
                      onClick={() => removeWatcher(watcher)}
                      aria-label={t('watchersRemove', { name: watcher.name })}
                      className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {pageMeta?.nextCursor ? (
              <button
                type="button"
                onClick={() => void loadPage(pageMeta.nextCursor ?? undefined)}
                className="w-full rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-[13px] text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                {t('watchersShowMore', { count: Math.max(0, remaining) })}
              </button>
            ) : null}
          </>
        )}
      </Popover.Content>
    </Popover>
  );
}
