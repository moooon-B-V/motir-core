import { act } from '@testing-library/react';
import type { LiveSignalListener, LiveSignalSource, LiveTopic } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import type { WorkbenchTabKey } from '@/lib/dto/workbench';

// A LIVE SOURCE THE TEST FIRES BY HAND (Story MOTIR-8539 · Subtask MOTIR-8579).
//
// The seam's contract and nothing else: `subscribe` per topic, a `seq` per topic,
// and no transport. It is what lets one test drive every live applier at once —
// the Workbench, the open approval and a generating plan — and count, per topic,
// who is listening. A real source (the stream, the plan poll, the push story's)
// plugs into the same `LiveSignalProvider` in its place.

const keyOf = (topic: LiveTopic) => (topic.kind === 'plan' ? `plan:${topic.planId}` : topic.kind);

export interface FakeLiveSource {
  source: LiveSignalSource;
  /** `subscribe` calls so far, per topic key (`workbench`, `plan:<id>`). */
  subscribes: Map<string, number>;
  /** Listeners currently attached to `topic`. */
  listening(topic: LiveTopic): number;
  /** Deliver one signal on `topic` to every listener, inside `act`. */
  fire(topic: LiveTopic, moved?: readonly WorkbenchTabKey[]): Promise<void>;
  /** The same, without `act` — for a burst inside one scope of the caller's. */
  fireSync(topic: LiveTopic, moved?: readonly WorkbenchTabKey[]): void;
}

export function fakeLiveSource(): FakeLiveSource {
  const listeners = new Map<string, Set<LiveSignalListener>>();
  const seqs = new Map<string, number>();
  const subscribes = new Map<string, number>();

  const fireSync = (topic: LiveTopic, moved?: readonly WorkbenchTabKey[]) => {
    const key = keyOf(topic);
    const seq = (seqs.get(key) ?? 0) + 1;
    seqs.set(key, seq);
    for (const l of [...(listeners.get(key) ?? [])]) {
      l(moved === undefined ? { topic, seq } : { topic, seq, moved });
    }
  };

  return {
    source: {
      subscribe(topic, onSignal) {
        const key = keyOf(topic);
        subscribes.set(key, (subscribes.get(key) ?? 0) + 1);
        const set = listeners.get(key) ?? new Set<LiveSignalListener>();
        listeners.set(key, set);
        set.add(onSignal);
        return () => set.delete(onSignal);
      },
      reconnecting: createLiveFlag(false),
    },
    subscribes,
    listening: (topic) => listeners.get(keyOf(topic))?.size ?? 0,
    async fire(topic, moved) {
      await act(async () => fireSync(topic, moved));
    },
    fireSync,
  };
}
