'use client';

import { useCallback, useRef } from 'react';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemNode } from '@/components/planning/WorkItemNode';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// The WORK-ITEM consumer of the reusable `ProjectRoadmapCanvas` (Subtask 7.20.2 /
// MOTIR-1194) — the adapter the persistent roadmap (MOTIR-1011) + the planning
// workspace (MOTIR-1193) mount. It reads the project roadmap ONE LEVEL AT A TIME
// from the per-level endpoint (MOTIR-1010) and renders each node as a
// `WorkItemNode`: the roots, then a node's children on drill, with the level's
// `blocked_by` edges drawn. The onboarding canvas is the OTHER consumer of the same
// foundation (stations + roots at the top level).

const ROOT_KEY = '__root__';

export interface WorkItemRoadmapProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  /** A LEAF work item (no children) was activated. */
  onSelect?: (id: string) => void;
  ariaLabel?: string;
}

export function WorkItemRoadmap({
  projectKey,
  positions,
  onNodeMove,
  onSelect,
  ariaLabel = 'Work-item roadmap',
}: WorkItemRoadmapProps) {
  // Levels cached so re-drilling a node doesn't re-hit the API. Keyed by
  // project+parent (a ref — mutable — so a new key just misses; no reset needed).
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const key = `${projectKey}:${parentId ?? ROOT_KEY}`;
      let wi = cacheRef.current.get(key);
      if (!wi) {
        wi = await fetchRoadmapLevel(projectKey, parentId);
        cacheRef.current.set(key, wi);
      }
      const statusById = new Map(wi.items.map((i) => [i.id, i.status]));
      const deps: ProjectCanvasDep[] = wi.edges.map((e) => ({
        from: e.blockerId,
        to: e.blockedId,
        variant: statusById.get(e.blockerId) === 'done' ? 'firm' : 'pending',
      }));
      const nodes: ProjectCanvasNode[] = wi.items.map((item) => ({
        id: item.id,
        parentId: item.parentId,
        searchText: `${item.identifier} ${item.title}`,
        crumbLabel: item.identifier,
        drillable: item.hasChildren,
        content: (
          <WorkItemNode
            item={{
              id: item.id,
              identifier: item.identifier,
              title: item.title,
              kind: item.kind,
              status: item.status,
            }}
            drillable={item.hasChildren}
          />
        ),
      }));
      return { nodes, deps };
    },
    [projectKey],
  );

  return (
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      positions={positions}
      onNodeMove={onNodeMove}
      onSelect={onSelect}
      searchable
      rootLabel="Roadmap"
      ariaLabel={ariaLabel}
    />
  );
}
