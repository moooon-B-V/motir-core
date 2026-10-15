// A boolean a source owns and React reads through `useSyncExternalStore`
// (Story MOTIR-8539 · Subtask MOTIR-8572). Directive-free, so a source module
// that is not a React module can own one.

export interface LiveFlag {
  get(): boolean;
  subscribe(listener: () => void): () => void;
}

/** A flag that is always `false` — a source with no connection to lose. */
export const NEVER_RECONNECTING: LiveFlag = {
  get: () => false,
  subscribe: () => () => {},
};

/** A settable flag: `set` notifies only on a change. */
export function createLiveFlag(initial = false): LiveFlag & { set(value: boolean): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
