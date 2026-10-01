'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Cloud, CloudOff, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { RunCanvasPane } from '@/app/(authed)/runs/_components/RunCanvasPane';
import { RunFindings } from '@/app/(authed)/runs/_components/RunFindings';
import { RunLogPane } from '@/app/(authed)/runs/_components/RunLogPane';
import { HostedRunCancel } from '@/app/(authed)/runs/_components/HostedRunCancel';
import { HostedRunCost } from '@/app/(authed)/runs/_components/HostedRunCost';
import { hostedPhaseRead, hostedReasonLine } from '@/app/(authed)/runs/_components/HostedRunParts';
import {
  AgentEndStrip,
  AgentLaneChip,
  AgentRunCost,
  agentOf,
  agentPanelHref,
} from '@/app/(authed)/runs/_components/AgentRunParts';
import { useRunEvents } from '@/app/(authed)/runs/_components/useRunEvents';
import type { DispatchRunDetailDto, DispatchRunEventDto } from '@/lib/dto/dispatchRuns';
import { formatRunDuration, formatRunInstant } from '@/lib/runs/runClock';
import { RUN_STATUS_TONE, isLiveRun } from '@/lib/runs/timeline';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

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
  /**
   * The signed-in reader, or null for a visitor. A run in an agent is
   * cancellable by the agent's OWNER only (`agent-instance-run.md` §6), and the
   * owner is the run's creator — so the header's Cancel run needs to know who
   * is looking (MOTIR-7028).
   */
  viewerId?: string | null;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; run: DispatchRunDetailDto }
  | { state: 'missing' }
  | { state: 'failed' };

