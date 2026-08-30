'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDownToLine, CloudOff, Clock, Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import type { DispatchRunDto, DispatchRunEventDto } from '@/lib/dto/dispatchRuns';
import { formatRunInstant } from '@/lib/runs/runClock';
import { isLiveRun } from '@/lib/runs/timeline';

// THE LOG PANE of the run modal (MOTIR-3962 · `design/runs/design-notes.md`
// § The LOG pane) — what the agent actually SAID.
//
// The canvas on the left answers *where is this run*; this answers *what is it
// doing*, which is the question a person opens a run to have answered and the
// one no status chip can carry.
//
// ⚠️ THE EMPTY STATES CARRY MORE WEIGHT THAN THE FULL ONE, and there are THREE
// of them. Sending log bodies is opt-in and off by default, enforced on the
// operator's own machine — `motir help`: "the machine that holds the content is
// the machine that decides whether it leaves." So the ORDINARY run has nothing
// here. One message for all three tells a person their run failed to record when
// in fact they chose that, or when the record simply aged out; the design's own
// table exists to prevent exactly that collapse.

/** Bodies are swept 30 days after the run — `DISPATCH_RUN_BODY_RETENTION_DAYS`. */
const RETENTION_DAYS = 30;

/**
 * The rendered window's cap.
 *
 * ⚠️ A BOUNDED TAIL, not a virtualizer. A fifty-minute run is tens of thousands
 * of lines, and the two ways to survive that are to virtualize or to hold a
 * bounded tail. The tail is chosen because the other half of this component is a
 * FILTER, and a filter SHRINKS the set — a stale virtualized window over a set
 * that just got smaller is the `shrinking-list` crash, and a plain slice cannot
 * have it.
 */
const WINDOW = 500;

/** Treat a scroll within this many px of the bottom as "at the bottom". */
const TAIL_SLACK = 24;

export interface RunLogPaneProps {
  run: DispatchRunDto;
  /**
   * The work item the modal has SELECTED, or null for the whole run. The
   * selection lives in the modal — this pane receives it and never owns it.
   */
  selectedWorkItemId: string | null;
}

