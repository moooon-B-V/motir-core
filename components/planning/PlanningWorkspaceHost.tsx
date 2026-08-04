'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Map, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { PlanChangeCanvas } from '@/components/planning/PlanChangeCanvas';
import { PlanningCanvasSkeleton } from '@/components/planning/PlanningWorkspaceSkeleton';
import { PlanChangeConfirmBar } from '@/components/planning/PlanChangeConfirmBar';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { usePlanChangeConversation } from '@/lib/hooks/usePlanChangeConversation';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import {
  addPlanningTarget,
  removePlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// The client island of the established-project planning HOST (Subtask
// MOTIR-1729; design `plan-change-conversation.mock.html` panel 2). It COMPOSES
// the shipped pieces — `PlanningWorkspace` (the two-pane frame),
// `WorkItemRoadmap` → `ProjectRoadmapCanvas` (the canvas, seeded with the
// project's EXISTING tree) — and adds only what the host owns: the exit chrome
// and the mode/context wiring. It rebuilds none of them.
//
// The exit chrome is the shell's own (it has no app nav to leave through): a
// Close control naming the origin plus `Esc`, both returning to the surface the
// launcher was invoked from (`planningLaunchBackHref`). The design's overlay
// keeps the origin screen mounted behind it; this host is a ROUTE (the card's
// deliverable — `planningWorkspaceHref` stays the single entry href), so
// "returns you to where you launched from" is a navigation back to that route.
//
// The chat pane is `PlanChangeRail` — the multi-turn plan-change CONVERSATION
// (Subtask MOTIR-1730). The host owns the conversation STATE
// (`usePlanChangeConversation`) rather than the rail, because the proposal is
// reviewed on the CANVAS: the same delta drives the rail's summary, the canvas's
// in-place diff, and the confirm-to-persist bar between them.
//
// PAGE STATE AFTER A MUTATION (`motir-core/CLAUDE.md`): an approve commits work
// items, which changes two kinds of surface. The canvas is a CLIENT ISLAND that
// seeds its level once — `router.refresh()` cannot reach it — so it gets an
// explicit refetch trigger (`treeVersion`, folded into the canvas's diff key);
// the server-rendered surfaces behind this overlay (counts, headers, the backlog
// underneath) take the `router.refresh()`. Both, because both apply.
//
// OPENS BEFORE ITS DATA (Bug MOTIR-2069): the frame — back bar, project name,
// the two-pane split, the whole conversation rail — waits on NOTHING. The host
// used to take a `hasItems` boolean the page computed from a server root read,
// and awaiting that read is what held the entire workspace shut: nothing painted
// until the level had been fetched, so the surface loaded first and opened
// second. That prop is gone. The canvas reads its own root level anyway (the
// same level, over `fetchRoadmapLevel`), so it owns the loading and empty states
// itself — one read instead of two, and none of them between the click and the
// paint. `app/(planning)/loading.tsx` covers the navigation ahead of this.

export interface PlanningWorkspaceHostProps {
  /** The project's `MOTIR`-style key — the canvas's per-level read source. */
  projectKey: string;
  projectName: string;
  /** The launcher's context, parsed off the query by the page. */
  launch: PlanningLaunch;
  /**
   * The ANCHOR work item's database id, when the workspace was summoned from a
   * work item (MOTIR-910's Plan / Re-plan entrance) and that item resolved. The
   * page resolves `launch.itemKey` → id server-side, so no client component
   * touches the service layer; the conversation then rides the item-scoped
   * MOTIR-909 endpoints instead of the project-wide thread. `null` for every
   * project / roadmap launch — and for an item key that no longer resolves,
   * which degrades to the project conversation rather than a dead workspace.
   */
  anchorId?: string | null;
  /** Where Close / `Esc` return to. */
  backHref: string;
  /** The work item the Plan / Re-plan entrance opened on, resolved server-side
   *  (MOTIR-1491): it is the PRE-FILLED initial target. Null for a project-scoped
   *  launch — or when the `?item=` key no longer resolves. */
  initialTarget?: PlanningTarget | null;
}

export function PlanningWorkspaceHost({
  projectKey,
  projectName,
  launch,
  anchorId = null,
  backHref,
  initialTarget = null,
}: PlanningWorkspaceHostProps) {
  const t = useTranslations('planningWorkspace');
  const router = useRouter();

  // The turn's TARGET SET (MOTIR-1491). It lives HERE, not in the rail, because
  // both panes read it: the composer collects it and the canvas rings it. The
  // entrance's item seeds it as the INITIAL target — not a locked one, so the
  // user can remove it (⨉) or add more (design panel 5).
  const [targets, setTargets] = useState<PlanningTarget[]>(initialTarget ? [initialTarget] : []);
  const addTarget = useCallback(
    (target: PlanningTarget) => setTargets((current) => addPlanningTarget(current, target)),
    [],
  );
  const removeTarget = useCallback(
    (identifier: string) => setTargets((current) => removePlanningTarget(current, identifier)),
    [],
  );

  // Bumped on every approve: the committed tree is new data, so the canvas island
  // must refetch its level (the server-rendered surfaces take the refresh below).
  const [treeVersion, setTreeVersion] = useState(0);
  const onApproved = useCallback(() => {
    setTreeVersion((v) => v + 1);
    router.refresh();
  }, [router]);
  const { state, send, retry, approve, discard } = usePlanChangeConversation({
    onApproved,
    anchorId,
  });

  // The rail sends TEXT; the anchors come from the set this host owns, so the
  // rail never has to know how a turn is scoped.
  const sendTargeted = useCallback((text: string) => void send(text, targets), [send, targets]);
  const targetIds = targets.map((target) => target.id);

  const index = useMemo(() => indexPlanReview(state.review), [state.review]);
  // One key for "what the canvas is drawing": a new proposal, or a fresh commit.
  const diffKey = `${treeVersion}:${state.jobId ?? 'none'}:${index.counts.added}-${index.counts.changed}-${index.counts.removed}`;

  const close = useCallback(() => router.push(backHref), [router, backHref]);

  // `Esc` closes the workspace (design sheet 6). It must not steal the key from
  // the surfaces that own it FIRST: the canvas's full-screen mode exits on Esc,
  // and a dialog/menu closes on Esc — so skip when something already handled it,
  // when the canvas is full-screen, and when focus sits in a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (typeof document !== 'undefined' && document.fullscreenElement) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const backLabel =
    launch.from === 'work-item' && launch.itemKey
      ? t('backToItem', { item: launch.itemKey })
      : launch.from === 'convention-refine'
        ? t('backToCodeHealth')
        : t('backToRoadmap');

  return (
    <PlanningWorkspace
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          {/* The shell's own exit chrome + project crumb. The canvas keeps its
              own top-left breadcrumb and top-right search/zoom overlays, so this
              sits ABOVE the canvas rather than over them. */}
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {backLabel}
              <kbd className="ml-1 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-muted)">
                {t('escKey')}
              </kbd>
            </Link>
            <span className="truncate text-sm font-semibold text-(--el-text)">{projectName}</span>
          </div>

          {/* The canvas mounts UNCONDITIONALLY (MOTIR-2069). It reads its own
              root level, so it — not the page — knows whether there is anything
              to draw; it shows the workspace's skeleton while that read is in
              flight and the workspace's own empty statement when it comes back
              empty. Both fill the same flex-sized box as the drawn level, so
              filling it shifts nothing. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <PlanChangeCanvas
              projectKey={projectKey}
              index={index}
              diffKey={diffKey}
              targetIds={targetIds}
              ariaLabel={t('canvasAria', { project: projectName })}
              loadingFallback={<PlanningCanvasSkeleton />}
              emptyRoot={
                <EmptyState
                  icon={<Map className="h-12 w-12" aria-hidden />}
                  title={t('emptyCanvasTitle')}
                  description={t('emptyCanvasDescription')}
                />
              }
            />
          </div>

          {/* The gate — visible only while a proposal is pending on the canvas. */}
          {state.review && !index.isEmpty ? (
            <PlanChangeConfirmBar
              index={index}
              deciding={state.phase === 'deciding'}
              onApprove={approve}
              onDiscard={discard}
            />
          ) : null}
        </div>
      }
      chat={
        <PlanChangeRail
          launch={launch}
          projectName={projectName}
          state={state}
          index={index}
          targets={targets}
          onAddTarget={addTarget}
          onRemoveTarget={removeTarget}
          onSend={sendTargeted}
          onRetry={retry}
          onApprove={approve}
          onDiscard={discard}
        />
      }
    />
  );
}