export function RunModal({ runId, projectKey, onClose, viewerId = null }: RunModalProps) {
  const t = useTranslations('runs');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  // ONE connection for the whole modal (MOTIR-3983): the findings strip and the
  // log pane are two readers of the same stream, not two streams.
  const { events, reconnecting, finished } = useRunEvents(runId);
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
      const dto = (await res.json()) as DispatchRunDetailDto;
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

  // ⚠️ AND THE RUN'S OWN ENDING, which the disposition kinds above cannot carry.
  // Closing a run writes no event row — `dispatchRunService.close` updates
  // `status` and `stopReason` on the run itself — so the stream's terminal
  // `done` frame is the only notice it is over. Without this re-read the header
  // kept saying `Running`, with no stop reason, for as long as the modal stayed
  // open: the one thing a live run surface must not do.
  useEffect(() => {
    if (!finished) return;
    // Same shape as the load effect above — the async wrapper is what keeps the
    // state update out of the effect BODY (`react-hooks/set-state-in-effect`).
    void (async () => {
      await fetchRun();
    })();
  }, [finished, fetchRun]);

  // A LIVE HOSTED run's cost follows it (MOTIR-691): one re-read of the run every
  // 20 events on the one stream — no second connection, no timer.
  // `instance` (MOTIR-7023) has no per-run cost to follow — its machine time is
  // its own clock — so hosted only.
  const hostedLive = run?.origin === 'hosted' && isLiveRun(run.status);
  const costBucket = hostedLive ? Math.floor(events.length / 20) : -1;
  const costBucketRef = useRef(costBucket);
  useEffect(() => {
    if (costBucket <= costBucketRef.current) return;
    costBucketRef.current = costBucket;
    void (async () => {
      await fetchRun();
    })();
  }, [costBucket, fetchRun]);

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
      {/* modal-scroll-container: measured 1280x700, tallest = a live run with 60 streamed log lines; the full-size panel IS the viewport and the canvas and log panes scroll (min-h-0 flex-1 overflow-auto), panel 700px */}
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
          <RunHeader run={run} viewerId={viewerId} onCancelled={() => void fetchRun()} />
          {/* A run in an agent: its end in one strip, then machine time as its
              only cost (MOTIR-7022 panel 12). No tokens, no credits — they land
              on the agent's own interval (MOTIR-7023, Q3.3). */}
          {run.origin === 'instance' ? (
            <>
              <AgentEndStrip run={run} />
              <AgentRunCost run={run} live={isLiveRun(run.status)} variant="strip" />
            </>
          ) : null}
          {run.origin === 'hosted' ? (
            <HostedRunCost
              runId={run.id}
              live={isLiveRun(run.status)}
              cost={run.cost ?? null}
              variant="strip"
              refreshKey={Math.floor(events.length / 20) + (isLiveRun(run.status) ? 0 : 1000)}
            />
          ) : null}
          {reconnecting ? (
            <p className="border-b border-(--el-border-soft) bg-(--el-tint-peach) px-(--spacing-card-padding) py-1.5 text-xs text-(--el-text-strong)">
              {t('reconnecting')}
            </p>
          ) : null}
          {/* A local OR `instance` run abandoned = its CLI stopped heartbeating. */}
          {run.stopReason === 'abandoned' && run.origin !== 'hosted' ? (
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
              <h2 className="flex items-center gap-2 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2 text-xs font-semibold text-(--el-text-secondary)">
                {t('paneLog')}
                {/* Both paths run in Motir's cloud and walk the same phases. */}
                {run.origin === 'hosted' || run.origin === 'instance' ? (
                  <HostedPhaseChip run={run} events={events} />
                ) : null}
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

/**
 * The log pane head's PHASE CHIP for a hosted run — where it is of the decision's
 * six (`Running · 3 of 6`). The pane is a 26rem column; the full list is the Run
 * section's timeline.
 */
function HostedPhaseChip({
  run,
  events,
}: {
  run: DispatchRunDetailDto;
  events: DispatchRunEventDto[];
}) {
  const t = useTranslations('runs.hosted');
  const read = hostedPhaseRead(events, run.status, run);
  const phase = read.current ?? 'done';
  return (
    <span
      className="rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-normal text-(--el-text-strong)"
      data-testid="hosted-phase-chip"
    >
      {t('phaseChip', { phase: t(`phase.${phase}`), position: read.position })}
    </span>
  );
}

function RunHeader({
  run,
  viewerId,
  onCancelled,
}: {
  run: DispatchRunDetailDto;
  viewerId: string | null;
  onCancelled: () => void;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('runs');
  const tHosted = useTranslations('runs.hosted');
  const tAgent = useTranslations('runs.agent');
  const commandKey =
    run.command === 'run' && run.scopeWorkItemId !== null ? 'run_scope' : run.command;
  const hosted = run.origin === 'hosted';
  // A run in an agent (MOTIR-7023 · MOTIR-7028): the same one-work-item run in
  // Motir's cloud, worked by the reader's own agent — its end line is the strip
  // under the header (`AgentEndStrip`), not this row's.
  const instance = run.origin === 'instance';
  const cloud = hosted || instance;
  const agent = instance ? agentOf(run) : null;
  const live = isLiveRun(run.status);
  // A hosted run's stop line is the REASON its end recorded, quoted — not the
  // stop-reason enum, whose `abandoned` would say reporting went offline.
  const reason = hosted ? hostedReasonLine(run, tHosted) : null;
  // The run's own work item, for the title's key (design panel 12).
  const key = run.scopeLabel ?? run.cards[0]?.key ?? null;
  const canCancel =
    live && (hosted || (instance && viewerId !== null && run.createdById === viewerId));
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-3">
      <h1 className="font-mono text-sm font-semibold text-(--el-text)">
        {cloud ? tHosted('modalTitle') : t(`command.${commandKey}`)}
      </h1>
      {hosted ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs text-(--el-text-strong)"
          data-testid="run-modal-model"
        >
          <Cloud className="size-3.5" aria-hidden="true" />
          {run.model ?? tHosted('meta.hosted')}
        </span>
      ) : null}
      {instance ? (
        <>
          <AgentLaneChip run={run} />
          {agent ? (
            <Link
              href={agentPanelHref(agent.id)}
              className="text-xs text-(--el-link) underline"
              data-testid="agent-link"
            >
              {tAgent('where.open', { name: agent.name })}
            </Link>
          ) : null}
        </>
      ) : null}
      {cloud && key !== null && run.scopeLabel === null ? (
        <Link
          href={routes.item(key)}
          className="font-mono text-xs text-(--el-accent-on-surface) underline-offset-2 hover:underline"
        >
          {key}
        </Link>
      ) : run.scopeWorkItemId !== null && run.scopeLabel !== null ? (
        <Link
          href={routes.item(run.scopeLabel)}
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
      {cloud ? null : (
        <span className="text-xs text-(--el-text-secondary)">
          {[run.agent, run.model].filter(Boolean).join(' · ') || t('scopeNone')}
        </span>
      )}
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
        {canCancel ? (
          <HostedRunCancel
            runId={run.id}
            onCancelled={onCancelled}
            body={instance ? tAgent('cancel.body', { name: agent?.name ?? '' }) : undefined}
          />
        ) : null}
        {instance ? null : hosted ? (
          reason ? (
            <span
              className="font-mono text-xs text-(--el-text-secondary)"
              data-testid="hosted-stop-line"
            >
              {reason}
            </span>
          ) : null
        ) : run.stopReason !== null ? (
          <span className="text-xs text-(--el-text-secondary)">
            {t(`stopReason.${run.stopReason}`)}
          </span>
        ) : null}
      </span>
    </header>
  );
}
