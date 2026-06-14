'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Inbox } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { Spinner } from '@/components/ui/Spinner';
import type { TriageQueueItemDto, TriageItemDetailDto } from '@/lib/dto/triage';
import { useReport } from '../../_components/ReportProvider';
import { TriageQueue } from './TriageQueue';
import { TriageDetail, type TriageActionHandlers } from './TriageDetail';
import type { PromoteTarget } from './PromotePopover';

// The triage inbox client island (Subtask 6.11.6) — owns the queue + detail
// state and the action handlers. The 2-pane grid (380px queue · 1fr detail)
// lives in a Card-style bordered container that collapses to one column below
// 880px (a container query on the wrapper). Selecting a row fetches + caches its
// detail; a terminal action optimistically removes the item from the queue and
// toasts. Mutations are seq-guarded (an older response can't clobber a newer
// optimistic state) and revert on error — no router.refresh in any success path
// (the inline-edit-no-tree-refresh rule).

export interface TriageInboxProps {
  initialItems: TriageQueueItemDto[];
  initialNextCursor: string | null;
  projectKey: string;
  projectName: string;
}

type ActionKind = 'accept' | 'promote' | 'merge' | 'snooze' | 'decline';

export function TriageInbox({ initialItems, initialNextCursor, projectKey }: TriageInboxProps) {
  const t = useTranslations('triage');
  const format = useFormatter();
  const { toast } = useToast();

  const [items, setItems] = useState<TriageQueueItemDto[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(initialItems[0]?.id ?? null);
  const [detailCache, setDetailCache] = useState<Record<string, TriageItemDetailDto>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Monotonic stamp so an older terminal-action response can't clobber a newer
  // optimistic state (the seq-guard the CLAUDE.md optimistic rule requires). A
  // busy ref backs the in-flight guard so the action callbacks stay stable
  // (no `busy` dep) and never read a ref during render.
  const seqRef = useRef(0);
  const busyRef = useRef(false);

  // A new submission from the in-app report widget (6.11.7) lands in THIS queue
  // but is created on a different surface (the shell/inbox-header modal). The
  // widget bumps ReportProvider's `submissionsChangedAt` tick on success; we
  // refetch page 1 so the new row appears. `router.refresh()` alone can't do this
  // — this island seeds `items` from `useState(initialItems)`, whose initializer
  // runs once, so a server re-render never reaches it (the page-state-after-
  // mutation rule). Background refresh: silent on failure (not user-initiated),
  // and selection survives if its row is still present.
  const { submissionsChangedAt } = useReport();
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/triage/queue`);
        if (cancelled || !res.ok) return;
        const page = (await res.json()) as {
          items: TriageQueueItemDto[];
          nextCursor: string | null;
        };
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setSelectedId((cur) =>
          cur && page.items.some((i) => i.id === cur) ? cur : (page.items[0]?.id ?? null),
        );
      } catch {
        // Non-fatal; the next action or navigation re-reads the queue.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionsChangedAt, projectKey]);

  const selectRow = useCallback(
    async (id: string) => {
      setSelectedId(id);
      if (detailCache[id]) return;
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/work-items/${id}/triage/detail`);
        if (res.ok) {
          const detail = (await res.json()) as TriageItemDetailDto;
          setDetailCache((prev) => ({ ...prev, [id]: detail }));
        } else {
          toast({ variant: 'error', title: t('toast.error') });
        }
      } catch {
        toast({ variant: 'error', title: t('toast.error') });
      } finally {
        setDetailLoading(false);
      }
    },
    [detailCache, toast, t],
  );

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/triage/queue?cursor=${encodeURIComponent(
          nextCursor,
        )}`,
      );
      if (res.ok) {
        const page = (await res.json()) as {
          items: TriageQueueItemDto[];
          nextCursor: string | null;
        };
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      } else {
        toast({ variant: 'error', title: t('toast.error') });
      }
    } catch {
      toast({ variant: 'error', title: t('toast.error') });
    } finally {
      setLoadingMore(false);
    }
  }

  // Run a terminal action: optimistically remove the row + advance selection,
  // toast on success, revert on error. Stable (no `items`/`busy` deps) — it uses
  // functional state updates + a busy ref, so it never reads a ref during render
  // and the per-action handlers below stay referentially stable. The seq-guard
  // means a stale failure of an already-superseded action won't restore a row a
  // later action removed.
  const runTerminal = useCallback(
    async (
      id: string,
      kind: ActionKind,
      request: () => Promise<Response>,
      successTitle: string,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const seq = ++seqRef.current;
      setBusy(true);

      // Snapshot for revert + advance the selection, both via functional updates.
      let prevItems: TriageQueueItemDto[] = [];
      setItems((prev) => {
        prevItems = prev;
        const idx = prev.findIndex((i) => i.id === id);
        const remaining = prev.filter((i) => i.id !== id);
        setSelectedId(
          remaining.length === 0
            ? null
            : (remaining[Math.min(idx, remaining.length - 1)]?.id ?? null),
        );
        return remaining;
      });

      try {
        const res = await request();
        if (!res.ok) throw new Error(`${kind} failed`);
        if (seqRef.current === seq) toast({ variant: 'success', title: successTitle });
      } catch {
        if (seqRef.current === seq) {
          setItems(prevItems);
          setSelectedId(id);
          toast({ variant: 'error', title: t('toast.error') });
        }
      } finally {
        if (seqRef.current === seq) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [toast, t],
  );

  // The per-action handlers, stable + bound to the work-item id at call time.
  const handlers = useMemo<TriageActionHandlers>(
    () => ({
      onAccept: (id) =>
        runTerminal(
          id,
          'accept',
          () =>
            fetch(`/api/work-items/${id}/triage/accept`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            }),
          t('toast.promotedBacklog'),
        ),
      onPromote: (id, target: PromoteTarget) => {
        const body: { parentId?: string | null; sprintId?: string | null } = {};
        if (target.kind === 'backlog') {
          body.parentId = null;
          body.sprintId = null;
        } else if (target.kind === 'sprint') {
          body.sprintId = target.sprintId;
        } else {
          body.parentId = target.parentId;
        }
        return runTerminal(
          id,
          'promote',
          () =>
            fetch(`/api/work-items/${id}/triage/promote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
          t('toast.promoted'),
        );
      },
      onMerge: (id, canonicalId: string, canonicalKey: string) =>
        runTerminal(
          id,
          'merge',
          () =>
            fetch(`/api/work-items/${id}/triage/duplicate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ canonicalId }),
            }),
          t('toast.merged', { key: canonicalKey }),
        ),
      onSnooze: (id, snoozedUntilIso: string) =>
        runTerminal(
          id,
          'snooze',
          () =>
            fetch(`/api/work-items/${id}/triage/snooze`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ snoozedUntil: snoozedUntilIso }),
            }),
          t('toast.snoozed', {
            day: format.dateTime(new Date(snoozedUntilIso), { weekday: 'long' }),
          }),
        ),
      onDecline: (id, comment: string) =>
        runTerminal(
          id,
          'decline',
          () =>
            fetch(`/api/work-items/${id}/triage/decline`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(comment.trim() ? { comment: comment.trim() } : {}),
            }),
          t('toast.declined'),
        ),
    }),
    [runTerminal, t, format],
  );

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="h-12 w-12" aria-hidden />}
        title={t('empty.title')}
        description={t('empty.description')}
      />
    );
  }

  const detail = selectedId ? detailCache[selectedId] : undefined;

  return (
    <div className="@container">
      <div className="grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-(--radius-card) border border-(--el-border) shadow-(--shadow-card) @[880px]:grid-cols-[380px_1fr]">
        <div className="flex min-h-0 flex-col border-(--el-border) @[880px]:border-r">
          <TriageQueue
            items={items}
            selectedId={selectedId}
            onSelect={selectRow}
            hasMore={nextCursor !== null}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        </div>

        <div className="flex min-h-0 flex-col">
          {detail ? (
            <TriageDetail detail={detail} busy={busy} handlers={handlers} />
          ) : detailLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-(--el-text-muted)">
              <Spinner size="sm" aria-hidden />
              {t('detailLoading')}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
              <Inbox className="h-8 w-8 text-(--el-text-faint)" aria-hidden />
              <p className="text-sm font-medium text-(--el-text)">{t('selectPrompt')}</p>
              <p className="max-w-prose text-sm text-(--el-text-muted)">{t('selectPromptBody')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
