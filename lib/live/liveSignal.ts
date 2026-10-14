'use client';

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { WorkbenchTabKey } from '@/lib/dto/workbench';
import { NEVER_RECONNECTING, type LiveFlag } from './liveFlag';
import { planPollSource } from './sources/planPollSource';

// THE LIVE-SIGNAL SEAM (Story MOTIR-8539 · Subtask MOTIR-8572) — one
// source-agnostic "something moved" input that every live applier reads.
//
// ⚠️ IT CARRIES A TRIGGER, NEVER DATA. A signal says a topic moved and nothing
// about what it moved to: an applier re-reads through the read it already owns.
// So no applier ever parses a transport frame, and swapping the transport (the
// push story, MOTIR-8542) cannot change what an applier renders.
//
// ⚠️ A SOURCE BEHIND A CONTEXT, NOT A GLOBAL BUS. A test hands an applier a fake
// source by wrapping it in a {@link LiveSignalProvider}, and so will the push
// story. The shell mounts ONE provider (`WorkbenchLive`), whose workbench source
// holds the ONE connection `useWorkbenchLive.ts`' header requires, however many
// appliers subscribe.
//
// Today's two sources, plugged in behind it:
//
//   · `workbench` — the SSE nudge (`sources/workbenchStreamSource.ts`), held by
//     the shell's provider. With no provider the topic is QUIET: a surface
//     rendered outside the shell is simply never nudged, as it was before.
//   · `plan` — the generating-plan poll's cadence (`sources/planPollSource.ts`).
//     It is a timer, not a connection, so it needs no shared holder and serves
//     the plan topic with or without a provider: the onboarding reveal and the
//     plan page poll exactly as they did before the seam existed.

/** What a signal is about. */
export type LiveTopic = { kind: 'workbench' } | { kind: 'plan'; planId: string };

/** "Something moved" on a topic. */
export interface LiveSignal {
  topic: LiveTopic;
  /** Monotonic per topic, within one source. */
  seq: number;
  /**
   * The Workbench tabs the stream frame named — workbench signals only, copied
   * from the frame. A hint an applier MAY use; nothing has to.
   */
  moved?: readonly WorkbenchTabKey[];
  /**
   * An explicit nudge rather than a cadence tick: read NOW, even over a read
   * already in flight (`useGeneratingPlanPoll`'s `refresh()`).
   */
  forced?: boolean;
}

export type LiveSignalListener = (signal: LiveSignal) => void;

/** Where signals come from. */
export interface LiveSignalSource {
  /** Start delivering `topic`'s signals to `onSignal`. Returns the unsubscribe. */
  subscribe(topic: LiveTopic, onSignal: LiveSignalListener): () => void;
  /** Signal `topic` now, as an explicit nudge. A source with nothing to nudge omits it. */
  trigger?(topic: LiveTopic): void;
  /** The source's connection dropped and is backing off. */
  readonly reconnecting: LiveFlag;
}

/** A source that never signals. */
export const QUIET_LIVE_SOURCE: LiveSignalSource = {
  subscribe: () => () => {},
  reconnecting: NEVER_RECONNECTING,
};

/** One source per topic kind, presented as one source. */
export function routeLiveSources(routes: {
  workbench: LiveSignalSource;
  plan: LiveSignalSource;
}): LiveSignalSource {
  return {
    subscribe: (topic, onSignal) => routes[topic.kind].subscribe(topic, onSignal),
    trigger: (topic) => routes[topic.kind].trigger?.(topic),
    // The chip says the WORKBENCH connection is down; a poll has no connection.
    reconnecting: routes.workbench.reconnecting,
  };
}

/** What an applier reads with no provider above it: a QUIET Workbench, the plan cadence. */
export const DEFAULT_LIVE_SOURCE: LiveSignalSource = routeLiveSources({
  workbench: QUIET_LIVE_SOURCE,
  plan: planPollSource,
});

const LiveSignalContext = createContext<LiveSignalSource>(DEFAULT_LIVE_SOURCE);

/** Hand `source` to every applier below. */
export function LiveSignalProvider({
  source,
  children,
}: {
  source: LiveSignalSource;
  children?: ReactNode;
}) {
  return createElement(LiveSignalContext.Provider, { value: source }, children);
}

/** The source in scope — for an applier that also nudges (`trigger`). */
export function useLiveSignalSource(): LiveSignalSource {
  return useContext(LiveSignalContext);
}

/** A topic's stable identity, so an equal topic object is the same subscription. */
export function liveTopicKey(topic: LiveTopic): string {
  return topic.kind === 'plan' ? `plan:${topic.planId}` : 'workbench';
}

/**
 * Receive `topic`'s signals while `enabled`.
 *
 * ⚠️ THE CALLBACK IS HELD IN A REF, so a caller re-rendering with a new closure
 * never re-subscribes — the discipline `useGeneratingPlanPoll` already used for
 * `onSnapshot`. A re-subscribe would cost a connection on a stream source and a
 * restarted cadence on a timer source. Only a different TOPIC, a different
 * SOURCE or a flip of `enabled` subscribes again; unmounting unsubscribes.
 */
export function useLiveSignal(
  topic: LiveTopic,
  onSignal: LiveSignalListener,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const source = useContext(LiveSignalContext);
  const callback = useRef(onSignal);
  useEffect(() => {
    callback.current = onSignal;
  });
  const topicRef = useRef(topic);
  useEffect(() => {
    topicRef.current = topic;
  });
  const key = liveTopicKey(topic);
  useEffect(() => {
    if (!enabled) return;
    return source.subscribe(topicRef.current, (signal) => callback.current(signal));
  }, [source, key, enabled]);
}

/** Whether the source in scope is reconnecting — the *Reconnecting…* chip's input. */
export function useLiveReconnecting(): boolean {
  const { reconnecting } = useContext(LiveSignalContext);
  return useSyncExternalStore(reconnecting.subscribe, reconnecting.get, reconnecting.get);
}
