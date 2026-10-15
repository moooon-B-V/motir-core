import { NEVER_RECONNECTING } from '../liveFlag';
import type { LiveSignal, LiveSignalListener, LiveSignalSource, LiveTopic } from '../liveSignal';

// THE GENERATING-PLAN POLL'S CADENCE, AS A SOURCE (Story MOTIR-8539 ·
// Subtask MOTIR-8572).
//
// ⚠️ IT OWNS THE CADENCE AND NOTHING ELSE. Every read decision stays in
// `useGeneratingPlanPoll`: no read behind one in flight and the `STALL_MS`
// abort (MOTIR-8102), the `?since=` unchanged answer and the full-read backstop
// (MOTIR-8127), the ordered apply, `failing`. A tick here is "it is time to
// look", and the hook decides whether looking means a read.
//
// One interval per subscription, as each hook instance had its own before the
// seam. `trigger` is the hook's explicit `refresh()` — a FORCED signal to every
// subscriber of that plan.

/** The generating-plan poll cadence. */
export const POLL_MS = 2500;

type PlanTopic = Extract<LiveTopic, { kind: 'plan' }>;

const listenersByPlan = new Map<string, Set<LiveSignalListener>>();
const seqByPlan = new Map<string, number>();

function emit(topic: PlanTopic, listener: LiveSignalListener, forced: boolean): void {
  const seq = (seqByPlan.get(topic.planId) ?? 0) + 1;
  seqByPlan.set(topic.planId, seq);
  const signal: LiveSignal = forced ? { topic, seq, forced: true } : { topic, seq };
  listener(signal);
}

export const planPollSource: LiveSignalSource = {
  subscribe(topic, onSignal) {
    if (topic.kind !== 'plan') return () => {};
    const planTopic: PlanTopic = { kind: 'plan', planId: topic.planId };
    let listeners = listenersByPlan.get(topic.planId);
    if (!listeners) {
      listeners = new Set();
      listenersByPlan.set(topic.planId, listeners);
    }
    // A wrapper per subscription, so the same callback subscribed twice is two.
    const listener: LiveSignalListener = (signal) => onSignal(signal);
    listeners.add(listener);
    const handle = setInterval(() => emit(planTopic, listener, false), POLL_MS);
    return () => {
      clearInterval(handle);
      listeners.delete(listener);
      if (listeners.size === 0) listenersByPlan.delete(topic.planId);
    };
  },
  trigger(topic) {
    if (topic.kind !== 'plan') return;
    const listeners = listenersByPlan.get(topic.planId);
    if (!listeners) return;
    for (const listener of [...listeners]) emit(topic, listener, true);
  },
  reconnecting: NEVER_RECONNECTING,
};
