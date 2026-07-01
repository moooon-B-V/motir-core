'use client';

import { useEffect, useState } from 'react';
import type { SprintPointsDto } from '@/lib/dto/estimation';

// Live pre-start points roll-up for a sprint (Story 4.4 · Subtask 4.4.9 —
// finding #69). One bounded read of `GET /api/sprints/[id]/points` (the shipped
// `estimationService.rollupForSprint` aggregate), shared by the two display
// consumers the seam was reserved for: the backlog `SprintContainer`
// committed-points slot and the `StartSprintDialog` committed summary. Mirrors
// the plain-fetch pattern `useRankedIssues` uses (no SWR in this codebase).
//
// `enabled` gates the fetch (e.g. only fetch while the start dialog is open).
// Returns `null` until the first successful read; the UI renders "—" for a null
// or wholly-unestimated roll-up (`committed === 0`), never `NaN` — the 4.5.2
// "DTO stays total, UI owns the dash" pattern.
//
// `refreshKey` is a monotonic TICK the caller bumps whenever the sprint's
// committed points could have changed — an item moved in/out, an inline create,
// or an in-sprint point edit. The roll-up is computed ON-READ server-side (no
// stored counter), so a stale badge only clears on a re-fetch; watching the tick
// in the effect deps is that re-fetch (the CLAUDE.md client-island page-state
// contract — this hook is a client island, so `router.refresh()` can't reach it;
// it needs an explicit refetch trigger, MOTIR-1495).
export function useSprintPoints(
  sprintId: string,
  enabled = true,
  refreshKey = 0,
): SprintPointsDto | null {
  const [points, setPoints] = useState<SprintPointsDto | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetch(`/api/sprints/${sprintId}/points`, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? (res.json() as Promise<SprintPointsDto>) : null))
      .then((data) => {
        if (!cancelled && data) setPoints(data);
      })
      .catch(() => {
        // A failed points read is non-fatal — the summary falls back to "—".
      });
    return () => {
      cancelled = true;
    };
  }, [sprintId, enabled, refreshKey]);

  return points;
}
