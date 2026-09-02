'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Bot, CloudOff, TriangleAlert } from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import type {
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunEventDto,
} from '@/lib/dto/dispatchRuns';
import {
  CARD_STEPS,
  DISPOSITION_TONE,
  EVENT_STEP,
  RUN_STATUS_TONE,
  SKIP_REASON_KEY,
  isLiveRun,
  type CardStep,
} from '@/lib/runs/timeline';

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

export interface RunSectionProps {
  /** This card's runs, newest first. The FIRST row is the current run. */
  initialRuns: DispatchRunDto[];
  /** The history cursor, or null when the first page is the whole history. */
  initialCursor: string | null;
  itemKey: string;
  /** Rendered on the server so a relative time never disagrees on first paint. */
  formattedTimes: Record<string, string>;
}

export function RunSection({
  initialRuns,
  initialCursor,
  itemKey,
  formattedTimes,
}: RunSectionProps) {
  const t = useTranslations('runs');
  const [runs, setRuns] = useState(initialRuns);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [events, setEvents] = useState<DispatchRunEventDto[]>([]);

  const current = runs[0] ?? null;
  const leg = useMemo(
    () => current?.cards.find((c) => c.key === itemKey) ?? null,
    [current, itemKey],
  );

  // ⚠️ THE ONE PREDICATE THAT DECIDES WHETHER A CONNECTION IS OPENED AT ALL.
  // `isLiveRun` is `lib/runs/timeline.ts`'s, the same map the server answers
  // `?status=live` from — not a second reading of "is it running".
  const liveRunId = current && isLiveRun(current.status) ? current.id : null;

  // The cursor the stream resumes from. Held in a ref rather than in state so a
  // reconnect reads the latest value without the effect depending on it — an
  // effect that re-ran on every event would tear the connection down per frame.
  const seqRef = useRef(current?.seq ?? 0);

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
  }, [liveRunId]);

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

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <Bot className="size-5 text-(--el-text-faint)" aria-hidden="true" />
        <p className="font-sans text-sm text-(--el-text)">{t('empty.title')}</p>
        <p className="max-w-[28rem] font-sans text-sm text-(--el-text-secondary)">
          {t('empty.body')}
        </p>
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

  const runTone = current ? RUN_STATUS_TONE[current.status] : 'queued';
  const legTone = leg ? DISPOSITION_TONE[leg.disposition] : 'queued';
  const otherCards = current ? current.cards.length : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <RunTonePill tone={legTone}>{t(`disposition.${leg?.disposition ?? 'queued'}`)}</RunTonePill>
        {current ? (
          <RunTonePill tone={runTone}>{t(`runStatus.${current.status}`)}</RunTonePill>
        ) : null}
      </div>

      {leg?.disposition === 'skipped' && leg.skipReason ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t(`skipReason.${SKIP_REASON_KEY[leg.skipReason]}`)}
        </p>
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
            <Link className="text-(--el-link) underline" href={`/runs/${current.id}`}>
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

      {current?.status === 'timed_out' ? (
        <p className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
          <CloudOff className="size-4" aria-hidden="true" />
          {t('reportingOffline')}
        </p>
      ) : null}

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

      <div className="flex flex-col gap-1">
        <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('history.title')}</h3>
        <ul className="flex min-w-0 flex-col">
          {runs.map((run) => (
            <li
              key={run.id}
              className="flex min-w-0 items-center gap-2 border-t border-(--el-border-soft) py-(--spacing-control-y) first:border-t-0"
            >
              <RunTonePill tone={RUN_STATUS_TONE[run.status]}>
                {t(`runStatus.${run.status}`)}
              </RunTonePill>
              <Link
                className="min-w-0 truncate text-(--el-link) underline"
                href={`/runs/${run.id}`}
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
    </div>
  );
}

export type { DispatchRunCardDto };
