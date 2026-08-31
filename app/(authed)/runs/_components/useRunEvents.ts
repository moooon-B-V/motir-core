'use client';

import { useEffect, useRef, useState } from 'react';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import type { DispatchRunEventDto } from '@/lib/dto/dispatchRuns';

// THE RUN'S EVENT STREAM, once (MOTIR-3983).
//
// ⚠️ LIFTED OUT OF THE LOG PANE BECAUSE IT NOW HAS TWO CONSUMERS. The log pane
// reads `log` events; the FINDINGS strip reads `bug_filed` / `plan_submitted` /
// `plan_approved`. Both are the same stream, and two components each opening
// their own connection to it is a fan-out wearing a different name — the exact
// defect the run surfaces' own bounded-reads guard exists to catch, one
// interaction further in. So the modal holds it and hands the events down.
//
// ⚠️ ONE CODE PATH FOR BACKFILL AND LIVE. `?since=0` returns every line the run
// has stored and THEN tails; for a run already terminal the route emits its
// events, writes `done` and closes, so a finished run costs exactly one request
// that ends itself. Events are deduped on `seq` — `@@unique([dispatchRunId,
// seq])` is what makes a reconnect neither a replay nor a gap.

export interface RunEventStream {
  events: DispatchRunEventDto[];
  /** The connection dropped while the run is still going, and is backing off. */
  reconnecting: boolean;
  /**
   * The stream delivered its terminal `done` frame — the RUN ended.
   *
   * ⚠️ THIS USED TO BE SWALLOWED, and the bug it caused is the one thing this
   * whole surface promises not to do. The route writes `done` and closes when
   * the run reaches a terminal status, and the hook read that frame, set its
   * own `cancelled` flag and returned — so the modal was never told. A person
   * watching a live run saw it stop and the header went on saying `Running`,
   * with no stop reason, until they reloaded the page.
   *
   * The card-scoped kinds cannot stand in for it: closing a run writes NO event
   * row (`dispatchRunService.close` updates `status` and `stopReason` on the run
   * itself), so `done` is the only signal that the run — as opposed to one of
   * its legs — is over.
   */
  finished: boolean;
}

export function useRunEvents(runId: string): RunEventStream {
  const [events, setEvents] = useState<DispatchRunEventDto[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [finished, setFinished] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    // ⚠️ NO RESET HERE, deliberately. `RunModal` is KEYED ON `runId` at its mount
    // site, so a different run REMOUNTS and `useState`'s initializer is the
    // reset — the same one mechanism the modal's own load effect relies on.
    // Resetting from inside this effect would be the cascading render
    // `react-hooks/set-state-in-effect` forbids, and would buy nothing.
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
                // Say so BEFORE returning: this is the only notice the run
                // itself ended, and the modal re-reads the run on it.
                setFinished(true);
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
        // resume FROM THE CURSOR — the schema's `@@unique([dispatchRunId, seq])`
        // is what makes that neither a replay nor a gap.
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
  }, [runId]);

  return { events, reconnecting, finished };
}
