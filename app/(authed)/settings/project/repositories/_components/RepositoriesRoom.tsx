'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { TakeoverRow } from './TakeoverRow';
import { TakeoverModal } from './TakeoverModal';
import type { ProjectRepoDto, ProjectRepoRoomViewDto } from '@/lib/dto/projectRepos';

// The TAKE-IT-OVER room's ROWS — the client island of
// `/settings/project/repositories` (Story MOTIR-1775 · MOTIR-1939).
//
// ⚠️ THE PAGE-STATE CONTRACT, ROUTED PER SURFACE (`CLAUDE.md`; design §14.10). A
// takeover changes surfaces that do NOT refresh the same way, and assuming
// `router.refresh()` covers all of them is the recurring bug:
//
//   1. THE ROW THAT WAS ACTED ON — the mutation's response IS the confirmation.
//      Its returned row is applied locally and deliberately NOT re-read; a
//      refresh here would re-read stale data and cause a visible revert.
//   2. THE HEADER SUMMARY + THE PAUSED BANNER — server-rendered from the room
//      read, so `router.refresh()` is what updates them. It is called after
//      every mutation for exactly that reason, and for nothing else.
//   3. THIS ISLAND — seeded from server props via `useState`, so
//      `router.refresh()` CANNOT reach it (the initializer runs once at mount).
//      It owns an explicit refetch, which is what `Check again` and the poll use.
//
// ⚠️ ROWS ARE INDEPENDENT (MOTIR-711: "taking over one row of three is
// legitimate and must not wedge the others"). `busyRowId` is a single row's id,
// never a set-level flag — one row's in-flight request leaves its siblings
// rendering and pressable.

/** How often an in-flight hand-off re-probes. `transfer_pending` and
 *  `awaiting_reinstall` resolve OUT OF BAND — a webhook, or an installation
 *  landing on GitHub — so neither is something a click on this page settles;
 *  the row is a polled async job, and this is that poll. Slow on purpose: the
 *  waits are measured in hours and days, and `Check again` is always there for a
 *  user who does not want to wait for the next tick. */
const POLL_MS = 20_000;

/** The takeover states that are still waiting on something to happen. */
const IN_FLIGHT = new Set(['requested', 'transfer_pending', 'awaiting_reinstall']);

export interface RepositoriesRoomProps {
  projectKey: string;
  view: ProjectRepoRoomViewDto;
  /** Where the connect prompt hands off — the shipped 7.10 Git-settings pane. */
  connectHref: string;
  /** The request's `now`, stamped once on the server (see `TakeoverRow`). */
  nowIso: string;
}

export function RepositoriesRoom({ projectKey, view, connectHref, nowIso }: RepositoriesRoomProps) {
  const t = useTranslations('repositoryTakeover');
  const router = useRouter();

  const [rows, setRows] = useState<ProjectRepoDto[]>(view.rows);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  // Mirrors `busyRowId` for the poll to read without re-creating the interval on
  // every busy flip. Written from EVENT handlers only — never during render.
  const busyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const [modalRow, setModalRow] = useState<ProjectRepoDto | null>(null);

  const takeoverUrl = (rowId: string) =>
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(rowId)}/takeover`;

  /** Surface 1 — keep what the mutation returned. Never re-read it. */
  const applyRow = useCallback((row: ProjectRepoDto) => {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
  }, []);

  /** Surface 3 — the island's own refetch. Silent: a background re-read must not
   *  flash the rows the user is looking at. */
  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/repositories`, {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { set?: { rows?: ProjectRepoDto[] } };
      if (body.set?.rows) setRows(body.set.rows);
    } catch {
      // A failed background read leaves the rendered rows alone — they are the
      // last thing the server actually said, which beats an error banner over
      // state that is still correct.
    }
  }, [projectKey]);

  /**
   * The two writes, which are the same endpoint at two moments: naming a target
   * STARTS the saga; naming none re-probes whether the re-install has landed.
   * Re-running any step is a no-op (MOTIR-711), so the probe is always safe.
   */
  const call = useCallback(
    async (row: ProjectRepoDto, body: { newOwner?: string }) => {
      setBusyRowId(row.id);
      busyRef.current = true;
      setFailed(false);
      try {
        const res = await fetch(takeoverUrl(row.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setFailed(true);
          // The row may still have MOVED (a refused transfer records `failed` on
          // it), so re-read rather than leaving the surface asserting a state the
          // server has since contradicted.
          await refetch();
          return;
        }
        const payload = (await res.json()) as ProjectRepoDto | { row: ProjectRepoDto };
        applyRow('row' in payload ? payload.row : payload);
        // Surface 2 — the server-rendered header summary + paused banner.
        router.refresh();
      } catch {
        setFailed(true);
      } finally {
        busyRef.current = false;
        setBusyRowId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyRow, refetch, router, projectKey],
  );

  const onConfirm = useCallback(
    (row: ProjectRepoDto, newOwner: string) => {
      setModalRow(null);
      void call(row, { newOwner });
    },
    [call],
  );

  const onCheckAgain = useCallback((row: ProjectRepoDto) => void call(row, {}), [call]);

  // The poll. Keyed on WHETHER anything is in flight rather than on the rows
  // themselves, so a re-render that only changed copy does not restart the
  // interval; and it never ticks while a row is busy, so a user's own click and
  // the tick cannot race for the same row.
  //
  // ONE quiet re-read of the SET beats N per-row probes: the set read already
  // carries every row's fresh takeover state. `Check again` stays the per-row,
  // user-driven probe — the one that can also SETTLE `awaiting_reinstall`.
  const inFlight = rows.some((row) => row.takeover && IN_FLIGHT.has(row.takeover.state));

  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refetch]);

  if (rows.length === 0) {
    return <EmptyState title={t('title')} description={t('empty')} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) p-(--spacing-card-padding) text-sm text-(--el-danger-surface-text)"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t('actionError')}</span>
        </p>
      ) : null}

      {rows.map((row) => (
        <TakeoverRow
          key={row.id}
          row={row}
          githubLogin={view.githubLogin}
          installHref={view.installHref}
          nowIso={nowIso}
          busy={busyRowId === row.id}
          onMove={setModalRow}
          onCheckAgain={onCheckAgain}
          onRetry={setModalRow}
        />
      ))}

      {modalRow ? (
        <TakeoverModal
          row={modalRow}
          githubLogin={view.githubLogin}
          connectHref={connectHref}
          busy={busyRowId === modalRow.id}
          onClose={() => setModalRow(null)}
          onConfirm={onConfirm}
        />
      ) : null}
    </div>
  );
}
