'use client';

import { useEffect, useState } from 'react';
import { drainSseFrames } from '@/lib/ai/sseFrames';
import type { AgentInstanceBootDto, AgentInstanceBootStepFrameDto } from '@/lib/dto/agentInstances';

// AN AGENT'S BOOT, LIVE (Story MOTIR-7393 · MOTIR-7400) — the panel's one reader of
// `…/instances/[id]/boot/stream` (`agent-instances.md` AMENDMENT 6 §7). The stream
// opens with a `snapshot` of the current attempt, then sends a `step` frame per
// step written and `done { state }` when the attempt closes; for an attempt that
// is already closed it replays and closes at once, so a running agent's summary
// costs one request that ends itself.
//
// A dropped connection resumes FROM THE CURSOR (`?since=<seq>`) after a backoff.
// A frame never overwrites a newer one: a step is applied only when its `seq` is
// above the row's, and only to the attempt on screen — a new attempt arrives as a
// fresh snapshot, which replaces the read-out whole (the stream's own rule).

/** The `done` frame: how the attempt ended, and the cursor it was current to. */
export interface AgentBootDoneFrame {
  state: NonNullable<AgentInstanceBootDto['outcome']>;
  seq: number;
}

export type AgentBootFrame =
  | { event: 'snapshot'; data: AgentInstanceBootDto }
  | { event: 'step'; data: AgentInstanceBootStepFrameDto }
  | { event: 'done'; data: AgentBootDoneFrame };

/** Apply one frame to the read-out on screen. Pure, so the sequencing is testable. */
export function applyBootFrame(
  boot: AgentInstanceBootDto | null,
  frame: AgentBootFrame,
): AgentInstanceBootDto | null {
  switch (frame.event) {
    case 'snapshot':
      // An older attempt's snapshot never replaces a newer one on screen.
      if (boot && frame.data.attempt < boot.attempt) return boot;
      return frame.data;
    case 'step': {
      const step = frame.data;
      if (!boot || step.attempt !== boot.attempt) return boot;
      const at = boot.steps.findIndex((s) => s.ordinal === step.ordinal);
      if (at === -1 || boot.steps[at]!.seq >= step.seq) return boot;
      const { attempt: _attempt, ...row } = step;
      const steps = boot.steps.slice();
      steps[at] = row;
      return { ...boot, steps, seq: Math.max(boot.seq, step.seq) };
    }
    case 'done':
      if (!boot || boot.outcome) return boot;
      return { ...boot, outcome: frame.data.state, seq: Math.max(boot.seq, frame.data.seq) };
  }
}

export interface AgentBootStream {
  /** The current attempt, or null before the first frame (or for an agent with none). */
  boot: AgentInstanceBootDto | null;
}

/**
 * Read an agent's boot. `live` decides whether a stream is open at all; a change
 * of `epoch` (the agent's state moving) re-opens it, which is how a wake's new
 * attempt is picked up after the previous one closed.
 */
export function useAgentBoot({
  projectKey,
  agentId,
  live,
  epoch,
}: {
  projectKey: string;
  agentId: string;
  live: boolean;
  epoch: string;
}): AgentBootStream {
  const [boot, setBoot] = useState<AgentInstanceBootDto | null>(null);

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    let cancelled = false;
    let cursor = 0;
    const url = (since: number) =>
      `/api/projects/${encodeURIComponent(projectKey)}/instances/${encodeURIComponent(agentId)}/boot/stream?since=${since}`;

    const pump = async (): Promise<void> => {
      for (let attempt = 0; !cancelled; attempt += 1) {
        try {
          const res = await fetch(url(cursor), {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          // A refusal (not the reader's, gone) is final: the panel's own read decides that face.
          if (!res.ok || !res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = drainSseFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
              if (frame.event !== 'snapshot' && frame.event !== 'step' && frame.event !== 'done')
                continue;
              const typed = frame as AgentBootFrame;
              cursor = Math.max(cursor, typed.data.seq);
              setBoot((prev) => applyBootFrame(prev, typed));
              // The attempt closed: nothing more will come on this stream.
              if (typed.event === 'done') {
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
  }, [projectKey, agentId, live, epoch]);

  return { boot };
}
