'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleSlash, TriangleAlert } from 'lucide-react';
import { RunModal } from '@/app/(authed)/runs/_components/RunModal';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { legSummary } from '@/lib/runs/legSummary';
import { runsHref } from '@/lib/runs/runsAddress';
import type { RoomView } from '@/lib/rooms/roomView';
import { formatRunInstant } from '@/lib/runs/runClock';
import { RUN_STATUS_TONE } from '@/lib/runs/timeline';

// THE RUNS INDEX's list (Story MOTIR-1789 · MOTIR-3923).
//
// ⚠️ TWO HEADED SECTIONS, NOT A SWITCH — `design/runs/design-notes.md` § `/runs`.
// "A person arrives asking one of exactly two questions — what is happening right
// now, or what happened — and the two are read differently: the first is watched,
// the second is searched." Two sections answer both without a click and without
// hiding either, which a switch cannot do and one undivided list makes you scan
// for.
//
// ⚠️ AND AN EMPTY SECTION SAYS SO RATHER THAN DISAPPEARING. "A section that
// vanishes makes a reader wonder whether it failed." Nothing running is the
// ORDINARY case, so the live heading stays and states the fact in one line.
//
// ⚠️ PAGING, NOT VIRTUALIZATION, and the reason is the partition itself: live
// runs are bounded by how many agents are running, so there is exactly ONE
// growing list and it has a natural stopping point — "a reader looking for a run
// from last week does not scroll, they page." 25 a page, CURSOR not offset, so a
// run opened mid-read cannot shift a row across the boundary.
//
// ⚠️ UNDER `?scope=<KEY>` THE SAME LIST IS NARROWED (Story MOTIR-5363 · design
// MOTIR-5402 panels 4–5). Every fetch this island makes — the poll, the past
// re-read and *Show more* — carries the scope, the Scope column is dropped (every
// row would repeat the header), and opening or closing a run KEEPS the narrowing.

/** How often the page re-reads itself while it holds a live run. */
const POLL_MS = 5_000;

export interface RunsIndexProps {
  projectKey: string;
  /** The work-item KEY this list is narrowed to, or null for the whole project. */
  scopeKey?: string | null;
  /**
   * WHOSE runs this list holds — the SERVED view (MOTIR-6335). Carried on EVERY
   * client read (the poll, the settled re-read, *Show older runs*), exactly as
   * `scopeKey` is: a read that dropped it would refill Mine with everyone's runs.
   */
  view?: RoomView;
  /** Whether the reader has the switch — then every address written keeps `?view=`. */
  viewInUrl?: boolean;
  /** Whether the reader can start a run — picks the Project-empty copy. */
  canRun?: boolean;
  /** `null` when the read FAILED — which is not the same as empty. */
  initialLive: DispatchRunListItemDto[] | null;
  initialPast: DispatchRunListItemDto[] | null;
  pageSize: number;
}

