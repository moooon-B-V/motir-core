'use client';

import { useCallback, useRef, useState } from 'react';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';

// The shared work-item QUICK-VIEW wiring for a `ProjectRoadmapCanvas` consumer
// (Subtask 7.20.11 / MOTIR-1352). Any canvas that renders work-item nodes — the
// persistent roadmap (`WorkItemRoadmap`) AND the onboarding hub (`OnboardingCanvas`,
// once drilled into the produced tree) — gets the SAME peek from this one hook, so
// the View → quick-view behaviour is identical everywhere and lives in no single
// consumer.
//
// It owns the peek's local state (route-agnostic — no `?peek=` URL coupling) and a
// node id → identifier lookup accumulated from the levels the consumer loads (the
// canvas hands the View handler a node id; the peek read keys off the identifier).
//
// Usage: call `registerItems(wi)` in the consumer's `loadLevel` after each level's
// items are fetched; pass `onView` to `ProjectRoadmapCanvas`; render `quickView`
// beside it.
export function useWorkItemQuickView() {
  // node id → its identifier (`MOTIR-12`), accumulated as levels load.
  const identifierByIdRef = useRef(new Map<string, string>());
  // The work item currently peeked (its identifier), or null when the peek is closed.
  const [peekKey, setPeekKey] = useState<string | null>(null);

  // Record a loaded level's id → identifier pairs so the View handler can resolve
  // the peek key from the node id the canvas reports.
  const registerItems = useCallback((wi: RoadmapLevelData) => {
    for (const item of wi.items) identifierByIdRef.current.set(item.id, item.identifier);
  }, []);

  // Open the quick-view peek for a node's work item (the canvas "View" button). A
  // node with no mapped identifier (only real work items are `viewable`, so this is
  // defensive — stations / ghost anchors never reach here) opens nothing.
  const onView = useCallback((id: string) => {
    const identifier = identifierByIdRef.current.get(id);
    if (identifier) setPeekKey(identifier);
  }, []);

  const quickView = <WorkItemQuickView peekKey={peekKey} onClose={() => setPeekKey(null)} />;

  return { registerItems, onView, quickView };
}
