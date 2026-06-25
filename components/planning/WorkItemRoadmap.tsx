'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';

// The WORK-ITEM consumer of the reusable `ProjectRoadmapCanvas` (Subtask 7.20.2 /
// MOTIR-1194) — the adapter the persistent roadmap (MOTIR-1011) + the planning
// workspace (MOTIR-1193) mount. It reads the project roadmap ONE LEVEL AT A TIME
// from the per-level endpoint (MOTIR-1010) and renders each node as a
// `WorkItemNode`: the roots, then a node's children on drill, with the level's
// `blocked_by` edges drawn. The onboarding canvas is the OTHER consumer of the same
// foundation (stations + roots at the top level).
//
// It also OWNS the work-item quick-view peek (Subtask 7.20.11 / MOTIR-1352): the
// canvas surfaces a "View" button on the selected card, and this consumer opens the
// shipped peek (`WorkItemQuickView`) for that node — driven by LOCAL state, so the
// reusable canvas stays route-agnostic (no `?peek=` URL coupling).

const ROOT_KEY = '__root__';

export interface WorkItemRoadmapProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  onResetPositions?: (nodeIds: string[]) => void;
  /** A LEAF work item (no children) was activated. */
  onSelect?: (id: string) => void;
  ariaLabel?: string;
}

export function WorkItemRoadmap({
  projectKey,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  ariaLabel = 'Work-item roadmap',
}: WorkItemRoadmapProps) {
  // Levels cached so re-drilling a node doesn't re-hit the API. Keyed by
  // project+parent (a ref — mutable — so a new key just misses; no reset needed).
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  // node id → its identifier (`MOTIR-12`), accumulated as levels load — the canvas
  // hands the View handler a node id; the peek read keys off the identifier.
  const identifierByIdRef = useRef(new Map<string, string>());
  // The work-item currently peeked (its identifier), or null when the peek is closed.
  const [peekKey, setPeekKey] = useState<string | null>(null);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const key = `${projectKey}:${parentId ?? ROOT_KEY}`;
      let wi = cacheRef.current.get(key);
      if (!wi) {
        wi = await fetchRoadmapLevel(projectKey, parentId);
        cacheRef.current.set(key, wi);
      }
      for (const item of wi.items) identifierByIdRef.current.set(item.id, item.identifier);
      return buildWorkItemLevel(wi);
    },
    [projectKey],
  );

  // Open the quick-view peek for a node's work item (the canvas "View" button).
  // A node with no mapped identifier (only the real items are `viewable`, so this
  // is defensive) opens nothing.
  const handleView = useCallback((id: string) => {
    const identifier = identifierByIdRef.current.get(id);
    if (identifier) setPeekKey(identifier);
  }, []);

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        positions={positions}
        onNodeMove={onNodeMove}
        onResetPositions={onResetPositions}
        onSelect={onSelect}
        onView={handleView}
        searchable
        rootLabel="Roadmap"
        ariaLabel={ariaLabel}
      />
      <WorkItemQuickView peekKey={peekKey} onClose={() => setPeekKey(null)} />
    </>
  );
}
