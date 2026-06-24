'use client';

import { useEffect, useRef, useState } from 'react';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemForestItem } from '@/components/planning/WorkItemRoadmap';
import type { WorkItemStatus } from '@/components/planning/WorkItemNode';

// Client read of the project's WORK-ITEM forest for the onboarding / roadmap
// canvas (Subtask 7.20.2 / MOTIR-1194) — fetches the done 7.20.4 roadmap endpoint
// (`GET /api/projects/[key]/roadmap`, MOTIR-1010) and FLATTENS its nested forest
// into the canvas's flat parent→child node list. BEST-EFFORT, mirroring
// `useCanvasLayout`: a fresh onboarding project has no work items yet (they appear
// after generation, 7.4), and a failed / absent read just leaves the list empty —
// the canvas then shows only the pre-plan stations and never blocks on this.
//
// The forest's PARENT structure is preserved verbatim (epics keep `parentId:
// null`), so the EPICS are roadmap roots that the canvas shows at the top level
// beside the stations — the produced tree is VISIBLE, not hidden. Stories /
// subtasks keep their parent, so they drill out of their epic / story.

/** The nested shape returned by `GET /api/projects/[key]/roadmap` (RoadmapNodeDto). */
interface RoadmapNode {
  id: string;
  parentId: string | null;
  kind: string;
  identifier: string;
  title: string;
  status: string;
  isDone: boolean;
  children?: RoadmapNode[];
}

const KNOWN_STATUSES: WorkItemStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
];

/** Map a roadmap status string to a canvas status; fall back via `isDone`. */
function toStatus(raw: string, isDone: boolean): WorkItemStatus {
  const s = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if ((KNOWN_STATUSES as string[]).includes(s)) return s as WorkItemStatus;
  return isDone ? 'done' : 'todo';
}

const KNOWN_KINDS = new Set<IssueType>(['epic', 'story', 'task', 'bug', 'subtask']);

/**
 * Flatten the nested roadmap forest into the canvas's flat node list, preserving
 * each node's parent (epics stay `parentId: null` — they are roadmap roots the
 * canvas shows at the top level). Pure (no I/O) so it is unit-testable.
 */
export function flattenRoadmap(nodes: RoadmapNode[]): WorkItemForestItem[] {
  const out: WorkItemForestItem[] = [];
  const walk = (list: RoadmapNode[]) => {
    for (const n of list) {
      const kind: IssueType = KNOWN_KINDS.has(n.kind as IssueType)
        ? (n.kind as IssueType)
        : 'subtask';
      out.push({
        id: n.id,
        parentId: n.parentId,
        identifier: n.identifier,
        title: n.title,
        kind,
        status: toStatus(n.status, n.isDone),
      });
      if (n.children && n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export interface UseProjectRoadmap {
  items: WorkItemForestItem[];
  /** False until the read ATTEMPT completes (success OR failure / skipped). */
  loaded: boolean;
}

/**
 * Read the active project's work-item forest for the canvas. `projectKey` is the
 * project's `PROD`/`MOTIR` key. With no key, no fetch happens (the read is
 * skipped, `loaded` true, `items` empty — a self-host / pre-project state shows
 * stations only).
 */
export function useProjectRoadmap(projectKey: string | undefined): UseProjectRoadmap {
  const [items, setItems] = useState<WorkItemForestItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    // All state writes live inside the async task (never synchronously in the
    // effect body — the `react-hooks/set-state-in-effect` rule). No key → skip the
    // fetch; `items` stays empty and `loaded` flips in `finally`.
    void (async () => {
      try {
        if (projectKey) {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/roadmap`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          if (res.ok && mounted.current) {
            const body = (await res.json()) as { nodes?: RoadmapNode[] };
            if (mounted.current) setItems(flattenRoadmap(body.nodes ?? []));
          }
        }
      } catch {
        /* best-effort: a failed read leaves the canvas showing only the stations */
      } finally {
        if (mounted.current) setLoaded(true);
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [projectKey]);

  return { items, loaded };
}
