import { afterEach, beforeEach, vi } from 'vitest';

// The shipped Toast (Radix, `duration={5000}` in `@motir/design-system`) arms a
// close timer that Radix never clears on unmount. Left running, it fires after
// the file's happy-dom window is torn down and throws "document is not defined"
// as an unhandled error, which fails the Vitest shard. Call this at a test
// file's top level: it tracks those timers and clears them after each test.
const TOAST_DURATION_MS = 5000;

export function clearToastTimersAfterEach(): void {
  const timers: number[] = [];
  beforeEach(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = realSetTimeout(handler, ms, ...args);
      if (ms === TOAST_DURATION_MS) timers.push(id);
      return id;
    }) as typeof window.setTimeout);
  });
  afterEach(() => {
    for (const id of timers.splice(0)) window.clearTimeout(id);
  });
}
