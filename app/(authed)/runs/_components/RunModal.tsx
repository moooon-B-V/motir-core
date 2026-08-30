'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { CloudOff, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { RunCanvasPane } from '@/app/(authed)/runs/_components/RunCanvasPane';
import { RunFindings } from '@/app/(authed)/runs/_components/RunFindings';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import { useRunEvents } from '@/app/(authed)/runs/_components/useRunEvents';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import { formatRunDuration, formatRunInstant } from '@/lib/runs/runClock';
import { RUN_STATUS_TONE } from '@/lib/runs/timeline';

// THE RUN MODAL (MOTIR-3895 · `design/runs/design-notes.md` § The run MODAL) —
// full screen OVER `/runs`, never a route.
//
// ⚠️ AN OVERLAY, NOT A PAGE, and the reason is the list behind it. A run is
// something a reader looks INTO and comes back out of; a route would remount the
// index, lose the scroll position and re-run the partition. So `/runs?run=<id>`
// is written with `shallowPush` — a history entry, so Back closes the modal, and
// no server round trip, because the modal's body is fetched client-side and the
// server has nothing to answer.
//
// The dialog's a11y is the SHIPPED `Modal`'s (Radix): focus is trapped while
// open, ESC closes, and focus RETURNS to the row that opened it. The canvas
// inside owns `/` for search and does NOT take ESC — a full-screen canvas in a
// dialog is exactly where two key handlers collide, and the dialog's must win.

/** The events that can have moved a leg's disposition — the only ones worth a refetch. */
const DISPOSITION_EVENTS = new Set(['card_claimed', 'card_skipped', 'card_settled', 'leg_verdict']);

export interface RunModalProps {
  runId: string;
  projectKey: string;
  /** Close and return to the list. */
  onClose: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; run: DispatchRunDto }
  | { state: 'missing' }
  | { state: 'failed' };

