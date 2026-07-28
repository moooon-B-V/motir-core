'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Inbox } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import { useSprintPlanJob } from '@/lib/hooks/useSprintPlanJob';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { NewIssueButton } from '../../items/_components/NewIssueButton';
import { BacklogRows, useRankedIssues } from './BacklogList';
import { BacklogDndProvider } from './BacklogDndProvider';
import { BacklogSkeleton } from './BacklogSkeleton';
import { BacklogFilteredEmptyState } from './BacklogFilteredEmptyState';
import { CreateIssueRow } from './CreateIssueRow';
import { CreateSprintStrip } from './CreateSprintStrip';
import { SprintContainer } from './SprintContainer';
import { SprintPlanDock } from './SprintPlanDock';
import { PLAN_SPRINTS_PARAM } from './aiSprintPlanShared';
import { BACKLOG_REGION_ID } from './backlogDnd';
import {
  buildAssigneeNameById,
  buildStatusByKey,
  planningSprints,
  type SprintListResponse,
} from './backlogShared';

// The backlog client container (Story 4.2 · Subtask 4.2.3, read render). A pure
// consumer of the Story-4.1 reads: it fetches the sprint list (`GET /api/sprints`,
// the 4.2.3 read-binding over the shipped `listByProject` leaf) for the
// planning-container headers, and the backlog region binds its own bounded
// `GET /api/backlog` page. Renders the two stacked regions from
// design/backlog/backlog.mock.html — sprint-planning containers (active + future
// planned) over the ranked backlog — plus the Create-sprint affordance.
//
// `workflow` + `members` resolve each row's status `Pill` (key → label/category)
// and assignee avatar (id → name) — the bound `WorkItemSummaryDto` carries only
// the keys, so these maps are built once here and threaded down (mirrors how the
// board page resolves assignee names).
//
// Scope (this subtask): READ render only. No drag (4.2.4); no selection / bulk /
// inline-issue-create / `⋯` actions (4.2.5) — those affordances are PLACED
// (disabled). Create-SPRINT IS wired (a single shipped POST, owned by no other
// subtask in the story — the design's primary affordance in the no-sprints
// state). Lists are bounded + virtualized + lazy-loaded (finding #57).

type SprintsStatus = 'loading' | 'ready' | 'error';

