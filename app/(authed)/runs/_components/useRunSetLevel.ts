'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import {
  fetchRoadmapLevel,
  type RoadmapLevelData,
  type RoadmapLevelItem,
} from '@/lib/planning/roadmapClient';

// ONE READ OF THE RUN'S MEMBERS, SHARED BY THE CANVAS AND THE LIST (MOTIR-9074).
//
// Both views show the same set, so they must not each pay for the same `?ids=`
// read. The promise is memoised per (member set, `reloadKey`): a bump of
// `reloadKey` (the run's dispositions moved) is the only thing that refetches, and
// switching List <-> Canvas never does.

export interface RunSetLevel {
  /** The shared read — the canvas's `loadLevel` awaits this. */
  read: () => Promise<RoadmapLevelData>;
  /** The resolved members by work-item id; empty until the read lands. */
  byId: Map<string, RoadmapLevelItem>;
}

export function useRunSetLevel(
  cards: DispatchRunDto['cards'],
  projectKey: string,
  reloadKey: number,
): RunSetLevel {
  const memberIds = useMemo(
    () => cards.map((c) => c.workItemId).filter((id): id is string => id !== null),
    [cards],
  );
  const memberKey = memberIds.join(',');

  const cache = useRef<{ key: string; promise: Promise<RoadmapLevelData> } | null>(null);
  const read = useCallback((): Promise<RoadmapLevelData> => {
    const key = `${projectKey}|${memberKey}|${reloadKey}`;
    if (cache.current?.key !== key) {
      cache.current = {
        key,
        promise: fetchRoadmapLevel(projectKey, null, 'project', undefined, false, memberIds),
      };
    }
    return cache.current.promise;
    // `memberKey` is `memberIds`' identity by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, memberKey, reloadKey]);

  const [byId, setById] = useState<Map<string, RoadmapLevelItem>>(() => new Map());
  useEffect(() => {
    if (memberIds.length === 0) return;
    let live = true;
    read()
      .then((data) => {
        if (live) setById(new Map(data.items.map((i) => [i.id, i])));
      })
      .catch(() => {
        // The list degrades to keys + labels; the canvas surfaces its own error.
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  return { read, byId };
}
