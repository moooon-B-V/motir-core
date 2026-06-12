'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { ReportWidgetResultDto } from '@/lib/dto/reports';

// The per-widget data fetch (Subtask 6.3.5). Each renderer owns its own read
// from the 6.3.2 report endpoints; per-widget isolation means one widget's
// loading / error / no-access / stale state never touches its siblings. The
// 6.3.2 reads return the `ReportWidgetResultDto` envelope — `ok` / `no_access`
// / `stale` are DATA, not transport errors; only a thrown fetch (network /
// 422 / 500) becomes the `error` phase with a Retry.
//
// State is only ever set inside the async callbacks / a user-triggered reload —
// never synchronously in the effect body (the ReportBurndownSection precedent;
// React 19 / react-hooks forbid set-state-in-effect). The previous result stays
// on screen while a config/page change refetches.

/** The data source as a query fragment ( `projectId` XOR `savedFilterId` ). A
 * stale source has no live referent — the caller short-circuits to the stale
 * state before fetching. */
export function sourceParams(source: DashboardWidgetSourceDto): URLSearchParams | null {
  const params = new URLSearchParams();
  if (source.kind === 'saved_filter') params.set('savedFilterId', source.savedFilterId);
  else if (source.kind === 'project') params.set('projectId', source.projectId);
  else return null;
  return params;
}

export type WidgetDataPhase<T> =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; result: ReportWidgetResultDto<T> };

/**
 * Fetch a widget's data from `endpoint?<params>`, re-running whenever the
 * memoized `search` string changes (config / page edits). Returns the phase
 * plus a `reload` for the error-state Retry (which resets to loading first).
 */
export function useWidgetData<T>(
  endpoint: string,
  search: string | null,
): {
  state: WidgetDataPhase<T>;
  reload: () => void;
} {
  const [state, setState] = useState<WidgetDataPhase<T>>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setState({ phase: 'loading' });
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (search === null) return;
    let cancelled = false;
    void fetch(`${endpoint}?${search}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`widget read ${res.status}`);
        return (await res.json()) as ReportWidgetResultDto<T>;
      })
      .then((result) => {
        if (!cancelled) setState({ phase: 'ready', result });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, search, nonce]);

  return { state, reload };
}