export function RunsIndex({
  projectKey,
  scopeKey = null,
  view = 'project',
  viewInUrl = false,
  canRun = true,
  initialLive,
  initialPast,
  pageSize,
}: RunsIndexProps) {
  const t = useTranslations('runs');
  // ⚠️ THE OPEN RUN IS DERIVED FROM THE URL, not held beside it. Next syncs
  // `useSearchParams` with `history.pushState`, so `shallowPush` is the ONLY
  // writer and Back closes the modal for free — no second source of truth that
  // a history move could leave disagreeing with the address bar.
  const searchParams = useSearchParams();
  const openRunId = searchParams.get('run');
  const [live, setLive] = useState(initialLive);
  const [past, setPast] = useState(initialPast);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState((initialPast?.length ?? 0) < pageSize);

  const base = `/api/projects/${encodeURIComponent(projectKey)}/dispatch-runs`;
  // ⚠️ ON EVERY FETCH, never only the first. A poll that dropped the narrowing
  // would refill a narrowed page with the whole project's runs.
  const narrowing = `&view=${view}${scopeKey ? `&scope=${encodeURIComponent(scopeKey)}` : ''}`;
  const addressView = viewInUrl ? view : null;

  // ⚠️ THE POLL RUNS ONLY WHILE SOMETHING IS LIVE, and stops the moment nothing
  // is. A list that re-reads for ever is the N+1 mistake the archived `/ready`
  // strip was written to avoid, one layer up — and it opens NO stream per row:
  // the per-run stream belongs to the modal, which is opened deliberately.
  const anyLive = (live?.length ?? 0) > 0;
  // What the poll last saw, as a REF: reading it as a dependency would tear the
  // interval down and rebuild it every time a run's disposition changed.
  const liveRef = useRef(live);
  useEffect(() => {
    if (!anyLive) return;
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`${base}?status=live&limit=${pageSize}${narrowing}`);
          if (!res.ok || cancelled) return;
          const body = (await res.json()) as { runs: DispatchRunListItemDto[] };
          if (cancelled) return;

          // ⚠️ A RUN THAT LEAVES `live` HAS BECOME `past`, AND `past` WAS READ
          // BEFORE IT GOT THERE. Polling only the live half meant a run watched
          // to completion vanished from the page entirely: `live` went empty,
          // `past` still held the answer from page load — when that same run was
          // live — and the both-empty branch below then rendered *Nothing has
          // run yet* over a project that had just finished one. So the moment a
          // row leaves `live`, the past half is re-read.
          const before = liveRef.current ?? [];
          const settled = before.some((row) => !body.runs.some((now) => now.id === row.id));
          liveRef.current = body.runs;
          if (!settled) {
            setLive(body.runs);
            return;
          }

          // ⚠️ READ `past` BEFORE COMMITTING `live`, and the order is the whole
          // fix. Committing the empty live list first makes `anyLive` false,
          // which is this effect's own dependency — React tears the interval
          // down, the cleanup sets `cancelled`, and the `past` response that was
          // still in flight is then dropped by the guard below. The poll would
          // cancel its own read, land on an empty page, and never recover.
          // Leaving `live` untouched across the await keeps `anyLive` true, so
          // the effect survives long enough to commit BOTH halves together.
          let settledPast: DispatchRunListItemDto[] | null = null;
          try {
            const pastRes = await fetch(`${base}?status=past&limit=${pageSize}${narrowing}`);
            if (pastRes.ok) {
              settledPast = ((await pastRes.json()) as { runs: DispatchRunListItemDto[] }).runs;
            }
          } catch {
            /* the run still leaves `live`; the past half keeps its last good rows */
          }
          if (cancelled) return;

          setLive(body.runs);
          if (settledPast === null) return;
          // The FIRST page, deliberately: the run that just settled is the
          // newest, so it belongs at the top. This resets a reader who had paged
          // further back, which is the lesser of the two costs — the alternative
          // is a list that never learns the run it was watching is over.
          setPast(settledPast);
          setExhausted(settledPast.length < pageSize);
        } catch {
          /* a failed poll leaves the last good list on screen */
        }
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [anyLive, base, narrowing, pageSize]);

  const loadMore = useCallback(async () => {
    const rows = past;
    if (!rows || rows.length === 0 || loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1]!.id;
      const res = await fetch(
        `${base}?status=past&limit=${pageSize}&cursor=${encodeURIComponent(cursor)}${narrowing}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { runs: DispatchRunListItemDto[] };
      setPast([...rows, ...body.runs]);
      if (body.runs.length < pageSize) setExhausted(true);
    } catch {
      /* the rows already on screen stay */
    } finally {
      setLoadingMore(false);
    }
  }, [base, exhausted, loadingMore, narrowing, pageSize, past]);

  // OPEN / CLOSE. Both are `shallowPush`es (CLAUDE.md's discriminator): the
  // modal's body is fetched client-side, so the server has nothing to answer and
  // re-running this page would refetch two run lists to render something the
  // browser already has. A PUSH, not a replace, so Back closes the modal — the
  // behaviour a reader expects of a thing that opened over what they were
  // looking at. The list stays MOUNTED behind it, which is the whole reason this
  // is an overlay: closing returns to the same scroll position and the same
  // current/past partition.
  //
  // ⚠️ AND BOTH KEEP THE NARROWING (design MOTIR-5402 panel 5). `?run=` composes
  // with `?scope=`; writing `/runs?run=<id>` and `/runs` literally dropped it on
  // the first click.
  const onOpenRun = useCallback(
    (id: string) => {
      shallowPush(runsHref({ view: addressView, scope: scopeKey, run: id }));
    },
    [addressView, scopeKey],
  );
  const onCloseRun = useCallback(() => {
    shallowPush(runsHref({ view: addressView, scope: scopeKey }));
  }, [addressView, scopeKey]);

  // ⚠️ RENDERED IN BOTH BRANCHES, and it must be. The empty-state return below
  // used to sit ABOVE the modal, so a list that went empty UNMOUNTED an open run
  // — the reader was watching it — while the URL kept its `?run=`, because
  // nothing called `onCloseRun`. The modal answers to `openRunId`, never to how
  // many rows the list happens to hold.
  const modal =
    openRunId !== null ? (
      <RunModal key={openRunId} runId={openRunId} projectKey={projectKey} onClose={onCloseRun} />
    ) : null;

  // Nothing at all has ever run — the ONE case that replaces both sections,
  // because two empty headings would be chrome around an absence. Under a
  // narrowing it is a different fact (this work item was never a run's scope),
  // said with the command that changes it and where its children's runs are.
  if (live?.length === 0 && past?.length === 0) {
    return (
      <>
        {scopeKey ? (
          <EmptyState
            title={
              view === 'mine'
                ? t('scopeIndex.emptyMineTitle', { key: scopeKey })
                : t('scopeIndex.emptyTitle', { key: scopeKey })
            }
            description={t('scopeIndex.emptyBody', { key: scopeKey })}
          />
        ) : view === 'mine' ? (
          <EmptyState title={t('indexEmptyMineTitle')} description={t('indexEmptyMineBody')} />
        ) : (
          // A reader who cannot start a run is not told "when you dispatch work".
          <EmptyState
            title={t('indexEmptyTitle')}
            description={canRun ? t('indexEmptyBody') : t('indexEmptyBodyRead')}
          />
        )}
        {modal}
      </>
    );
  }

  const showScope = scopeKey === null;
  return (
    <div className="flex flex-col gap-6">
      <Section
        heading={t('sectionLive')}
        rows={live}
        emptyLine={view === 'mine' ? t('noneRunningMine') : t('noneRunning')}
        t={t}
        showScope={showScope}
        onOpen={onOpenRun}
      />
      <Section
        heading={t('sectionPast')}
        rows={past}
        emptyLine={view === 'mine' ? t('nonePastMine') : t('nonePast')}
        t={t}
        showScope={showScope}
        onOpen={onOpenRun}
        footer={
          past && past.length > 0 && !exhausted ? (
            <div className="flex justify-center py-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          ) : null
        }
      />
      {modal}
    </div>
  );
}

/**
 * One headed section.
 *
 * ⚠️ IT NEVER DISAPPEARS. `rows === null` is a FAILED read and says so; `rows`
 * empty is a fact and says that; neither removes the heading. The three faces —
 * loaded, empty, failed — are deliberately distinct, because *we could not load
 * this* and *nothing has run* are opposite facts.
 */
function Section({
  heading,
  rows,
  emptyLine,
  t,
  showScope,
  footer,
  onOpen,
}: {
  heading: string;
  rows: DispatchRunListItemDto[] | null;
  emptyLine: string;
  t: ReturnType<typeof useTranslations>;
  /** False under a narrowing, where every row would repeat the header's scope. */
  showScope: boolean;
  onOpen: (id: string) => void;
  footer?: React.ReactNode;
}) {
  const columns = (
    ['colCommand', 'colScope', 'colAgent', 'colStarted', 'colStatus', 'colItems'] as const
  ).filter((k) => showScope || k !== 'colScope');
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {heading}
      </h2>
      {rows === null ? (
        <div className="flex items-center gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-peach) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)">
          <TriangleAlert className="size-4 flex-none" aria-hidden="true" />
          {t('indexReadFailed')}
        </div>
      ) : rows.length === 0 ? (
        <p className="flex items-center gap-2 rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-secondary)">
          <CircleSlash className="size-4 flex-none text-(--el-text-tertiary)" aria-hidden="true" />
          {emptyLine}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-(--radius-card) border border-(--el-border)">
          <table className="w-full border-collapse">
            <thead className="border-b border-(--el-border) bg-(--el-surface)">
              <tr>
                {columns.map((k) => (
                  <th
                    key={k}
                    scope="col"
                    className="px-(--spacing-control-x) py-(--spacing-control-y) text-left text-xs font-semibold whitespace-nowrap text-(--el-text-secondary)"
                  >
                    {t(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <RunRow key={run.id} run={run} t={t} showScope={showScope} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
          {footer}
        </div>
      )}
    </section>
  );
}

/**
 * One run.
 *
 * ⚠️ THE STOP REASON IS DELIBERATELY NOT A COLUMN — `design-notes.md`: "it is
 * one sentence and it belongs on the run, where there is room to say it in
 * words." The row carries the OUTCOME instead, as the leg summary.
 *
 * ⚠️ THE SCOPE SURVIVES ITS WORK ITEM. `scopeLabel` is stored beside the id
 * precisely so a run stays readable after its subject is deleted, so the label
 * is what renders and the id is only what makes it a link.
 */
function RunRow({
  run,
  t,
  showScope,
  onOpen,
}: {
  run: DispatchRunListItemDto;
  t: ReturnType<typeof useTranslations>;
  showScope: boolean;
  onOpen: (id: string) => void;
}) {
  const tone = RUN_STATUS_TONE[run.status];
  const agent = [run.agent, run.model].filter(Boolean).join(' · ');
  const summary = useMemo(() => legSummary(run, t), [run, t]);
  return (
    <tr className="border-b border-(--el-border-soft) last:border-b-0">
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-xs whitespace-nowrap text-(--el-text)">
        {/* ⚠️ A REAL BUTTON, not a click handler on the <tr>. It is what the
            keyboard reaches, and it is what Radix returns focus TO when the
            modal closes — the AC's "focus returns to the row that opened it"
            is a property of there being a focusable element to return to. */}
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          className="rounded-(--radius-control) text-(--el-accent-on-surface) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {run.command}
        </button>
      </td>
      {showScope ? (
        <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-secondary)">
          {run.scopeLabel ?? t('scopeNone')}
        </td>
      ) : null}
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs whitespace-nowrap text-(--el-text-secondary)">
        {agent || '—'}
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs whitespace-nowrap text-(--el-text-secondary)">
        <RunTime iso={run.startedAt} />
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) whitespace-nowrap">
        <RunTonePill tone={tone}>{t(`runStatus.${run.status}`)}</RunTonePill>
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary)">
        {summary}
      </td>
    </tr>
  );
}

/**
 * ⚠️ A FIXED LOCALE AND TIMEZONE, formatted during render — no effect, no state.
 *
 * A run list is a column of dates, and a date formatted with the AMBIENT locale
 * reads the Node process's on the server and the browser's on the client, so the
 * two disagree on first paint and React replaces the markup it just streamed.
 * The first draft here fixed that with a `useEffect` + `setState`, which trades
 * a hydration bug for a lint error the CI rule `react-hooks/set-state-in-effect`
 * exists to refuse — and it was the wrong instrument anyway.
 *
 * Pinning the locale and the zone removes the disagreement instead of papering
 * over it: the same input renders the same string in both places, so this is a
 * pure function and the row needs no client state at all. It is the same answer
 * the item page's `runTimes.ts` reached, and for the same stated reason — a
 * run's timestamps are written by a machine that may be anywhere, and a label
 * silently rendered in the SERVER's zone is a number a reader cannot check.
 *
 * Per-viewer local time is a real want and a separate one; it needs the shipped
 * locale seam, which is not this card's.
 */
function RunTime({ iso }: { iso: string }) {
  return <span>{formatRunInstant(iso)}</span>;
}
