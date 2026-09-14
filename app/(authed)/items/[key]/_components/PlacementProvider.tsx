'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { WorkItemPlacementDto } from '@/lib/dto/workItems';
import { getWorkItemPlacementAction } from '../edit/actions';

// THE ITEM PAGE'S PLACEMENT CHANNEL (Story MOTIR-5309 · MOTIR-5381).
//
// ⚠️ WHAT THIS EXISTS FOR: where a work item SITS is drawn in two islands that
// cannot see each other — the eyebrow's breadcrumb (server-rendered from the
// detail read) and the rail's Parent and Folder fields. The rail's inline edits
// deliberately do not `router.refresh()` (the page-state contract's inline-edit
// rule), so without a channel a parent change leaves the breadcrumb naming the
// old parent until a reload, and filing into a folder would add a second writer
// to the same stale surface.
//
// ⚠️ THE ANSWER IS THE SERVER'S, NEVER A GUESS IN THE BROWSER. A writer calls
// `reportPlacementChange(id)` AFTER its write succeeded; the channel asks
// `getWorkItemPlacementAction` where the item now sits — the SAME mapper
// `getIssueDetail` seeds this provider with — and applies that. Filing clears a
// parent, a parent clears a folder, and an item under a filed epic inherits its
// folder: none of those rules is re-implemented here, so none of them can drift.
//
// ⚠️ REPORTS ARE SEQUENCE-GUARDED. Two moves in a row resolve in any order; only
// the answer to the LATEST report applies, so an earlier, slower answer can
// never repaint over a later one. A refused or failed read keeps the last value
// and throws nothing — the rail already told the person the write's outcome.
//
// ⚠️ AND A SERVER RENDER WINS, as a derivation rather than a race: an answer is
// stored with the server placement it was applied OVER, and it stands only while
// the server still reads that placement (the `OptimisticStatusProvider` shape).

interface PlacementOverride {
  readonly placement: WorkItemPlacementDto;
  /** The server placement this answer was applied over, as a comparison key. */
  readonly baseline: string;
}

interface PlacementContextValue {
  /** Where the item sits: the latest answer while it stands, else the server's. */
  readonly placement: WorkItemPlacementDto;
  /** Ask the server where `workItemId` now sits, after a write moved it. */
  reportPlacementChange: (workItemId: string) => void;
}

const PlacementContext = createContext<PlacementContextValue | null>(null);

/** A stable comparison key for a placement — ids and the path, never titles. */
function placementKey(p: WorkItemPlacementDto): string {
  return JSON.stringify([
    p.folderId,
    p.parent?.id ?? null,
    p.ancestors.map((a) => a.id),
    p.placementFolder
      ? [p.placementFolder.folderId, p.placementFolder.path, p.placementFolder.via?.id ?? null]
      : null,
  ]);
}

/** The placement to DRAW — `null` outside a provider (the quick view, unit call sites). */
export function usePlacement(): WorkItemPlacementDto | null {
  return useContext(PlacementContext)?.placement ?? null;
}

const NO_REPORT = () => {};

/**
 * The WRITE half. A no-op outside a provider, so `CoreFieldsPanel`'s unit call
 * sites and any surface without a breadcrumb report into nothing.
 */
export function usePlacementReporter(): (workItemId: string) => void {
  return useContext(PlacementContext)?.reportPlacementChange ?? NO_REPORT;
}

export function PlacementProvider({
  serverPlacement,
  children,
}: {
  /** The item's placement as the CURRENT server render reads it. */
  serverPlacement: WorkItemPlacementDto;
  children: ReactNode;
}) {
  const serverKey = placementKey(serverPlacement);
  const [override, setOverride] = useState<PlacementOverride | null>(null);

  // The reconcile, as a derivation, and the latch that makes it permanent — a
  // render-phase `setState` guarded by the condition, React's own *adjusting
  // state when a prop changes* pattern (see `OptimisticStatusProvider`).
  const superseded = override !== null && override.baseline !== serverKey;
  if (superseded) setOverride(null);

  const placement = override !== null && !superseded ? override.placement : serverPlacement;

  const latestReport = useRef(0);
  const reportPlacementChange = useCallback(
    (workItemId: string) => {
      const report = ++latestReport.current;
      void getWorkItemPlacementAction(workItemId).then(
        (res) => {
          if (report !== latestReport.current || !res.ok) return;
          setOverride({ placement: res.placement, baseline: serverKey });
        },
        () => {
          // A failed read keeps the last value; the write's own outcome was already shown.
        },
      );
    },
    [serverKey],
  );

  return (
    <PlacementContext.Provider value={{ placement, reportPlacementChange }}>
      {children}
    </PlacementContext.Provider>
  );
}
