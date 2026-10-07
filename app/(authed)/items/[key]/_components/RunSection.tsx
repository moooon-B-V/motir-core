'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, Cloud, TriangleAlert } from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import { HostedRunCost } from '@/app/(authed)/runs/_components/HostedRunCost';
import {
  HostedEndBlock,
  HostedPhaseList,
  useHostedRunDetail,
} from '@/app/(authed)/runs/_components/HostedRunParts';
import {
  AgentEndBlock,
  AgentRunCost,
  AgentWhere,
  agentOf,
  agentPanelHref,
} from '@/app/(authed)/runs/_components/AgentRunParts';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import { formatRunDuration } from '@/lib/runs/runClock';
import { StartBar } from './StartBar';
import { GatedRunMarker, GatedRunPill, StoppedAtGatePill } from './GatedRunMarker';
import type { ItemGatedRunDto } from '@/lib/dto/home';
import { useHostedRun } from './HostedRunProvider';
import type {
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunListItemDto,
} from '@/lib/dto/dispatchRuns';
import { legSummary } from '@/lib/runs/legSummary';
import { isRunAlive, lastHeardFrom } from '@/lib/runs/runLiveness';
import { formatRunInstant } from '@/lib/runs/runClock';
import { relativeLabel } from '@/components/github/RepairFixPart';
import { runsHref } from '@/lib/runs/runsAddress';
import {
  CARD_STEPS,
  DISPOSITION_TONE,
  EVENT_STEP,
  RUN_STATUS_TONE,
  isLiveRun,
  skipReasonMessage,
  type CardStep,
} from '@/lib/runs/timeline';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { workbenchTabHref } from '@/lib/workbench/tab';
import type { ReaderRoutes } from '@/lib/visitor/routes';

// THE RUN SECTION on a work item (Story MOTIR-1789 · MOTIR-1796) — what the
// agent did to THIS card, live while it happens and afterwards as history.
// Renders `design/runs/run-section.mock.html`.
//
// ⚠️ IT OPENS NO CONNECTION UNLESS THIS CARD HAS A LIVE RUN, and that rule is
// the one that decides what this panel COSTS. The obvious implementation
// subscribes on mount, which opens a stream on EVERY item page anyone opens —
// on the most visited surface in the product, for cards that are overwhelmingly
// not being worked. The fact needed to avoid it is already on the page: the
// history read is newest-first, so its FIRST ROW is the current run, and
// `isLiveRun` answers the question before anything renders
// (`design/runs/design-notes.md` § The CONNECTION).
//
// ⚠️ IT RENDERS NO PULL REQUEST AND DERIVES NO CI STATE. Those are the
// Development section's, immediately BELOW this one in the stack, from the
// shipped `deliveries[]`. A second CI verdict on one page is how a person ends
// up with two answers to *is it green*.

/**
 * Where a run opens: the run MODAL over the runs index, addressed by `?run=`.
 * There is no `/runs/<id>` route — `design/runs/design-notes.md` § The DEEP LINK
 * is `/runs?run=<id>` names this section as one of the three files that must
 * agree on it, with `RunsIndex` (which writes it) and `RunModal` (which reads it).
 * Spelled by `lib/runs/runsAddress.ts`, which also carries the `?scope=` half.
 */
const runHref = (routes: ReaderRoutes, runId: string): string =>
  routes.view(runsHref({ run: runId }));

/** The card's CURRENT run: the newest that is not a review run (see {@link RunSection}). */
export function currentRunOf<R extends { command: string }>(runs: readonly R[]): R | null {
  return runs.find((run) => run.command !== 'review') ?? null;
}

