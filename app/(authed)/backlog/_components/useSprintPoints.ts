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
export function useSprintPoints(sprintId: string, enabled = true): SprintPointsDto | null {
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
  }, [sprintId, enabled]);

  return points;
}
