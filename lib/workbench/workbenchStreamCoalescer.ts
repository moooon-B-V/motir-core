// The process-wide COALESCER and READ LIMITER behind the live streams
// (Story MOTIR-8542 · Subtask MOTIR-8729).
//
// A notification says "something under these ids moved"; a burst of writes says
// it hundreds of times in a second. Every open stream on the moved project must
// re-read, but none of them needs to re-read once per write. So a notification
// arms ONE window per KEY for the whole process, further notifications for that
// key inside the window add nothing, and when the window closes every stream
// listening on the key is told once. A thousand streams on one project cost one
// timer per burst, never a thousand.
//
// The reads those streams then take run through ONE limiter for the process, so
// a window that wakes a thousand streams does not ask the pool for a thousand
// connections at the same instant. Each read is still that reader's own read
// under its own `withWorkspaceContext`: the limiter bounds WHEN reads run, it
// never shares one between readers, because the predicates are per reader.
//
// ⚠️ IT READS NOTHING AND DECIDES NOTHING ABOUT ACCESS. It is timers and a queue.
//
// ⚠️ KEYED, NOT PROJECT-SHAPED. The plan frames card adds a plan key beside the
// project and workspace keys and shares the same limiter; nothing here knows
// what a key names.

/** How long a notification's window stays open before its listeners are told. */
export const WORKBENCH_STREAM_COALESCE_MS = 250;

/** How many stream re-reads may run at once in one process. */
export const WORKBENCH_STREAM_READ_CONCURRENCY = 8;

/** The window key for one project's writes. */
export function projectWindowKey(workspaceId: string, projectId: string): string {
  return `p:${workspaceId}:${projectId}`;
}

/**
 * The window key for one plan's writes (MOTIR-8730). Independent of the project
 * key: a plan write arms both, and each stream reacts to the one it listens on.
 */
export function planWindowKey(workspaceId: string, planId: string): string {
  return `plan:${workspaceId}:${planId}`;
}

/** The window key for a write that names a workspace but no project. */
export function workspaceWindowKey(workspaceId: string): string {
  return `w:${workspaceId}`;
}

export interface WorkbenchStreamCoalescer {
  /** Be told once per closed window on `key`. Returns the un-listen. */
  listen(key: string, listener: () => void): () => void;
  /** A notification for `key` arrived: open its window unless one is already open. */
  touch(key: string): void;
  /** Run `task` once a read slot is free. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Reads running now. */
  readonly activeReads: number;
  /** Reads waiting for a slot. */
  readonly queuedReads: number;
  /** Windows open now. */
  readonly openWindows: number;
}

export interface WorkbenchStreamCoalescerOptions {
  windowMs?: number;
  concurrency?: number;
  logger?: Pick<Console, 'warn'>;
}

export function createWorkbenchStreamCoalescer(
  opts: WorkbenchStreamCoalescerOptions = {},
): WorkbenchStreamCoalescer {
  const windowMs = opts.windowMs ?? WORKBENCH_STREAM_COALESCE_MS;
  const concurrency = opts.concurrency ?? WORKBENCH_STREAM_READ_CONCURRENCY;
  const log = opts.logger ?? console;

  const listeners = new Map<string, Set<() => void>>();
  const windows = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: Array<() => void> = [];
  let active = 0;

  function close(key: string): void {
    windows.delete(key);
    for (const listener of [...(listeners.get(key) ?? [])]) {
      try {
        listener();
      } catch (err) {
        log.warn('[workbench-stream] a window listener threw; the others are still told', err);
      }
    }
  }

  function release(): void {
    active -= 1;
    queue.shift()?.();
  }

  return {
    listen(key, listener) {
      // A fresh entry per call, so one function listening twice is two
      // registrations and each un-listen removes exactly its own.
      const entry = (): void => listener();
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(entry);
      let listening = true;
      return () => {
        if (!listening) return;
        listening = false;
        const current = listeners.get(key);
        if (!current) return;
        current.delete(entry);
        if (current.size > 0) return;
        listeners.delete(key);
        // Nobody left to tell: a window still open on this key is dead weight.
        const timer = windows.get(key);
        if (timer) {
          clearTimeout(timer);
          windows.delete(key);
        }
      };
    },
    touch(key) {
      if (windows.has(key) || !listeners.has(key)) return;
      const timer = setTimeout(() => close(key), windowMs);
      timer.unref?.();
      windows.set(key, timer);
    },
    run(task) {
      return new Promise((resolve, reject) => {
        const go = (): void => {
          active += 1;
          let pending: Promise<unknown>;
          try {
            pending = task();
          } catch (err) {
            pending = Promise.reject(err);
          }
          pending.then(resolve as (value: unknown) => void, reject).finally(release);
        };
        if (active < concurrency) go();
        else queue.push(go);
      });
    },
    get activeReads() {
      return active;
    },
    get queuedReads() {
      return queue.length;
    },
    get openWindows() {
      return windows.size;
    },
  };
}

// On `globalThis` for the hub's reason: a hot reload re-evaluates this module,
// and a second copy would be a second limiter the first one cannot see.
const COALESCER_KEY = Symbol.for('motir.workbench.streamCoalescer');

/** The process-wide coalescer. Every call, from every copy of this module, answers the same instance. */
export function getWorkbenchStreamCoalescer(): WorkbenchStreamCoalescer {
  const holder = globalThis as typeof globalThis & {
    [COALESCER_KEY]?: WorkbenchStreamCoalescer;
  };
  holder[COALESCER_KEY] ??= createWorkbenchStreamCoalescer();
  return holder[COALESCER_KEY];
}
