'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, Calendar, Clock, GitBranch, Goal, Plus, User } from 'lucide-react';
import type {
  ExecutorDto,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto, StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { LabelDto } from '@/lib/dto/labels';
import type { ComponentDto } from '@/lib/dto/components';
import type { SprintDto } from '@/lib/dto/sprints';
import type { IssueType } from '@/lib/issues/parentRules';
import type { Locale } from '@/lib/i18n/locales';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { SprintPicker } from '@/components/issues/SprintPicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypePicker } from '@/components/issues/WorkItemTypePicker';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { ExecutorPicker } from '@/components/issues/ExecutorPicker';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { defaultExecutorForType, isTypeableKind } from '@/lib/issues/executorDefaults';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { formatDateTime, formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { changeStatusAction, updateIssueAction, type UpdateIssueInput } from '../edit/actions';
import { setWorkItemSprint } from '@/components/issues/actions/workItemActionsClient';
import { Avatar, FieldCard } from './FieldCard';
import { CustomFieldsSection } from './CustomFieldsSection';
import { LabelsCard } from './LabelsCard';
import { ComponentsCard } from './ComponentsCard';
import { ProvenanceSection } from './ProvenanceSection';

// The issue detail metadata rail (Story 2.4 · Subtasks 2.4.2 + 2.4.4). Per the
// mockup `design/work-items/detail.png`: a stack of field cards that DISPLAY the
// value normally, each with a chevron in the top-right corner to edit it inline.
// Clicking the chevron swaps the value for the field's control; picking a new
// value commits through the shipped Server Actions (changeStatusAction → the
// gated 2.2.4 transition path; updateIssueAction → the concurrency-checked
// updateWorkItem) and refreshes the route. Status / type / priority / assignee /
// parent / due / estimate are editable; reporter + created/updated are read-only.

export interface CoreFieldsPanelProps {
  item: WorkItemDto;
  members: WorkspaceMemberDTO[];
  workflow: WorkflowDto;
  /** The resolved parent summary (for the Parent card's display). */
  parent: WorkItemSummaryDto | null;
  /** True when the reporter is the signed-in viewer (renders a "You" chip). */
  reporterIsSelf?: boolean;
  /**
   * The project's custom-field definitions + this issue's values (Subtask
   * 5.3.7), rendered as a contiguous card block after Estimate and before
   * created/updated. With no definitions the rail renders exactly as before.
   */
  customFields?: CustomFieldWithValueDto[];
  /**
   * Labels + components (Story 5.4 · Subtask 5.4.8) — the two cards slot
   * between Parent and Due date (the relational group, ahead of the
   * date/estimate block — labels-components-watch.mock.html panel 0). The
   * page threads the project key (the label-autocomplete route), the project
   * taxonomy (the components picker's option source), and the admin flag
   * (the empty-taxonomy "Manage components" link). Omitted (older call
   * sites / unit tests), the rail renders without the two cards.
   */
  labelsComponents?: {
    projectKey: string;
    labels: LabelDto[];
    components: ComponentDto[];
    projectComponents: ComponentDto[];
    canManageProject: boolean;
  };
  /**
   * The project's sprints (Subtask 2.4.14) — backs the inline Sprint field's
   * picker + the current sprint's display name. Omitted (older call sites / unit
   * tests) or for an EPIC, the Sprint card does not render (epics span sprints,
   * Jira-faithful).
   */
  sprints?: SprintDto[];
}

type EditableKey =
  | 'status'
  | 'type'
  | 'workItemType'
  | 'executor'
  | 'priority'
  | 'assignee'
  | 'parent'
  | 'sprint'
  | 'dueDate'
  | 'estimate';

// The read-mode executor indicator (Story 2.7 · 2.7.4) — a compact bot/person
// glyph + label, per design panel 3. Decorative glyph; the label carries the name.
const EXECUTOR_GLYPH: Record<ExecutorDto, typeof Bot> = { coding_agent: Bot, human: User };

function ExecutorIndicator({ executor }: { executor: ExecutorDto }) {
  const tl = useTranslations('labels');
  const Glyph = EXECUTOR_GLYPH[executor];
  return (
    <span className="flex items-center gap-1.5">
      <Glyph className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
      {tl(`executor.${executor}`)}
    </span>
  );
}

const STATUS_TONE: Record<StatusCategoryDto, NonNullable<PillProps['status']>> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

// Priority chip presentation now lives in the shared `PRIORITY_META` (reused by
// the issue-list row, 2.5.3) — imported above.

// Avatar + FieldCard moved to `./FieldCard` (Subtask 5.3.7) so the custom-field
// cards compose the same chrome — imported above.

export function CoreFieldsPanel({
  item,
  members,
  workflow,
  parent,
  reporterIsSelf,
  customFields = [],
  labelsComponents,
  sprints = [],
}: CoreFieldsPanelProps) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  // Story 6.4.6 — a read-only actor (viewer, or member on a limited project)
  // sees every field control disabled. The server (6.4.3) rejects the write
  // regardless; disabling here makes the affordance honest rather than letting
  // a viewer edit then bounce off a 403.
  const { canEdit } = useProjectAccess();
  const readOnly = !canEdit;
  const [editing, setEditing] = useState<EditableKey | null>(null);
  const [updatedAt, setUpdatedAt] = useState(item.updatedAt);
  const [dueDate, setDueDate] = useState(item.dueDate ? item.dueDate.slice(0, 10) : '');
  const [estimate, setEstimate] = useState(
    item.estimateMinutes != null ? String(item.estimateMinutes) : '',
  );
  // Optimistic field overrides (the inline-edit rule, bug-inline-status-revert):
  // a picked value displays immediately and the action RESPONSE is the
  // confirmation, so we KEEP it — never router.refresh() on success, which
  // re-reads the not-yet-propagated server tree and reverts this cell AND any
  // sibling optimistic state on the page (the estimation/watch flakes). Cleared
  // back to the server value only on error / a stale-conflict re-read.
  const [overrides, setOverrides] = useState<Partial<WorkItemDto>>({});
  // The picked parent's display label: the relational field can't derive its
  // identifier/title from the id alone, so the picker hands it over (`undefined`
  // = no pending change → show the server `parent`).
  const [parentOverride, setParentOverride] = useState<
    Pick<WorkItemSummaryDto, 'identifier' | 'title'> | null | undefined
  >(undefined);
  const eff = { ...item, ...overrides };
  const effParent = parentOverride !== undefined ? parentOverride : parent;

  const typeMeta = ISSUE_TYPE_META[eff.kind];
  const reporter = members.find((m) => m.userId === eff.reporterId);
  const assignee = members.find((m) => m.userId === eff.assigneeId);
  const statusMeta = workflow.statuses.find((s) => s.key === eff.status);
  // The Sprint field's empty label is status-aware: an ACTIVE item with no sprint
  // sits in the Backlog, but a DONE/cancelled one is EXCLUDED from the backlog
  // (backlogService.backlogExcludedStatusKeys → every category 'done' status), so
  // it reads "None". Used for BOTH the read value AND the picker sentinel so the
  // two never disagree.
  const sprintEmptyLabel = statusMeta?.category === 'done' ? t('none') : t('backlog');
  const currentSprint = eff.sprintId ? sprints.find((s) => s.id === eff.sprintId) : undefined;

  // Drop the optimistic override for the given field keys (on error / stale).
  function revert(keys: string[]) {
    setOverrides((o) => {
      const next = { ...o };
      for (const k of keys) delete next[k as keyof WorkItemDto];
      return next;
    });
    if (keys.includes('parentId')) setParentOverride(undefined);
  }

  const toggle = (key: EditableKey) => setEditing((cur) => (cur === key ? null : key));

  function patch(input: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>) {
    setEditing(null);
    setOverrides((o) => ({ ...o, ...input }));
    startTransition(async () => {
      const res = await updateIssueAction({ id: item.id, expectedUpdatedAt: updatedAt, ...input });
      if (res.ok) {
        // The 200 IS the confirmation — keep the optimistic value, no refresh.
        setUpdatedAt(res.updatedAt);
      } else if (res.stale) {
        // A genuine conflict (someone else edited): drop our optimistic value
        // and re-read the server's newer state — the one place a refresh is right.
        revert(Object.keys(input));
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        revert(Object.keys(input));
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  function changeStatus(toStatusKey: string) {
    setEditing(null);
    if (toStatusKey === eff.status) return;
    setOverrides((o) => ({ ...o, status: toStatusKey }));
    startTransition(async () => {
      const res = await changeStatusAction({ id: item.id, toStatusKey });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
      } else {
        revert(['status']);
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  // Due date commits as soon as the DatePicker fires (a day picked or cleared);
  // the picker owns its own open/close, so there's no blur/chevron commit. patch()
  // closes edit mode on a real change; an unchanged pick just closes.
  function commitDue(next: string | null) {
    setDueDate(next ?? '');
    const iso = next ? new Date(`${next}T00:00:00.000Z`).toISOString() : null;
    if (iso !== eff.dueDate) patch({ dueDate: iso });
    else setEditing(null);
  }
  // Estimate stays a free-text field: commits on blur AND when the chevron
  // collapses it (the chevron no longer blurs the input).
  function commitEstimate() {
    const next = estimate === '' ? null : Number(estimate);
    if (next !== eff.estimateMinutes) patch({ estimateMinutes: next });
    else setEditing(null);
  }

  // Sprint commits through the existing assign route (4.1.4) via the client
  // helper — NOT updateIssueAction (sprint assignment is a ranked move owned by
  // backlogService, not a field patch). Optimistic like the other inline fields:
  // the picked value displays immediately and the 200 IS the confirmation (no
  // router.refresh of the cell — the page-state inline-edit rule); reverted only
  // on error. `null` = move to the backlog.
  function commitSprint(next: string | null) {
    setEditing(null);
    if (next === (eff.sprintId ?? null)) return;
    setOverrides((o) => ({ ...o, sprintId: next }));
    startTransition(async () => {
      try {
        const res = await setWorkItemSprint(item.id, next);
        setUpdatedAt(res.updatedAt);
      } catch {
        revert(['sprintId']);
        toast({ variant: 'error', title: t('sprintChangeFailed') });
      }
    });
  }

  const muted = (text: string) => <span className="text-(--el-text-secondary) italic">{text}</span>;
  const priorityPill = PRIORITY_META[eff.priority];

  return (
    <div className="flex flex-col gap-3">
      <FieldCard
        label={t('status')}
        editing={editing === 'status'}
        onToggle={() => toggle('status')}
      >
        {editing === 'status' ? (
          <StatusPicker
            statuses={workflow.statuses}
            transitions={workflow.transitions}
            policyMode={workflow.policyMode}
            value={eff.status}
            onChange={changeStatus}
            disabled={isPending || readOnly}
          />
        ) : statusMeta ? (
          <Pill status={STATUS_TONE[statusMeta.category]}>{statusMeta.label}</Pill>
        ) : (
          <Pill tone="neutral">{eff.status}</Pill>
        )}
      </FieldCard>

      {/* Session branch (Subtask 7.8.11) — a READ-ONLY line under Status,
          present only while the item is integrated-awaiting-review (its work
          merged to a session branch via `mark_integrated`, cleared on done). No
          editing affordance: it's set/cleared by the integration tools, never by
          hand. Reuses the read-only FieldCard chrome (no new visual element). */}
      {eff.sessionBranch ? (
        <FieldCard label={t('sessionBranch')} editable={false}>
          <span className="flex items-center gap-1.5">
            <GitBranch className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            <span className="truncate font-mono text-xs">{eff.sessionBranch}</span>
          </span>
        </FieldCard>
      ) : null}

      <FieldCard label={t('type')} editing={editing === 'type'} onToggle={() => toggle('type')}>
        {editing === 'type' ? (
          <TypePicker
            value={eff.kind as IssueType}
            onChange={(kind) => patch({ kind: kind as WorkItemKindDto })}
            disabled={isPending || readOnly}
          />
        ) : (
          <span className="flex items-center gap-1.5">
            <IssueTypeIcon type={eff.kind as IssueType} className="h-4 w-4" />
            {typeMeta.label}
          </span>
        )}
      </FieldCard>

      {/* Work type + Executor (Story 2.7 · 2.7.4) — the NATURE of the work +
          WHO does it, per design/work-items/type-executor-picker.mock.html
          panel 3. LEAF-ONLY: shown only for a leaf kind (task/subtask/bug),
          absent for epic/story (panel 2d). Inline-edit reuses the SAME picker
          (the 2.5.5 pattern); choosing a type seeds the executor when none is
          set (matching the service seed-if-absent), preserving an override. The
          Executor row appears only once a type is set (it follows the type). */}
      {isTypeableKind(eff.kind as WorkItemKindDto) ? (
        <>
          <FieldCard
            label={t('workItemType')}
            editing={editing === 'workItemType'}
            onToggle={() => toggle('workItemType')}
          >
            {editing === 'workItemType' ? (
              <WorkItemTypePicker
                value={eff.type}
                onChange={(tp) =>
                  patch({
                    type: tp,
                    ...(eff.executor == null ? { executor: defaultExecutorForType(tp) } : {}),
                  })
                }
                onClose={() => setEditing(null)}
                autoOpen
                disabled={isPending || readOnly}
              />
            ) : eff.type ? (
              <WorkItemTypeChip type={eff.type} />
            ) : (
              <button
                type="button"
                onClick={() => toggle('workItemType')}
                disabled={isPending || readOnly}
                className="inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-dashed border-(--el-border-strong) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text-muted) hover:text-(--el-text) disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 text-(--el-text-faint)" aria-hidden />
                {t('setType')}
              </button>
            )}
          </FieldCard>

          {eff.type ? (
            <FieldCard
              label={t('executor')}
              editing={editing === 'executor'}
              onToggle={() => toggle('executor')}
            >
              {editing === 'executor' ? (
                <ExecutorPicker
                  value={eff.executor ?? defaultExecutorForType(eff.type)}
                  onChange={(ex) => patch({ executor: ex })}
                  disabled={isPending || readOnly}
                />
              ) : (
                <ExecutorIndicator executor={eff.executor ?? defaultExecutorForType(eff.type)} />
              )}
            </FieldCard>
          ) : null}
        </>
      ) : null}

      <FieldCard
        label={t('priority')}
        editing={editing === 'priority'}
        onToggle={() => toggle('priority')}
      >
        {editing === 'priority' ? (
          <PriorityPicker
            value={eff.priority}
            onChange={(priority) => patch({ priority })}
            disabled={isPending || readOnly}
          />
        ) : (
          <Pill {...priorityPill.pill}>
            <priorityPill.icon className="h-3 w-3" aria-hidden />
            {tl('priority.' + eff.priority)}
          </Pill>
        )}
      </FieldCard>

      <FieldCard
        label={t('assignee')}
        editing={editing === 'assignee'}
        onToggle={() => toggle('assignee')}
      >
        {editing === 'assignee' ? (
          <AssigneePicker
            members={members}
            value={eff.assigneeId}
            onChange={(userId) => patch({ assigneeId: userId })}
            disabled={isPending || readOnly}
          />
        ) : assignee ? (
          <span className="flex items-center gap-2">
            <Avatar name={assignee.name || assignee.email} />
            <span className="truncate">{assignee.name}</span>
          </span>
        ) : (
          muted(t('unassigned'))
        )}
      </FieldCard>

      <FieldCard label={t('reporter')} editable={false}>
        {reporter ? (
          <span className="flex items-center gap-2">
            <Avatar name={reporter.name || reporter.email} />
            <span className="truncate">{reporter.name}</span>
            {reporterIsSelf ? <Pill tone="neutral">{t('you')}</Pill> : null}
          </span>
        ) : (
          muted(t('unknown'))
        )}
      </FieldCard>

      <FieldCard
        label={t('parent')}
        editing={editing === 'parent'}
        onToggle={() => toggle('parent')}
      >
        {editing === 'parent' ? (
          <ParentPicker
            childType={eff.kind as IssueType}
            value={eff.parentId}
            onChange={(parentId, picked) => {
              // The picker hands over the chosen parent's label so the display
              // shows it immediately (optimistic) without a server re-read.
              setParentOverride(picked ?? null);
              patch({ parentId });
            }}
            disabled={isPending || readOnly}
          />
        ) : effParent ? (
          <Link
            href={`/items/${effParent.identifier}`}
            className="flex items-center gap-1.5 hover:underline"
          >
            <span className="text-(--el-text-secondary) font-mono text-xs">
              {effParent.identifier}
            </span>
            <span className="truncate">{effParent.title}</span>
          </Link>
        ) : (
          muted(t('none'))
        )}
      </FieldCard>

      {/* Labels + Components (5.4.8) — between Parent and Due date: with the
          relational fields, ahead of the date/estimate group (the Jira
          details-panel grouping; labels-components-watch.mock.html panel 0).
          Each card owns its edit state + picker; commits confirm from the
          action response (no whole-tree refresh). */}
      {labelsComponents ? (
        <>
          <LabelsCard
            workItemId={item.id}
            projectKey={labelsComponents.projectKey}
            initialLabels={labelsComponents.labels}
          />
          <ComponentsCard
            workItemId={item.id}
            initialComponents={labelsComponents.components}
            projectComponents={labelsComponents.projectComponents}
            canManageProject={labelsComponents.canManageProject}
          />
        </>
      ) : null}

      <FieldCard
        label={t('dueDate')}
        editing={editing === 'dueDate'}
        onToggle={() => toggle('dueDate')}
      >
        {editing === 'dueDate' ? (
          <DatePicker
            aria-label={t('dueDate')}
            value={dueDate || null}
            onChange={commitDue}
            disabled={isPending || readOnly}
            autoOpen
          />
        ) : eff.dueDate ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDate(eff.dueDate, locale)}
          </span>
        ) : (
          muted(t('noDueDate'))
        )}
      </FieldCard>

      {/* Sprint (Subtask 2.4.14) — between Due date and Story points (the agile
          cluster; design/work-items/sprint-field.mock.html). Inline-editable via
          the SprintPicker (Backlog-first sentinel). HIDDEN for epics — they span
          sprints (Jira-faithful). No sprint → muted-italic "Backlog" for an
          ACTIVE item, but "None" for a DONE/cancelled one (the backlog excludes
          category 'done', so such an item is not "in the Backlog"). The write
          goes through backlogService (the 4.1.4 assign route), so this commits
          optimistically with no router.refresh. */}
      {eff.kind !== 'epic' ? (
        <FieldCard
          label={t('sprint')}
          editing={editing === 'sprint'}
          onToggle={() => toggle('sprint')}
        >
          {editing === 'sprint' ? (
            <SprintPicker
              sprints={sprints}
              value={eff.sprintId}
              onChange={commitSprint}
              emptyLabel={sprintEmptyLabel}
              onClose={() => setEditing(null)}
              autoOpen
              disabled={isPending || readOnly}
            />
          ) : currentSprint ? (
            <span className="flex items-center gap-1.5">
              <Goal className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
              <span className="truncate">{currentSprint.name}</span>
              {currentSprint.state === 'complete' ? (
                <span className="text-(--el-text-muted) italic">({t('sprintCompleted')})</span>
              ) : null}
            </span>
          ) : (
            muted(sprintEmptyLabel)
          )}
        </FieldCard>
      ) : null}

      {/* Story points (Subtask 4.3.4) — the agile estimate, DISTINCT from the
          TIME Estimate below (design panel 2). The badge owns its own
          click-to-edit picker, so this card has no chevron (editable={false});
          `forceStoryPoints` keeps it a story-points field regardless of the
          project's display statistic. */}
      <FieldCard label={t('storyPoints')} editable={false}>
        <EstimateBadge
          itemId={item.id}
          storyPoints={item.storyPoints}
          estimateMinutes={item.estimateMinutes}
          forceStoryPoints
        />
      </FieldCard>

      <FieldCard
        label={t('estimate')}
        editing={editing === 'estimate'}
        onToggle={() => (editing === 'estimate' ? commitEstimate() : setEditing('estimate'))}
      >
        {editing === 'estimate' ? (
          <Input
            type="number"
            min={0}
            aria-label={t('estimateMinutes')}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={commitEstimate}
            disabled={isPending || readOnly}
            autoFocus
          />
        ) : eff.estimateMinutes != null ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDurationMinutes(eff.estimateMinutes)}
          </span>
        ) : (
          muted(t('noEstimate'))
        )}
      </FieldCard>

      {/* Custom fields (5.3.7) — a contiguous block after the last built-in
          card, before created/updated (custom-fields.mock.html panel 0). With
          no definitions the section renders nothing — the rail is unchanged. */}
      <CustomFieldsSection workItemId={item.id} fields={customFields} members={members} />

      {/* Created / updated — read-only audit fields (locale-aware date, UTC zone). */}
      <dl className="flex flex-col gap-1 px-1 pt-1 font-sans text-xs text-(--el-text-secondary)">
        <div className="flex justify-between gap-2">
          <dt>{t('created')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.createdAt, locale)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t('updated')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.updatedAt, locale)}</dd>
        </div>
      </dl>

      {/* Work-item provenance (Story MOTIR-1685 · MOTIR-1693) — a collapsed
          disclosure at the VERY BOTTOM of the rail (after every other field), per
          design/work-items/provenance.mock.html + the ADR's Decision 7. Read-only;
          expands to show the Planning + Implementation triples. */}
      <ProvenanceSection item={item} />
    </div>
  );
}
