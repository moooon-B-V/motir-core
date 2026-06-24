'use client';

import { useMemo } from 'react';
import { ProjectRoadmapCanvas } from '@/components/planning/ProjectRoadmapCanvas';
import { WorkItemNode, type WorkItemNodeData } from '@/components/planning/WorkItemNode';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// The WORK-ITEM consumer of the reusable `ProjectRoadmapCanvas` (Subtask 7.20.2 /
// MOTIR-1194) — maps a work-item forest (epic → story → subtask) + its
// `blocked_by` edges into the foundation's content-agnostic node model, rendering
// each node as a `WorkItemNode`. This is the adapter the persistent roadmap
// (MOTIR-1011) and the planning workspace (MOTIR-1193) mount; the onboarding
// canvas is the OTHER consumer of the same foundation (stations as nodes). It owns
// no fetching — the forest + edges + saved positions arrive as DATA.

export interface WorkItemForestItem extends WorkItemNodeData {
  /** The parent work item's id, or null for a roadmap root (an epic). */
  parentId: string | null;
}

export interface WorkItemBlockedBy {
  /** The item that cannot start until `blockerId` is done. */
  blockedId: string;
  blockerId: string;
}

export interface WorkItemRoadmapProps {
  items: WorkItemForestItem[];
  dependencies?: WorkItemBlockedBy[];
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  onSelect?: (id: string) => void;
  initialFocusId?: string | null;
  ariaLabel?: string;
}

export function WorkItemRoadmap({
  items,
  dependencies = [],
  positions,
  onNodeMove,
  onSelect,
  initialFocusId = null,
  ariaLabel = 'Work-item roadmap',
}: WorkItemRoadmapProps) {
  const nodes: ProjectCanvasNode[] = useMemo(() => {
    const hasChild = new Set(items.filter((i) => i.parentId).map((i) => i.parentId!));
    return items.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      searchText: `${item.identifier} ${item.title}`,
      crumbLabel: item.identifier,
      content: <WorkItemNode item={item} drillable={hasChild.has(item.id)} />,
    }));
  }, [items]);

  // The blocker is settled (`firm`) once it is done; else the dependency is
  // `pending`. A cross-parent edge is reclassified `cross` by the foundation.
  const deps: ProjectCanvasDep[] = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return dependencies.map((d) => ({
      from: d.blockerId,
      to: d.blockedId,
      variant: byId.get(d.blockerId)?.status === 'done' ? ('firm' as const) : ('pending' as const),
    }));
  }, [items, dependencies]);

  return (
    <ProjectRoadmapCanvas
      nodes={nodes}
      deps={deps}
      positions={positions}
      onNodeMove={onNodeMove}
      onSelect={onSelect}
      searchable
      initialFocusId={initialFocusId}
      ariaLabel={ariaLabel}
    />
  );
}