export function RunLogPane({ run, selectedWorkItemId }: RunLogPaneProps) {
  const t = useTranslations('runs');
  const [live, setLive] = useState<DispatchRunEventDto[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Following is the DEFAULT and is released by the reader, never by the code.
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);

  // ⚠️ ONE CODE PATH FOR BACKFILL AND LIVE, and the endpoint is the same.
  // `?since=0` returns every line the run has stored and THEN tails; for a run
  // already terminal the route emits its events, writes `done` and closes, so a
  // finished run costs exactly one request that ends itself.
  //
  // ⚠️ THIS DIFFERS FROM THE CARD'S AC — flagged on MOTIR-3962 rather than done
  // quietly. The AC asks for ZERO stream requests on a terminal run, which was
  // written expecting the backfill to come from `GET /api/dispatch-runs/[id]`.
  // That read returns the header and its LEGS and no events at all, so obeying
  // the AC literally would leave a finished run — the common case for reading
  // logs — permanently blank. What the rule protects is a HELD-OPEN connection
  // for a run at rest, and that property holds: the `done` frame ends the loop
  // and nothing reconnects.
  const runId = run.id;
  const runIsLive = isLiveRun(run.status);
  const seqRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const res = await fetch(
            `/api/dispatch-runs/${encodeURIComponent(runId)}/stream?since=${seqRef.current}`,
            { headers: { Accept: 'text/event-stream' }, signal: controller.signal },
          );
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

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
                if (ev.kind !== 'log') continue;
                // Deduped on `seq`, which is what makes a RECONNECT neither a
                // replay nor a gap: `@@unique([dispatchRunId, seq])` guarantees
                // the cursor addresses exactly one line.
                setLive((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]));
              } else if (event === 'done') {
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
        const backoff = Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    };

    void pump();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId]);

  /** Key → work-item id, so a line the leg produced can be matched to the selection. */
  const legByKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const leg of run.cards) if (leg.key !== null) map.set(leg.key, leg.workItemId);
    return map;
  }, [run.cards]);

  /**
   * The lines, in `seq` order — the RUN's order, never arrival order.
   *
   * Backfill and live are the SAME list because they arrive through the same
   * endpoint, deduped on `seq`: a reconnect replays nothing and drops nothing.
   */
  const lines = useMemo(() => {
    const bySeq = new Map<number, DispatchRunEventDto>();
    for (const ev of live) bySeq.set(ev.seq, ev);
    const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    const filtered =
      selectedWorkItemId === null
        ? all
        : all.filter((ev) => {
            const key = keyOf(ev);
            return key !== null && legByKey.get(key) === selectedWorkItemId;
          });
    // The bounded TAIL — the most recent `WINDOW` lines. A plain slice, so a
    // filter that shrinks the set cannot leave a window addressing rows that
    // are no longer there.
    return filtered.slice(-WINDOW);
  }, [live, selectedWorkItemId, legByKey]);

  const dropped = Math.max(0, countAll(live, selectedWorkItemId, legByKey) - lines.length);

  // FOLLOW-THE-TAIL. Pinned to the bottom while following; the scroll handler
  // below is the only thing that releases it.
  useEffect(() => {
    if (!followingRef.current) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    // ⚠️ RELEASED BY AN UPWARD SCROLL, and re-armed only by the CONTROL — never
    // silently re-armed by scrolling back down. A console that yanks a reader to
    // the bottom mid-read is the classic version of this bug, and re-arming on
    // proximity is how it comes back.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK;
    if (!atBottom && followingRef.current) {
      followingRef.current = false;
      setFollowing(false);
    }
  }, []);

  const resumeFollowing = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const silence = whichSilence(run, runIsLive, lines.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {silence !== null ? (
        <Silence kind={silence} t={t} />
      ) : (
        <>
          <div
            ref={bodyRef}
            onScroll={onScroll}
            data-testid="run-log-body"
            // ⚠️ `min-w-0` on the scroller and `overflow-x-auto` on the LINE:
            // a very long line scrolls inside the console, never the page.
            className="min-h-0 min-w-0 flex-1 overflow-auto bg-(--el-surface) px-(--spacing-card-padding) py-2 font-mono text-[0.6875rem] leading-relaxed text-(--el-text-secondary)"
          >
            {dropped > 0 ? (
              <p className="pb-1 text-(--el-text-tertiary)" data-testid="run-log-truncated">
                {t('logTruncated', { count: dropped })}
              </p>
            ) : null}
            {lines.map((ev) => (
              <div key={ev.seq} className="flex gap-2 whitespace-pre">
                <span className="flex-none text-(--el-text-tertiary)">
                  {formatRunInstant(ev.createdAt)}
                </span>
                {/* Unfiltered, every line names its SOURCE member; filtered to
                    one, the label is noise on every row and is dropped. */}
                {selectedWorkItemId === null && keyOf(ev) !== null ? (
                  <span className="flex-none text-(--el-accent-on-surface)">{keyOf(ev)}</span>
                ) : null}
                <span className="min-w-0 overflow-x-auto text-(--el-text)">{ev.body}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-(--el-border-soft) px-(--spacing-card-padding) py-1.5 text-[0.6875rem] text-(--el-text-secondary)">
            <span className="min-w-0 truncate">{t('logCount', { count: lines.length })}</span>
            {!following ? (
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto min-w-0 shrink-0"
                onClick={resumeFollowing}
              >
                <ArrowDownToLine className="size-3.5" aria-hidden="true" />
                {t('logResumeFollow')}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/** The `workItemKey` a `log` event was written with, when it carries one. */
function keyOf(ev: DispatchRunEventDto): string | null {
  const data = ev.data;
  if (data !== null && typeof data === 'object' && 'workItemKey' in data) {
    const k = (data as { workItemKey?: unknown }).workItemKey;
    if (typeof k === 'string') return k;
  }
  return null;
}

/** How many lines the filter admits, BEFORE the window's tail is taken. */
function countAll(
  events: DispatchRunEventDto[],
  selectedWorkItemId: string | null,
  legByKey: Map<string, string | null>,
): number {
  if (selectedWorkItemId === null) return events.length;
  let n = 0;
  for (const ev of events) {
    const key = keyOf(ev);
    if (key !== null && legByKey.get(key) === selectedWorkItemId) n += 1;
  }
  return n;
}

type SilenceKind = 'neverSent' | 'waiting' | 'expired';

/**
 * WHICH SILENCE — the decision the design's table exists to force.
 *
 * ⚠️ ORDER MATTERS. A LIVE run that has printed nothing is *waiting*, whatever
 * else is true of it; only a finished run can be said to have sent nothing or to
 * have aged out. And expiry is checked before never-sent, because a run older
 * than the window cannot distinguish the two from this side — the bodies are
 * gone either way, and *the record aged out* is the one that does not accuse the
 * operator of a choice they may not have made.
 */
function whichSilence(
  run: DispatchRunDto,
  runIsLive: boolean,
  rendered: number,
): SilenceKind | null {
  if (rendered > 0) return null;
  if (runIsLive) return 'waiting';
  const ageDays = (Date.now() - new Date(run.startedAt).getTime()) / 86_400_000;
  return ageDays > RETENTION_DAYS ? 'expired' : 'neverSent';
}

function Silence({ kind, t }: { kind: SilenceKind; t: ReturnType<typeof useTranslations> }) {
  const Icon = kind === 'waiting' ? Hourglass : kind === 'expired' ? Clock : CloudOff;
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-1.5 p-(--spacing-card-padding) text-center"
      data-testid={`run-log-silence-${kind}`}
    >
      <Icon className="size-5 text-(--el-text-tertiary)" aria-hidden="true" />
      <p className="text-[0.8125rem] font-semibold text-(--el-text)">
        {t(`logSilence.${kind}.title`)}
      </p>
      <p className="max-w-xs text-xs text-(--el-text-secondary)">{t(`logSilence.${kind}.body`)}</p>
    </div>
  );
}