export function RunModal({ runId, projectKey, onClose }: RunModalProps) {
  const t = useTranslations('runs');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  // ONE connection for the whole modal (MOTIR-3983): the findings strip and the
  // log pane are two readers of the same stream, not two streams.
  const { events, reconnecting } = useRunEvents(runId);
  // Bumped when the dispositions move, so the canvas refetches its CURRENT level
  // — the prop `ProjectRoadmapCanvas` exposes for exactly this.
  const [reloadKey, setReloadKey] = useState(0);

  const run = load.state === 'ready' ? load.run : null;

  const fetchRun = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/dispatch-runs/${encodeURIComponent(runId)}`, {
        headers: { Accept: 'application/json' },
      });
      // ⚠️ A RUN THAT IS NOT THERE CLOSES THE MODAL AND REPORTS ON THE LIST — it
      // does NOT 404, because there is no route to 404. A stale deep link, a run
      // from another project and one the reader may not see are the same answer.
      if (res.status === 404 || res.status === 403) {
        setLoad({ state: 'missing' });
        return;
      }
      if (!res.ok) {
        setLoad({ state: 'failed' });
        return;
      }
      const dto = (await res.json()) as DispatchRunDto;
      setLoad({ state: 'ready', run: dto });
      setReloadKey((k) => k + 1);
    } catch {
      setLoad({ state: 'failed' });
    }
  }, [runId]);

  // ⚠️ NO RESET HERE, AND THAT IS THE POINT. Switching runs used to set the
  // state back to `loading` from inside this effect, which is the cascading
  // render the `react-hooks/set-state-in-effect` rule forbids. The modal is
  // KEYED ON `runId` at its mount site instead, so a different run REMOUNTS and
  // `useState`'s initializer is the reset — one mechanism, and no render that
  // shows the previous run's set under the new run's header.
  useEffect(() => {
    void (async () => {
      await fetchRun();
    })();
  }, [fetchRun]);

  // ⚠️ THE DISPOSITIONS FOLLOW THE SAME STREAM. This used to be a SECOND pump
  // beside the log pane's — two connections to one endpoint, which is the
  // fan-out the run surfaces' bounded-reads guard exists to catch. There is now
  // one stream (`useRunEvents`), and this watches what arrives on it: an event
  // that can have moved a leg triggers one re-read of the run, and the canvas
  // follows through `reloadKey`.
  const seenRef = useRef(0);
  useEffect(() => {
    const moved = events.some((e) => e.seq > seenRef.current && DISPOSITION_EVENTS.has(e.kind));
    for (const e of events) seenRef.current = Math.max(seenRef.current, e.seq);
    if (moved) void fetchRun();
  }, [events, fetchRun]);

  // A run that is not there is not a state to sit in: close, and let the list say so.
  useEffect(() => {
    if (load.state === 'missing') onClose();
  }, [load.state, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );

  return (
    <Modal
      open
      onOpenChange={handleOpenChange}
      size="full"
      srTitle={t('modalTitle')}
      // The panel chrome comes off: at full size the dialog IS the surface, so
      // the border/radius/padding a `md` dialog wants would draw a frame around
      // the whole viewport.
      className="flex flex-col rounded-none border-0 p-0"
    >
      {load.state === 'loading' ? (
        <div
          className="flex flex-1 items-center justify-center p-(--spacing-card-padding) text-sm text-(--el-text-secondary)"
          data-testid="run-modal-loading"
        >
          {t('modalLoading')}
        </div>
      ) : load.state === 'failed' ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-(--spacing-card-padding) text-sm text-(--el-text-secondary)"
          data-testid="run-modal-failed"
        >
          <TriangleAlert className="size-5 text-(--el-warning)" aria-hidden="true" />
          {t('modalReadFailed')}
        </div>
      ) : run ? (
        <>
          <RunHeader run={run} />
          {reconnecting ? (
            <p className="border-b border-(--el-border-soft) bg-(--el-tint-peach) px-(--spacing-card-padding) py-1.5 text-xs text-(--el-text-strong)">
              {t('reconnecting')}
            </p>
          ) : null}
          {run.stopReason === 'abandoned' ? (
            <p
              className="flex items-center gap-2 border-b border-(--el-border-soft) bg-(--el-tint-peach) px-(--spacing-card-padding) py-1.5 text-xs text-(--el-text-strong)"
              data-testid="run-modal-offline"
            >
              <CloudOff className="size-3.5" aria-hidden="true" />
              {t('reportingOffline')}
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col border-(--el-border-soft) lg:border-r"
              aria-label={t('paneSet')}
            >
              <h2 className="border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2 text-xs font-semibold text-(--el-text-secondary)">
                {run.cards.length === 0
                  ? t('tookNone')
                  : t('paneSetCount', { count: run.cards.length })}
              </h2>
              {run.cards.length === 0 ? (
                // A run that took no work items is a REAL outcome — never an
                // error face, and never an empty canvas the reader has to
                // interpret.
                <p
                  className="flex flex-1 items-center justify-center p-(--spacing-card-padding) text-sm text-(--el-text-secondary)"
                  data-testid="run-modal-no-members"
                >
                  {t('tookNoneBody')}
                </p>
              ) : (
                <div className="min-h-0 flex-1">
                  <RunCanvasPane
                    run={run}
                    projectKey={projectKey}
                    onSelectWorkItem={setSelectedWorkItemId}
                    reloadKey={reloadKey}
                  />
                </div>
              )}
            </section>
            {/* The right-hand REGION. The log pane itself is MOTIR-3962's; this
                lays out the space and holds the selection it will consume, so
                the two land independently. */}
            <section
              className="flex min-h-0 w-full shrink-0 flex-col lg:w-[26rem]"
              aria-label={t('paneLog')}
              data-testid="run-modal-log-region"
              data-selected-work-item={selectedWorkItemId ?? ''}
            >
              <h2 className="border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2 text-xs font-semibold text-(--el-text-secondary)">
                {t('paneLog')}
              </h2>
              {/* PINNED ABOVE THE LOG, and absent entirely when the run
                  produced nothing — which is most runs. See `RunFindings`. */}
              <RunFindings events={events} />
              <RunLogPane run={run} events={events} selectedWorkItemId={selectedWorkItemId} />
            </section>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function RunHeader({ run }: { run: DispatchRunDto }) {
  const t = useTranslations('runs');
  const commandKey =
    run.command === 'run' && run.scopeWorkItemId !== null ? 'run_scope' : run.command;
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-3">
      <h1 className="font-mono text-sm font-semibold text-(--el-text)">
        {t(`command.${commandKey}`)}
      </h1>
      {run.scopeWorkItemId !== null && run.scopeLabel !== null ? (
        <Link
          href={`/items/${encodeURIComponent(run.scopeLabel)}`}
          className="text-xs text-(--el-accent-on-surface) underline-offset-2 hover:underline"
        >
          {run.scopeLabel}
        </Link>
      ) : run.scopeLabel !== null ? (
        // The scope SURVIVES its work item (the label is stored beside the id),
        // so a deleted scope still says what the run was pointed at — with no
        // link, because there is nothing to open.
        <span className="text-xs text-(--el-text-secondary)">{run.scopeLabel}</span>
      ) : null}
      <span className="text-xs text-(--el-text-secondary)">
        {[run.agent, run.model].filter(Boolean).join(' · ') || t('scopeNone')}
      </span>
      {/* Started, and — once it HAS ended — how long it took. A live run shows no
          ticking counter: that needs a clock read during render, which is the
          hydration mismatch `runClock.ts` exists to avoid, and the status pill
          beside it already says the run is going. */}
      <span className="text-xs text-(--el-text-secondary)">
        {formatRunInstant(run.startedAt)}
        {run.endedAt !== null ? ` · ${formatRunDuration(run.startedAt, run.endedAt)}` : ''}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <RunTonePill tone={RUN_STATUS_TONE[run.status]}>{t(`runStatus.${run.status}`)}</RunTonePill>
        {run.stopReason !== null ? (
          <span className="text-xs text-(--el-text-secondary)">
            {t(`stopReason.${run.stopReason}`)}
          </span>
        ) : null}
      </span>
    </header>
  );
}
