'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MigrateIndexStatusDto } from '@/lib/dto/migrateOnboarding';

/** How often the wizard re-reads `…/index-status`. */
export const INDEX_STATUS_POLL_MS = 3000;

/**
 * The migrate run's index status, polled (MOTIR-8771). Extracted from the Index
 * step so the bar's indicator and the step read the same way: every 3 s, the
 * request aborted on unmount, a transient failure keeping the last value, and
 * the poll stopping once every repository is indexed. `refresh` re-reads at
 * once (after a retry) and restarts a stopped poll.
 *
 * `runId: null` reads nothing.
 */
export function useMigrateIndexStatus(runId: string | null): {
  status: MigrateIndexStatusDto | null;
  refresh: () => void;
} {
  const [status, setStatus] = useState<MigrateIndexStatusDto | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    let interval: number | undefined;
    const poll = async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/onboarding/migrate/${runId}/index-status`, {
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok || stopped) return;
        const next = (await res.json()) as MigrateIndexStatusDto;
        if (stopped) return;
        setStatus(next);
        if (next.allIndexed && interval !== undefined) {
          window.clearInterval(interval);
          interval = undefined;
        }
      } catch {
        // a transient failure keeps the last value — the next tick retries
      }
    };
    void poll();
    interval = window.setInterval(poll, INDEX_STATUS_POLL_MS);
    return () => {
      stopped = true;
      if (interval !== undefined) window.clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [runId, generation]);

  return { status, refresh };
}