export interface RunSectionProps {
  /** This card's runs, newest first. The first row that is not a review is the current run. */
  initialRuns: DispatchRunDto[];
  /** The history cursor, or null when the first page is the whole history. */
  initialCursor: string | null;
  itemKey: string;
  /** Rendered on the server so a relative time never disagrees on first paint. */
  formattedTimes: Record<string, string>;
  /**
   * The LATEST run this work item was the SCOPE of, or `null` (MOTIR-5363). A
   * scoped run's legs are the container's children, so it never appears in
   * `initialRuns` above — this is the only way the section learns of it.
   */
  scopeRun?: DispatchRunListItemDto | null;
  /** `scopeRun`'s start, formatted on the server for the same reason. */
  scopeRunTime?: string | null;
  /**
   * The card's GATED run (MOTIR-7713; `design/runs` § _Stopped at a gate_), or null —
   * the marker that takes the Run died line's slot when a run stopped at a gate.
   */
  gated?: ItemGatedRunDto | null;
  /** The session's user — the gate rows read *You decide* for them. */
  viewerId?: string | null;
}

export function RunSection({
  initialRuns,
  initialCursor,
  itemKey,
  formattedTimes,
  scopeRun = null,
  scopeRunTime = null,
  gated = null,
  viewerId = null,
}: RunSectionProps) {
  const routes = useReaderRoutes();
  const t = useTranslations('runs');
  const locale = useLocale();
  const [runs, setRuns] = useState(initialRuns);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [events, setEvents] = useState<DispatchRunEventDto[]>([]);

  // ⚠️ THE CURRENT RUN IS NEVER A REVIEW RUN (MOTIR-1626; `hosted-agent-run.md` §8.1 /
  // §8.3). A review reads the pull requests and returns a verdict — it builds nothing and
  // holds no card, so it is not what "this card's run" means, and drawing it with a build's
  // phases would read as the card being built again. It stays in the history below, named
  // by its own command (*motir review*); the Development frame is where its outcome lives.
  const current = currentRunOf(runs);
  const door = useHostedRun();
  const tContinue = useTranslations('github.development.continue.hosted');
  // R1 names BOTH ways forward only while the part below offers Continue hosted (C7).
  const tDied = door?.continueTarget ? tContinue : t;
  const leg = useMemo(
    () => current?.cards.find((c) => c.key === itemKey) ?? null,
    [current, itemKey],
  );

  // ⚠️ THE ONE PREDICATE THAT DECIDES WHETHER A CONNECTION IS OPENED AT ALL.
  // `isLiveRun` is `lib/runs/timeline.ts`'s, the same map the server answers
  // `?status=live` from — not a second reading of "is it running".
  // ⚠️ DEAD IS READ, NOT WRITTEN (MOTIR-6534, design `design/runs` § Run died R1).
  // A local run whose heartbeat lapsed still reads `running` until the sweep closes
  // it; `isRunAlive` (`lib/runs/runLiveness.ts`) — the ONE liveness rule — says it
  // died NOW. The clock is read once per mount, as every relative label here is.
  const [mountedAt] = useState(() => Date.now());
  const died =
    current !== null && current.status !== 'succeeded' && !isRunAlive(current, new Date(mountedAt));
  // A dead run gets no stream: nothing is writing to it any more.
  const liveRunId = current && isLiveRun(current.status) && !died ? current.id : null;

  // The cursor the stream resumes from. Held in a ref rather than in state so a
  // reconnect reads the latest value without the effect depending on it — an
  // effect that re-ran on every event would tear the connection down per frame.
  const seqRef = useRef(current?.seq ?? 0);
  const router = useRouter();

  useEffect(() => {
    if (!liveRunId) return;
    const controller = new AbortController();
    let cancelled = false;

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const res = await fetch(
            `/api/dispatch-runs/${encodeURIComponent(liveRunId)}/stream?since=${seqRef.current}`,
            { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
          );
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          if (!cancelled) setReconnecting(false);

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = drainSseFrames(buffer);
            buffer = rest;
            for (const { event, data } of frames) {
              if (event === 'event') {
                const ev = data as DispatchRunEventDto;
                seqRef.current = ev.seq;
                setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
              } else if (event === 'done') {
                // TERMINAL. The server closed; do not reopen — that is the
                // whole of the "no connection for a card at rest" rule, applied
                // at the other end of the run's life.
                const status = (data as { status?: DispatchRunDto['status'] }).status;
                if (status && !cancelled) {
                  setRuns((prev) => prev.map((r) => (r.id === liveRunId ? { ...r, status } : r)));
                  // How a run ENDS changes SERVER-rendered surfaces the stream does
                  // not carry — the card's status (the agent moved it on success),
                  // its pull requests — so refresh them, as the start and cancel
                  // mutations already do (CLAUDE.md: page state after a mutation).
                  router.refresh();
                }
                cancelled = true;
                return;
              }
            }
          }
          if (cancelled) return;
        } catch {
          if (cancelled || controller.signal.aborted) return;
        }
        if (cancelled) return;
        // The connection dropped while the run is still going. Say so, then
        // resume FROM THE CURSOR — the `@@unique([dispatchRunId, seq])` on the
        // schema is what makes that neither replay nor gap.
        setReconnecting(true);
        const backoff = Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    };

    void pump();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [liveRunId, router]);

  // THE DOOR'S RUN (MOTIR-691): the section's current run — this card's own leg
  // run, or, for a container, the scope run over its children when that is the
  // newer one. The header door reads it to decide Run hosted vs Cancel run.
  const doorRun =
    scopeRun && (!current || scopeRun.startedAt > current.startedAt) ? scopeRun : current;
  const reportCurrentRun = door?.reportCurrentRun;
  // A run in an agent also names who may cancel it — its owner — and the agent
  // Cancel's words speak of (MOTIR-7028).
  const doorRunOwner = doorRun?.createdById ?? null;
  const doorRunAgent =
    doorRun && 'agentInstance' in doorRun ? (doorRun.agentInstance?.name ?? null) : null;
  useEffect(() => {
    reportCurrentRun?.(
      doorRun
        ? {
            id: doorRun.id,
            origin: doorRun.origin,
            status: doorRun.status,
            createdById: doorRunOwner,
            agentName: doorRunAgent,
          }
        : null,
    );
  }, [reportCurrentRun, doorRun?.id, doorRun?.origin, doorRun?.status, doorRunOwner, doorRunAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // A START OR A CANCEL from the door (MOTIR-691) — this island's history is
  // `useState(initialRuns)`, which a `router.refresh()` cannot reach, so it
  // refetches its first page on the door's tick (CLAUDE.md § Page state). The
  // mount run is skipped: the server already handed the first page down.
  const runsChangedAt = door?.runsChangedAt ?? 0;
  useEffect(() => {
    if (runsChangedAt === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/dispatch-runs`);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { runs: DispatchRunDto[]; nextCursor: string | null };
        const next = currentRunOf(body.runs);
        setRuns((prev) => {
          // A NEW current run resumes its own stream from its own cursor, with
          // none of the previous run's events on screen.
          if (next && currentRunOf(prev)?.id !== next.id) {
            seqRef.current = next.seq;
            setEvents([]);
          }
          return body.runs;
        });
        setCursor(body.nextCursor);
      } catch {
        // The history stays as it was; the next tick or a reload catches up.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runsChangedAt, itemKey]);

  // A HOSTED current run reads its detail — cost, end, what it shipped — and
  // re-reads it as the run moves: every 20 events while live, and once at its end.
  // A run in an agent reads the same detail (MOTIR-7028) for its end and its pull
  // requests; it has no cost in it to read.
  const hostedRunId =
    current?.origin === 'hosted' || current?.origin === 'instance' ? current.id : null;
  const hostedRefresh =
    (current && isLiveRun(current.status) ? 0 : 1) + Math.floor(events.length / 20) * 2;
  const hostedDetail = useHostedRunDetail(hostedRunId, hostedRefresh);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/work-items/${encodeURIComponent(itemKey)}/dispatch-runs?cursor=${encodeURIComponent(cursor)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as { runs: DispatchRunDto[]; nextCursor: string | null };
        setRuns((prev) => [...prev, ...body.runs]);
        setCursor(body.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, itemKey, loadingMore]);

  // ⚠️ A CONTAINER THAT WAS RUN AS A SCOPE IS NOT "NOTHING HAS RUN" (design
  // MOTIR-5402 panel 1). It has no leg of its own, so the leg history is empty —
  // and the empty state used to say the opposite of what happened. The scope
  // block takes its place; there is no step timeline, because steps are a LEG's.
  // THE START BAR (MOTIR-7022 revision 2): the two ways to start — Run and Send to
  // my agent — with what they answered, at the top of the body. It draws nothing
  // while a run is live.
  const notices = door ? <StartBar /> : null;

  if (runs.length === 0 && scopeRun) {
    return (
      <div className="flex flex-col gap-4">
        {notices}
        {gated ? (
          <div className="flex flex-col gap-2">
            <GatedRunPill gated={gated} />
            <GatedRunMarker gated={gated} itemKey={itemKey} viewerId={viewerId} />
          </div>
        ) : null}
        <ScopeBlock run={scopeRun} itemKey={itemKey} time={scopeRunTime} t={t} />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {notices}
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <Bot className="size-5 text-(--el-text-faint)" aria-hidden="true" />
          <p className="font-sans text-sm text-(--el-text)">{t('empty.title')}</p>
          <p className="max-w-[28rem] font-sans text-sm text-(--el-text-secondary)">
            {t('empty.body')}
          </p>
        </div>
      </div>
    );
  }

  // Which steps this leg has reached. `EVENT_STEP` is TOTAL over the event enum,
  // so a kind with no step contributes nothing rather than crashing — and a NEW
  // kind is a compile error in `lib/runs/timeline.ts` rather than a blank row.
  const reached = new Set<CardStep>();
  for (const ev of events) {
    if (ev.cardId && leg && ev.cardId !== leg.id) continue;
    const step = EVENT_STEP[ev.kind];
    if (step) reached.add(step);
  }
  if (leg) {
    if (leg.startedAt) reached.add('claimed');
    if (leg.endedAt) reached.add('settled');
  }

  // Hosted, or in an agent (MOTIR-7028): both draw the six phases; only the run
  // Motir works carries a token and credit cost.
  const hosted = current?.origin === 'hosted';
  const inAgent = current?.origin === 'instance';
  const runTone = current ? RUN_STATUS_TONE[current.status] : 'queued';
  const legTone = leg ? DISPOSITION_TONE[leg.disposition] : 'queued';
  const otherCards = current ? current.cards.length : 0;
  // The section's current run IS the gated one (G1, G2, G4–G6); while resuming it is
  // the continue, whose own pill says Running (G3).
  const gatedRunIsCurrent = gated !== null && current?.id === gated.runId;

  return (
    <div className="flex flex-col gap-4">
      {notices}
      <div className="flex items-center gap-2">
        <RunTonePill tone={legTone}>{t(`disposition.${leg?.disposition ?? 'queued'}`)}</RunTonePill>
        {current ? (
          died && current.status === 'running' ? (
            <RunTonePill tone="timedout">{t('runStatus.died')}</RunTonePill>
          ) : gated && gatedRunIsCurrent ? (
            // A run that stopped at a gate is never *Run died* and never just
            // *Succeeded* (§ _Stopped at a gate_ G1/G2).
            <GatedRunPill gated={gated} />
          ) : (
            <RunTonePill tone={runTone}>{t(`runStatus.${current.status}`)}</RunTonePill>
          )
        ) : null}
      </div>

      {leg?.disposition === 'skipped' && leg.skipReason ? (
        <SkipLine leg={leg} skipReason={leg.skipReason} t={t} />
      ) : null}

      {/* ⚠️ THE LINE THAT SAYS THIS CARD IS ONE OF N — the fact a person opening
          a card mid-sprint-run most needs and cannot get anywhere else. */}
      {current && otherCards > 1 ? (
        <p className="flex items-center gap-2 font-sans text-sm text-(--el-text)">
          <Bot className="size-4 text-(--el-text-secondary)" aria-hidden="true" />
          <span>
            {t('oneOfN', {
              position: current.cards.findIndex((c) => c.key === itemKey) + 1,
              total: otherCards,
            })}{' '}
            <Link className="text-(--el-link) underline" href={runHref(routes, current.id)}>
              {t('seeWholeRun')}
            </Link>
          </span>
        </p>
      ) : null}

      {reconnecting ? (
        <p
          className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
          role="status"
        >
          <TriangleAlert className="size-4" aria-hidden="true" />
          {t('reconnecting')}
        </p>
      ) : null}

      {current && died ? (
        // The died line takes the reporting-offline note's place, and points DOWN
        // to the continue part rather than repeating the command.
        <p
          className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)"
          role="status"
          data-testid="run-died-line"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-(--el-warning)"
            aria-hidden="true"
          />
          <span>
            {tDied.rich('runDied', {
              b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
              when: () => {
                const iso = (
                  current.endedAt && current.status !== 'running'
                    ? new Date(current.lastHeartbeatAt ?? current.endedAt)
                    : lastHeardFrom(current)
                ).toISOString();
                return (
                  <time dateTime={iso} title={formatRunInstant(iso)}>
                    {relativeLabel(iso, locale, mountedAt)}
                  </time>
                );
              },
            })}
          </span>
        </p>
      ) : null}

      {gated && !died ? (
        <GatedRunMarker gated={gated} itemKey={itemKey} viewerId={viewerId} />
      ) : null}

      {hosted && current ? (
        <HostedRunBody
          run={current}
          events={events}
          detail={hostedDetail}
          refreshKey={hostedRefresh}
        />
      ) : inAgent && current ? (
        <AgentRunBody
          run={current}
          events={events}
          detail={hostedDetail}
          started={door?.agentDoor?.started ?? null}
        />
      ) : (
        <ol className="flex flex-col gap-1.5" aria-live="polite">
          {CARD_STEPS.map((step) => {
            const done = reached.has(step);
            return (
              <li key={step} className="flex items-center gap-2 font-sans text-sm">
                <span
                  className={`size-2 shrink-0 rounded-full ${done ? 'bg-(--el-status-done)' : 'border border-(--el-border-strong)'}`}
                  aria-hidden="true"
                />
                <span className={done ? 'text-(--el-text)' : 'text-(--el-text-secondary)'}>
                  {t(`step.${step}`)}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-col gap-1">
        <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('history.title')}</h3>
        <ul className="flex min-w-0 flex-col">
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex min-w-0 items-center gap-2 border-t border-(--el-border-soft) py-(--spacing-control-y) first:border-t-0"
            >
              {/* A row still reading `running` whose run is not alive says so, as the
                  header pill does — the list never contradicts it. */}
              {run.status === 'running' && !isRunAlive(run, new Date(mountedAt)) ? (
                <RunTonePill tone="timedout">{t('runStatus.died')}</RunTonePill>
              ) : run.stopReason === 'gated' ? (
                // A run that stopped at a gate keeps that word in its history row
                // (§ _Stopped at a gate_ G1) — it did not just succeed.
                <StoppedAtGatePill />
              ) : (
                <RunTonePill tone={RUN_STATUS_TONE[run.status]}>
                  {t(`runStatus.${run.status}`)}
                </RunTonePill>
              )}
              <Link
                className="min-w-0 truncate text-(--el-link) underline"
                href={runHref(routes, run.id)}
              >
                {t(`command.${run.command}`)}
              </Link>
              <span className="ml-auto shrink-0 font-sans text-xs text-(--el-text-secondary)">
                {formattedTimes[run.id] ?? ''}
              </span>
            </li>
          ))}
        </ul>
        {cursor ? (
          <div className="pt-1">
            <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
              {t('history.more')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* BOTH (design MOTIR-5402 panel 2) — the leg content above is this item's
          own run and keeps the header pill; the scope block follows, divided. */}
      {scopeRun ? (
        <ScopeBlock run={scopeRun} itemKey={itemKey} time={scopeRunTime} t={t} divided />
      ) : null}
    </div>
  );
}

/**
 * A HOSTED run in the section (Story MOTIR-683 · MOTIR-691; design MOTIR-684
 * panels 5–8): the meta row, the decision's six phases, the end, and the cost.
 * A LOCAL run never reaches this — its seven shipped steps are unchanged.
 */
function HostedRunBody({
  run,
  events,
  detail,
  refreshKey,
}: {
  run: DispatchRunDto;
  events: DispatchRunEventDto[];
  detail: ReturnType<typeof useHostedRunDetail>;
  refreshKey: number;
}) {
  const t = useTranslations('runs.hosted');
  const tAgent = useTranslations('runs.agent');
  const live = isLiveRun(run.status);
  return (
    <div className="flex flex-col gap-4" data-testid="hosted-run">
      {/* WHO WORKS IT (MOTIR-7022 revision 2, panel 11): the model, and Motir. */}
      <p className="flex flex-wrap items-center gap-1.5 font-sans text-sm text-(--el-text)">
        {run.model ? (
          <span className="inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs font-medium text-(--el-text-strong)">
            <Cloud className="size-3.5" aria-hidden="true" />
            {run.model}
          </span>
        ) : null}
        <span>{live ? t('where.live') : t('where.ended')}</span>
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-xs">
        <MetaPair label={tAgent('meta.worked')}>{t('meta.hosted')}</MetaPair>
        {run.model ? (
          <MetaPair label={t('meta.model')}>
            <span className="font-mono">{run.model}</span>
          </MetaPair>
        ) : null}
        <DurationPair run={run} live={live} />
      </dl>
      <HostedPhaseList events={events} status={run.status} detail={detail} model={run.model} />
      {!live && detail ? <HostedEndBlock detail={detail} /> : null}
      <HostedRunCost
        runId={run.id}
        live={live}
        cost={detail ? (detail.cost ?? null) : undefined}
        variant="block"
        refreshKey={refreshKey}
      />
    </div>
  );
}

/** *Elapsed* while live, *Took* once ended. */
function DurationPair({ run, live }: { run: DispatchRunDto; live: boolean }) {
  const t = useTranslations('runs.hosted');
  if (live) {
    return (
      <MetaPair label={t('meta.elapsed')}>
        <Elapsed since={run.startedAt} />
      </MetaPair>
    );
  }
  return run.endedAt ? (
    <MetaPair label={t('meta.took')}>{formatRunDuration(run.startedAt, run.endedAt)}</MetaPair>
  ) : null;
}

/**
 * A RUN IN AN AGENT in the section (Story MOTIR-6864 · MOTIR-7028; design
 * MOTIR-7022 panels 7–9): who worked it and a link to the agent, the meta row, the
 * six phases (waking is part of Starting), the end, and machine time as its only
 * cost. No model, no tokens, no credits (`agent-instance-run.md` §5).
 */
function AgentRunBody({
  run,
  events,
  detail,
  started,
}: {
  run: DispatchRunDto;
  events: DispatchRunEventDto[];
  detail: ReturnType<typeof useHostedRunDetail>;
  /** The send this page just made — its *Waking* / *Starting in* detail. */
  started: { runId: string; agentName: string; woke: boolean } | null;
}) {
  const t = useTranslations('runs.agent');
  const live = isLiveRun(run.status);
  const agent = agentOf(run);
  const pressed = started?.runId === run.id ? started : null;
  return (
    <div className="flex flex-col gap-4" data-testid="agent-run" data-status={run.status}>
      <AgentWhere run={run} live={live} />
      <dl className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-xs">
        <MetaPair label={t('meta.worked')}>
          {agent ? (
            <Link className="text-(--el-link) underline" href={agentPanelHref(agent.id)}>
              {agent.name}
            </Link>
          ) : (
            t('laneGone')
          )}
        </MetaPair>
        {agent ? <MetaPair label={t('meta.codingAgent')}>{agent.profileLabel}</MetaPair> : null}
        <DurationPair run={run} live={live} />
      </dl>
      <HostedPhaseList
        events={events}
        status={run.status}
        detail={detail}
        model={null}
        startingDetail={
          pressed
            ? t(pressed.woke ? 'phaseDetail.waking' : 'phaseDetail.starting', {
                name: pressed.agentName,
              })
            : null
        }
        runningDetail={
          agent ? t('phaseDetail.running', { agent: agent.profileLabel, name: agent.name }) : null
        }
      />
      {!live && detail ? <AgentEndBlock detail={detail} /> : null}
      <AgentRunCost run={run} live={live} variant="block" />
    </div>
  );
}

function MetaPair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-(--el-text-secondary)">{label}</dt>
      <dd className="text-(--el-text)">{children}</dd>
    </div>
  );
}

/**
 * A live run's ELAPSED time, ticking — CLIENT-ONLY. It renders a dash on the
 * server and on the first client paint, then starts the clock in an effect, so a
 * time read during render can never make the two paints disagree.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  if (now === null) return <span>—</span>;
  return <span>{formatRunDuration(since, new Date(now).toISOString())}</span>;
}

/**
 * THE SCOPE BLOCK — *Run as a scope* (Story MOTIR-5363 · design MOTIR-5402
 * panels 1–2): the latest run over this work item's children as ONE row, and the
 * door to all of them at `/runs?scope=<KEY>`.
 *
 * ⚠️ STATIC AT PAGE LOAD, and it opens no stream. The section's connection rule
 * is about THIS item's leg and is unchanged; watching a scoped run live is the
 * run modal's job, one click away through the row. No count is shown either —
 * no count read exists, and the narrowed index is where the rest is.
 */
function ScopeBlock({
  run,
  itemKey,
  time,
  t,
  divided = false,
}: {
  run: DispatchRunListItemDto;
  itemKey: string;
  time: string | null;
  t: ReturnType<typeof useTranslations>;
  divided?: boolean;
}) {
  const routes = useReaderRoutes();
  // A run in an agent is named by who worked it — the agent and its coding agent
  // (MOTIR-7028) — never by the profile id alone.
  const agent = run.agentInstance
    ? `${run.agentInstance.name} · ${run.agentInstance.profileLabel}`
    : [run.agent, run.model].filter(Boolean).join(' · ');
  const detail = [agent, legSummary(run, t)].filter(Boolean).join(' · ');
  return (
    <section
      aria-label={t('scope.heading')}
      className={`flex flex-col gap-2${divided ? ' border-t border-(--el-border-soft) pt-4' : ''}`}
    >
      <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('scope.heading')}</h3>
      <p className="font-sans text-sm text-(--el-text)">
        {t(isLiveRun(run.status) ? 'scope.lineLive' : 'scope.linePast')}
      </p>
      <div className="flex min-w-0 items-center gap-2 py-(--spacing-control-y)">
        {run.stopReason === 'gated' ? (
          <StoppedAtGatePill />
        ) : (
          <RunTonePill tone={RUN_STATUS_TONE[run.status]}>
            {t(`runStatus.${run.status}`)}
          </RunTonePill>
        )}
        <Link
          className="shrink-0 text-(--el-link) underline"
          href={routes.view(runsHref({ scope: itemKey, run: run.id }))}
        >
          {t(`command.${run.command}`)}
        </Link>
        <span className="min-w-0 truncate font-sans text-xs text-(--el-text-secondary)">
          {detail}
        </span>
        <span className="ml-auto shrink-0 font-sans text-xs text-(--el-text-secondary)">
          {time ?? ''}
        </span>
      </div>
      <Link
        className="self-start font-sans text-sm text-(--el-link) underline"
        href={routes.view(runsHref({ scope: itemKey }))}
      >
        {t('scope.door', { key: itemKey })}
      </Link>
    </section>
  );
}

/**
 * The skipped leg's line. A manual leg names who it waits on (MOTIR-7477), and
 * when that is the READER the sentence is the way to the gate's row — their
 * Workbench's **Waiting on you** (`?tab=approvals`). It links only then: another
 * person's gate is on THEIR list, which a link to the reader's own would not show.
 */
function SkipLine({
  leg,
  skipReason,
  t,
}: {
  leg: DispatchRunCardDto;
  skipReason: NonNullable<DispatchRunCardDto['skipReason']>;
  t: ReturnType<typeof useTranslations>;
}) {
  const message = skipReasonMessage({ skipReason, manualGate: leg.manualGate });
  const text = t(message.key, message.values);
  const toWaitingOnYou =
    skipReason === 'needs_human' &&
    leg.manualGate?.state === 'awaiting' &&
    leg.manualGate.routedToReader;
  return (
    <p className="font-sans text-sm text-(--el-text-secondary)">
      {toWaitingOnYou ? (
        <Link className="text-(--el-link) underline" href={workbenchTabHref('approvals')}>
          {text}
        </Link>
      ) : (
        text
      )}
    </p>
  );
}

export type { DispatchRunCardDto };