export function BacklogContainer({
  workflow,
  members,
  projectName,
  filterQuery = '',
  filterActive = false,
  aiSprintPlanningEnabled = false,
  aiAvailable = false,
}: {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  /** The active project's name — threaded to the start-sprint dialog's
   *  friendly one-active-sprint message (Subtask 4.4.5). */
  projectName: string;
  /** The serialized active-filter querystring (Subtask 8.8.18) — appended to
   *  every region's `/api/backlog` / `/api/sprints/[id]/issues` fetch so BOTH
   *  regions re-project to the matching set (8.8.17/8.8.20 made the reads
   *  filter-aware). '' when no filter narrows → the byte-for-byte unfiltered
   *  reads. URL-driven: a filter change re-navigates the page, this prop
   *  changes, and each region's `useRankedIssues` endpoint dep refetches (no
   *  `router.refresh()` — the inline-edit-no-refresh contract). Optional (default
   *  '') so the unfiltered render — and existing tests — need not pass it. */
  filterQuery?: string;
  /** Whether a filter is active (Subtask 8.8.18) — selects each region's
   *  FILTERED-empty state ("nothing matches", Clear CTA / dashed placeholder)
   *  over its brand-new-empty state (which offers create). */
  filterActive?: boolean;
  /** The project's `aiSprintPlanningEnabled` (Subtask MOTIR-1750). OFF ⇒ the AI
   *  door renders disabled with the fix hint — never hidden. */
  aiSprintPlanningEnabled?: boolean;
  /** Whether Motir AI is wired at all. NOT wired ⇒ no AI door and no hint. */
  aiAvailable?: boolean;
}) {
  const t = useTranslations('backlog');
  const { toast } = useToast();
  const statusByKey = useMemo(() => buildStatusByKey(workflow.statuses), [workflow.statuses]);
  const assigneeNameById = useMemo(() => buildAssigneeNameById(members), [members]);

  const [sprints, setSprints] = useState<SprintDto[]>([]);
  const [status, setStatus] = useState<SprintsStatus>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  // A refetch signal threaded into every region's `useRankedIssues` (each sprint
  // card + the backlog). `reloadKey` only re-reads the `/api/sprints` metadata
  // (which sprints exist + their counts); it does NOT touch the per-region issue
  // LISTS, which own separate `/api/sprints/[id]/issues` / `/api/backlog` reads.
  // Completing a sprint MOVES the unfinished items into a destination region, so
  // that region's list must re-read too — bumping this is how it gets told (bug 11).
  const [issuesRefreshKey, setIssuesRefreshKey] = useState(0);

  // `status` starts 'loading'; `retry`/`refetch` flip it before bumping
  // `reloadKey`, so the effect never calls setState synchronously (board pattern).
  useEffect(() => {
    let active = true;
    fetch('/api/sprints', { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`sprints ${res.status}`);
        const data = (await res.json()) as SprintListResponse;
        if (!active) return;
        setSprints(data.sprints);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const refetchSprints = useCallback(async () => {
    setReloadKey((k) => k + 1);
  }, []);

  // Sprint completion carries the unfinished items into the backlog or a target
  // sprint, so BOTH the sprint metadata (the completed one drops out of the
  // planning view; the target's count changes) AND every region's issue list
  // (the destination must show the moved rows) have to re-read. `refetchSprints`
  // alone left the destination list stale → the carried items were invisible
  // until a manual reload (bug 11).
  const handleSprintCompleted = useCallback(async () => {
    setIssuesRefreshKey((k) => k + 1);
    await refetchSprints();
  }, [refetchSprints]);

  // Deleting a sprint (Subtask 4.2.5 / MOTIR-1492) is the same two-surface
  // refresh as completion: the sprint metadata re-reads (the deleted sprint drops
  // out of the planning view) AND every region's issue list re-reads (the sprint's
  // items fall back to the backlog via the SetNull FK, so the backlog must show
  // them without a manual reload — the same bug-11 client-island shape).
  const handleSprintDeleted = useCallback(async () => {
    setIssuesRefreshKey((k) => k + 1);
    await refetchSprints();
  }, [refetchSprints]);

  // ── AI SPRINT PLANNING (Subtask MOTIR-1750) ─────────────────────────────────
  // The run lives here because APPROVING writes into exactly this island's two
  // regions. PAGE STATE AFTER THE MUTATION (CLAUDE.md): approve creates sprints
  // AND moves work items out of the backlog, and `router.refresh()` reaches
  // NEITHER — this container is a client island seeding `useState` from its own
  // fetches, so its `useState` initializers never re-run. Both existing signals
  // are bumped instead, the same pair a completed / deleted sprint already uses:
  //   1. `reloadKey` (via `refetchSprints`) — the `/api/sprints` metadata, so the
  //      created sprints APPEAR as ordinary Epic-4 sprint panels.
  //   2. `issuesRefreshKey` — every region's issue list, so the approved items
  //      LEAVE the backlog region and show up inside their new sprints.
  // No third mechanism is introduced, and there is no server-rendered surface on
  // this page that the write changes, so no `router.refresh()` is needed.
  const [focusSprintId, setFocusSprintId] = useState<string | null>(null);
  const handlePlanApproved = useCallback(
    (result: { sprints: Array<{ id: string; name: string }>; assigned: number }) => {
      setIssuesRefreshKey((k) => k + 1);
      setReloadKey((k) => k + 1);
      // Focus lands on the first created sprint, so a keyboard user arrives at
      // the RESULT rather than on the dock that just unmounted.
      setFocusSprintId(result.sprints[0]?.id ?? null);
      toast({
        variant: 'success',
        title: t('aiPlan.doneTitle', { count: result.sprints.length }),
        description: t('aiPlan.doneBody', {
          items: result.assigned,
          names: result.sprints.map((s) => s.name).join(', '),
        }),
      });
    },
    [t, toast],
  );
  const {
    state: planState,
    start: startPlanning,
    cancel: cancelPlanning,
    dismiss: dismissPlanning,
    approve: approvePlan,
  } = useSprintPlanJob({ onApproved: handlePlanApproved });

  const approveCurrentPlan = useCallback(() => {
    const proposal = planState.review?.proposal;
    if (!planState.jobId || !proposal) return;
    // The delta that goes over the wire is the one the review RENDERED, so what
    // persists is exactly what was approved. The server re-validates it anyway.
    void approvePlan(planState.jobId, proposal);
  }, [approvePlan, planState.jobId, planState.review]);

  // The ⌘K door (`/backlog?planSprints=1`) — the SECOND door onto the same one
  // implementation. The param is consumed once and stripped from the URL, so a
  // reload does not silently spend another run; the ref guards React's double
  // effect invocation in dev.
  const router = useRouter();
  const searchParams = useSearchParams();
  const autoStartRef = useRef(false);
  const autoStartRequested = searchParams.get(PLAN_SPRINTS_PARAM) === '1';
  useEffect(() => {
    if (!autoStartRequested || autoStartRef.current) return;
    autoStartRef.current = true;
    const next = new URLSearchParams(searchParams.toString());
    next.delete(PLAN_SPRINTS_PARAM);
    const qs = next.toString();
    router.replace(qs ? `/backlog?${qs}` : '/backlog', { scroll: false });
    if (aiSprintPlanningEnabled) void startPlanning();
  }, [autoStartRequested, aiSprintPlanningEnabled, router, searchParams, startPlanning]);

  // Keep a sprint header's issue-count badge in sync with an optimistic
  // cross-region drag (Subtask 4.2.4) — the badge reads `sprint.issueCount`, so a
  // row dragged into / out of a sprint adjusts it here; a rejected move reverts it.
  const adjustSprintCount = useCallback((sprintId: string, delta: number) => {
    setSprints((prev) =>
      prev.map((s) =>
        s.id === sprintId ? { ...s, issueCount: Math.max(0, s.issueCount + delta) } : s,
      ),
    );
  }, []);

  if (status === 'loading') return <BacklogSkeleton />;
  if (status === 'error') {
    return (
      <ErrorState
        title={t('sprintsErrorTitle')}
        description={t('sprintsErrorDescription')}
        retry={() => {
          setStatus('loading');
          setReloadKey((k) => k + 1);
        }}
      />
    );
  }

  const planning = planningSprints(sprints);
  // The project's active sprint (if any) — the start dialog names it in the
  // friendly one-active-sprint error (Subtask 4.4.5).
  const activeSprint = sprints.find((s) => s.state === 'active') ?? null;
  // The project's PLANNED sprints — the complete dialog's carry-over targets
  // (Subtask 4.4.6: roll the unfinished issues into a future sprint).
  const plannedSprints = sprints.filter((s) => s.state === 'planned');

  return (
    // One DndContext over the whole stack (Subtask 4.2.4) so a row drags between
    // the sprint containers and the backlog on the single global `backlogRank`.
    <BacklogDndProvider
      statusByKey={statusByKey}
      assigneeNameById={assigneeNameById}
      adjustSprintCount={adjustSprintCount}
      sprints={planning}
    >
      <div className="flex flex-col gap-4">
        {planning.map((sprint, index) => (
          <SprintContainer
            key={sprint.id}
            sprint={sprint}
            order={index}
            autoFocus={sprint.id === focusSprintId}
            statusByKey={statusByKey}
            assigneeNameById={assigneeNameById}
            projectName={projectName}
            activeSprint={activeSprint}
            plannedSprints={plannedSprints}
            onStarted={refetchSprints}
            onCompleted={handleSprintCompleted}
            onRenamed={refetchSprints}
            onDeleted={handleSprintDeleted}
            onUpdated={refetchSprints}
            issuesRefreshKey={issuesRefreshKey}
            filterQuery={filterQuery}
            filterActive={filterActive}
          />
        ))}

        {/* The dock REPLACES the strip in place while a run is live, so the user
            stays on the backlog — the surface the result lands in. */}
        {planState.phase === 'idle' ? (
          <CreateSprintStrip
            onCreated={refetchSprints}
            aiEnabled={aiSprintPlanningEnabled}
            aiAvailable={aiAvailable}
            onPlanSprints={() => void startPlanning()}
            planning={false}
          />
        ) : (
          <SprintPlanDock
            state={planState}
            statusByKey={statusByKey}
            assigneeNameById={assigneeNameById}
            onCancel={cancelPlanning}
            onDismiss={dismissPlanning}
            onApprove={approveCurrentPlan}
            onRetry={() => void startPlanning()}
          />
        )}

        {/* The backlog sits BELOW every sprint container → the highest stack order
            (shift-range selection reads regions top-to-bottom). */}
        <BacklogRegion
          statusByKey={statusByKey}
          assigneeNameById={assigneeNameById}
          regionOrder={planning.length}
          issuesRefreshKey={issuesRefreshKey}
          filterQuery={filterQuery}
          filterActive={filterActive}
        />
      </div>
    </BacklogDndProvider>
  );
}

// The bottom region — the ranked unassigned backlog (`sprint_id IS NULL`). Owns
// its own bounded `getBacklog` read; the count header is the aggregate total
// (NOT a loaded-row tally — finding #57).
function BacklogRegion({
  statusByKey,
  assigneeNameById,
  regionOrder,
  issuesRefreshKey,
  filterQuery,
  filterActive,
}: {
  statusByKey: ReturnType<typeof buildStatusByKey>;
  assigneeNameById: Map<string, string>;
  regionOrder: number;
  /** Bumped when a sprint completes with carry-over to the backlog (bug 11). */
  issuesRefreshKey: number;
  /** Active-filter querystring appended to the `/api/backlog` fetch (8.8.18). */
  filterQuery: string;
  filterActive: boolean;
}) {
  const t = useTranslations('backlog');
  const [collapsed, setCollapsed] = useState(false);
  // The filter rides the fetch query so the read returns only matching rows +
  // the FILTERED total (8.8.17). A change re-navigates the page → new
  // `filterQuery` prop → new endpoint → `useRankedIssues` refetches (no
  // router.refresh). The hook's lazy-load already appends `&cursor=` after a `?`.
  const endpoint = filterQuery ? `/api/backlog?${filterQuery}` : '/api/backlog';
  const state = useRankedIssues(endpoint, issuesRefreshKey);

  return (
    <section
      aria-label={t('backlogRegionLabel', { count: state.totalCount })}
      // `data-tilt` floats this backlog/sprint panel under the 3D / Immersive
      // style (size-gated: deep resting shadow, no cursor tilt).
      data-tilt=""
      // surface-material hook (glass frost / aurora glow); inert under
      // non-material styles. 7.3.38.
      data-surface="card"
      className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-subtle)"
    >
      <div className="flex items-center gap-2 border-b border-(--el-border) px-(--spacing-card-padding) py-(--spacing-control-y)">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandBacklog') : t('collapseBacklog')}
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface-soft)"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        <span className="font-semibold text-(--el-text-strong)">{t('backlogTitle')}</span>
        <span
          className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)"
          data-testid="backlog-count"
        >
          {t('issueCount', { count: state.totalCount })}
        </span>
        <span className="flex-1" />
      </div>

      {collapsed ? null : (
        <div className="p-(--spacing-control-x)">
          <BacklogRows
            state={state}
            statusByKey={statusByKey}
            assigneeNameById={assigneeNameById}
            ariaLabel={t('backlogListLabel')}
            regionId={BACKLOG_REGION_ID}
            regionKind="backlog"
            regionLabel={t('backlogTitle')}
            regionOrder={regionOrder}
            createRow={<CreateIssueRow sprintId={null} />}
            emptyState={
              filterActive ? (
                // Filter active + no match → the distinct filtered-empty state
                // (search-x + Clear filter), NOT the brand-new-backlog create
                // prompt (the backlog isn't empty, the filter is over-narrow).
                <BacklogFilteredEmptyState />
              ) : (
                <EmptyState
                  icon={<Inbox className="h-12 w-12" aria-hidden />}
                  title={t('emptyTitle')}
                  description={t('emptyDescription')}
                  action={<NewIssueButton />}
                />
              )
            }
          />
        </div>
      )}
    </section>
  );
}

// (The create-sprint affordance moved into `CreateSprintStrip` — MOTIR-1750 made
// it the left half of the two-action strip that also hosts the AI door.)
