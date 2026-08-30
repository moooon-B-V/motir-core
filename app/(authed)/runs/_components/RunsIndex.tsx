'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleSlash, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';
import { RUN_STATUS_TONE, type RunTone } from '@/lib/runs/timeline';

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

const TONE_CLASS = {
  queued: 'bg-(--el-muted) text-(--el-text-strong)',
  running: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  integrated: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  implemented: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  failed: 'bg-(--el-tint-rose) text-(--el-text-strong)',
  replanned: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  skipped: 'bg-(--el-muted) text-(--el-text-strong)',
  cancelled: 'bg-(--el-muted) text-(--el-text-strong)',
  timedout: 'bg-(--el-tint-peach) text-(--el-text-strong)',
  offline: 'bg-(--el-tint-peach) text-(--el-text-strong)',
} as const satisfies Record<RunTone, string>;

const DOT_CLASS = {
  queued: 'bg-(--el-status-todo)',
  running: 'bg-(--el-status-in-progress)',
  integrated: 'bg-(--el-status-done)',
  implemented: 'bg-(--el-status-done)',
  failed: 'bg-(--el-danger)',
  replanned: 'bg-(--el-status-planning)',
  skipped: 'bg-(--el-text-tertiary)',
  cancelled: 'bg-(--el-status-cancelled)',
  timedout: 'bg-(--el-warning)',
  offline: 'bg-(--el-text-tertiary)',
} as const satisfies Record<RunTone, string>;

/** How often the page re-reads itself while it holds a live run. */
const POLL_MS = 5_000;

export interface RunsIndexProps {
  projectKey: string;
  /** `null` when the read FAILED — which is not the same as empty. */
  initialLive: DispatchRunListItemDto[] | null;
  initialPast: DispatchRunListItemDto[] | null;
  pageSize: number;
}

export function RunsIndex({ projectKey, initialLive, initialPast, pageSize }: RunsIndexProps) {
  const t = useTranslations('runs');
  const [live, setLive] = useState(initialLive);
  const [past, setPast] = useState(initialPast);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState((initialPast?.length ?? 0) < pageSize);

  const base = `/api/projects/${encodeURIComponent(projectKey)}/dispatch-runs`;

  // ⚠️ THE POLL RUNS ONLY WHILE SOMETHING IS LIVE, and stops the moment nothing
  // is. A list that re-reads for ever is the N+1 mistake the archived `/ready`
  // strip was written to avoid, one layer up — and it opens NO stream per row:
  // the per-run stream belongs to the modal, which is opened deliberately.
  const anyLive = (live?.length ?? 0) > 0;
  useEffect(() => {
    if (!anyLive) return;
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`${base}?status=live&limit=${pageSize}`);
          if (!res.ok || cancelled) return;
          const body = (await res.json()) as { runs: DispatchRunListItemDto[] };
          if (!cancelled) setLive(body.runs);
        } catch {
          /* a failed poll leaves the last good list on screen */
        }
      })();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [anyLive, base, pageSize]);

  const loadMore = useCallback(async () => {
    const rows = past;
    if (!rows || rows.length === 0 || loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1]!.id;
      const res = await fetch(
        `${base}?status=past&limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`,
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
  }, [base, exhausted, loadingMore, pageSize, past]);

  // Nothing at all has ever run — the ONE case that replaces both sections,
  // because two empty headings would be chrome around an absence.
  if (live?.length === 0 && past?.length === 0) {
    return <EmptyState title={t('indexEmptyTitle')} description={t('indexEmptyBody')} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <Section heading={t('sectionLive')} rows={live} emptyLine={t('noneRunning')} t={t} />
      <Section
        heading={t('sectionPast')}
        rows={past}
        emptyLine={t('nonePast')}
        t={t}
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
  footer,
}: {
  heading: string;
  rows: DispatchRunListItemDto[] | null;
  emptyLine: string;
  t: ReturnType<typeof useTranslations>;
  footer?: React.ReactNode;
}) {
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
                {(
                  [
                    'colCommand',
                    'colScope',
                    'colAgent',
                    'colStarted',
                    'colStatus',
                    'colItems',
                  ] as const
                ).map((k) => (
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
                <RunRow key={run.id} run={run} t={t} />
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
}: {
  run: DispatchRunListItemDto;
  t: ReturnType<typeof useTranslations>;
}) {
  const tone = RUN_STATUS_TONE[run.status];
  const agent = [run.agent, run.model].filter(Boolean).join(' · ');
  const summary = useMemo(() => legSummary(run, t), [run, t]);
  return (
    <tr className="border-b border-(--el-border-soft) last:border-b-0">
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) font-mono text-xs whitespace-nowrap text-(--el-text)">
        {run.command}
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-secondary)">
        {run.scopeLabel ?? t('scopeNone')}
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs whitespace-nowrap text-(--el-text-secondary)">
        {agent || '—'}
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs whitespace-nowrap text-(--el-text-secondary)">
        <RunTime iso={run.startedAt} />
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) whitespace-nowrap">
        <span
          className={`inline-flex items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium ${TONE_CLASS[tone]}`}
        >
          <span className={`size-[7px] rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
          {t(`runStatus.${run.status}`)}
        </span>
      </td>
      <td className="px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary)">
        {summary}
      </td>
    </tr>
  );
}

/**
 * "9 of 11 implemented, 1 skipped" — the run's outcome in one cell, read off
 * counts the page already has. A run that took NO work items says so: zero is a
 * real answer (a scoped run whose every member was skipped), not an error.
 */
function legSummary(run: DispatchRunListItemDto, t: ReturnType<typeof useTranslations>): string {
  if (run.cardCount === 0) return t('tookNone');
  const done = run.legs.implemented + run.legs.integrated;
  const parts = [t('summaryDone', { done, total: run.cardCount })];
  if (run.legs.skipped > 0) parts.push(t('summarySkipped', { n: run.legs.skipped }));
  if (run.legs.failed > 0) parts.push(t('summaryFailed', { n: run.legs.failed }));
  if (run.legs.not_reached > 0) parts.push(t('summaryNotReached', { n: run.legs.not_reached }));
  if (run.legs.replanned > 0) parts.push(t('summaryReplanned', { n: run.legs.replanned }));
  return parts.join(' · ');
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
const RUN_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

function RunTime({ iso }: { iso: string }) {
  return <span>{`${RUN_TIME.format(new Date(iso))} UTC`}</span>;
}
