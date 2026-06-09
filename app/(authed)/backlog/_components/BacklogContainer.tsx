'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Inbox, Plus } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { NewIssueButton } from '../../issues/_components/NewIssueButton';
import { BacklogRows, useRankedIssues } from './BacklogList';
import { BacklogSkeleton } from './BacklogSkeleton';
import { CreateIssueRow } from './CreateIssueRow';
import { SprintContainer } from './SprintContainer';
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
}: {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}) {
  const t = useTranslations('backlog');
  const statusByKey = useMemo(() => buildStatusByKey(workflow.statuses), [workflow.statuses]);
  const assigneeNameById = useMemo(() => buildAssigneeNameById(members), [members]);

  const [sprints, setSprints] = useState<SprintDto[]>([]);
  const [status, setStatus] = useState<SprintsStatus>('loading');
  const [reloadKey, setReloadKey] = useState(0);

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

  return (
    <div className="flex flex-col gap-4">
      {planning.map((sprint) => (
        <SprintContainer
          key={sprint.id}
          sprint={sprint}
          statusByKey={statusByKey}
          assigneeNameById={assigneeNameById}
        />
      ))}

      <CreateSprintButton onCreated={refetchSprints} />

      <BacklogRegion statusByKey={statusByKey} assigneeNameById={assigneeNameById} />
    </div>
  );
}

// The bottom region — the ranked unassigned backlog (`sprint_id IS NULL`). Owns
// its own bounded `getBacklog` read; the count header is the aggregate total
// (NOT a loaded-row tally — finding #57).
function BacklogRegion({
  statusByKey,
  assigneeNameById,
}: {
  statusByKey: ReturnType<typeof buildStatusByKey>;
  assigneeNameById: Map<string, string>;
}) {
  const t = useTranslations('backlog');
  const [collapsed, setCollapsed] = useState(false);
  const state = useRankedIssues('/api/backlog');

  return (
    <section
      aria-label={t('backlogRegionLabel', { count: state.totalCount })}
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
            createRow={<CreateIssueRow />}
            emptyState={
              <EmptyState
                icon={<Inbox className="h-12 w-12" aria-hidden />}
                title={t('emptyTitle')}
                description={t('emptyDescription')}
                action={<NewIssueButton />}
              />
            }
          />
        </div>
      )}
    </section>
  );
}

// Create-sprint — adds an empty PLANNED sprint via the shipped POST /api/sprints
// (4.1.3 `createSprint`), then refetches the sprint list. The design's primary
// affordance in the no-sprints state; owned by no other Story-4.2 subtask, so it
// is wired here.
function CreateSprintButton({ onCreated }: { onCreated: () => Promise<void> }) {
  const t = useTranslations('backlog');
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sprints', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`create sprint ${res.status}`);
      await onCreated();
    } catch {
      toast({
        variant: 'error',
        title: t('createSprintErrorTitle'),
        description: t('createSprintErrorDescription'),
      });
    } finally {
      setBusy(false);
    }
  }, [onCreated, t, toast]);

  return (
    <button
      type="button"
      onClick={create}
      disabled={busy}
      data-testid="create-sprint"
      className="flex w-full items-center justify-center gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) px-(--spacing-control-x) py-3 text-sm font-medium text-(--el-text-secondary) hover:border-(--el-accent) hover:text-(--el-accent) disabled:opacity-60"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden />
      {busy ? t('creatingSprint') : t('createSprint')}
    </button>
  );
}
