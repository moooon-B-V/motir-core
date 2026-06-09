'use client';

import { createContext, useContext, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/Toast';
import { DatePicker } from '@/components/ui/DatePicker';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import {
  changeStatusAction,
  updateIssueAction,
  type UpdateIssueInput,
} from '../[key]/edit/actions';
import {
  StatusValue,
  AssigneeValue,
  PriorityValue,
  DueValue,
  EstimateValue,
} from './issueCellPrimitives';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import type { IssueRowData } from './issueRows';

// Inline editing for the /issues row cells (Subtask 2.5.5) — STATUS · ASSIGNEE ·
// PRIORITY · DUE · ESTIMATE, the same set the detail page's `CoreFieldsPanel`
// edits. A REUSE module, not new mutation work: STATUS opens the shared
// `StatusPicker` → 2.4.4's gated `changeStatusAction` (→ 2.2.4 `updateStatus`);
// the others open the shared `AssigneePicker` / `PriorityPicker` / `DatePicker` /
// a numeric field → `updateIssueAction` (→ the status-free `updateWorkItem`,
// writes a revision) — the SAME components + Server Actions the detail page uses,
// with identical workspace+membership gating (a forged cross-workspace id 404s).
//
// A surface is editable only inside an `IssueInlineEditProvider` (which carries
// the project workflow → legal status targets, and the workspace members → the
// assignee options). Without the provider the cells render read-only values — so
// the loading skeleton or any non-interactive caller degrades gracefully. Both
// views (Tree + List) mount the provider, so the list and the detail page truly
// share the controls (no parallel components).

interface InlineEditContextValue {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
}

const IssueInlineEditContext = createContext<InlineEditContextValue | null>(null);

export function IssueInlineEditProvider({
  workflow,
  members,
  children,
}: {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  children: ReactNode;
}) {
  // Story 6.4.6 — a read-only actor (viewer / member on a limited project) gets
  // a NULL context, so every cell falls through to its read-only value (the
  // `if (!ctx) return <…Value/>` branch below). The whole inline-edit surface
  // goes read-only without touching the three mount sites. Defaults to editable
  // when there's no ProjectAccessProvider (non-shell / test mounts).
  const { canEdit } = useProjectAccess();
  const value = useMemo(
    () => (canEdit ? { workflow, members } : null),
    [canEdit, workflow, members],
  );
  return (
    <IssueInlineEditContext.Provider value={value}>{children}</IssueInlineEditContext.Provider>
  );
}

function useIssueInlineEdit() {
  return useContext(IssueInlineEditContext);
}

// The shared commit path for the `updateIssueAction` fields (assignee / priority
// / due / estimate). Optimistic: the caller mirrors the new value locally, then
// `run` fires the gated action with the row's `expectedUpdatedAt`; on a stale /
// error result `revert` drops the optimistic value and a toast surfaces the typed
// message. On success the route revalidates and the cell remounts (keyed by the
// authoritative value), discarding the override — no setState-in-effect.
function useUpdateField(row: IssueRowData) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations('issueViews');
  const [pending, startTransition] = useTransition();
  function run(patch: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>, revert: () => void) {
    startTransition(async () => {
      const res = await updateIssueAction({
        id: row.id,
        expectedUpdatedAt: row.updatedAt,
        ...patch,
      });
      if (res.ok) {
        router.refresh();
      } else if (res.stale) {
        revert();
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        revert();
        toast({ variant: 'error', title: res.error });
      }
    });
  }
  return { run, pending };
}

// The cell's clickable resting state — the value rendered as a button that opens
// the picker. `relative z-10` lifts it above the row's stretched detail link so
// the click opens the editor instead of navigating (the AC's "opening a control
// does not navigate the row"); `stopPropagation` is belt-and-braces.
function EditTrigger({
  label,
  onOpen,
  disabled,
  className,
  children,
}: {
  label: string;
  onOpen: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'relative z-10 -mx-1 inline-flex max-w-full items-center rounded-(--radius-control) px-1 py-0.5 text-left hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60',
        className,
      )}
    >
      {children}
    </button>
  );
}

// The open editor wrapper. `z-30` (above the resting cells' `z-10` AND the
// sticky header's `z-20`) so the picker's dropdown — confined to this cell's
// stacking context — paints OVER the sibling rows below it, instead of being
// occluded by their later-in-DOM `z-10` cells. Also swallows clicks so a pick
// inside the picker never bubbles to the row navigation.
function EditSurface({ children }: { children: ReactNode }) {
  return (
    <span className="relative z-30 block w-full" onClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}

function InlineStatusEditor({ row, workflow }: { row: IssueRowData; workflow: WorkflowDto }) {
  const t = useTranslations('issueViews');
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  // Optimistic override: the just-picked key, shown until the revalidate brings
  // the authoritative row value back. The cell is keyed by `row.status` (see
  // InlineStatusCell), so when the server value lands the editor REMOUNTS and the
  // override resets to undefined — no setState-in-effect. On failure the override
  // is dropped explicitly and the cell reverts.
  const [override, setOverride] = useState<string | undefined>(undefined);

  const statusKey = override ?? row.status;
  const meta = workflow.statuses.find((s) => s.key === statusKey);
  const label = meta?.label ?? statusKey;
  const category = meta?.category ?? null;

  function commit(toStatusKey: string) {
    setEditing(false);
    if (toStatusKey === statusKey) return;
    setOverride(toStatusKey);
    startTransition(async () => {
      const res = await changeStatusAction({ id: row.id, toStatusKey });
      if (res.ok) {
        router.refresh();
      } else {
        setOverride(undefined);
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  if (editing) {
    return (
      <EditSurface>
        <StatusPicker
          statuses={workflow.statuses}
          transitions={workflow.transitions}
          policyMode={workflow.policyMode}
          value={statusKey}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('status')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <StatusValue category={category} label={label} />
    </EditTrigger>
  );
}

function InlineAssigneeEditor({
  row,
  members,
}: {
  row: IssueRowData;
  members: WorkspaceMemberDTO[];
}) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  // `undefined` = no pending edit; `{ id }` = optimistic value (id may be null
  // for an unassign). Keyed by `row.assigneeId` (see InlineAssigneeCell) so the
  // editor remounts (clearing the override) once the server value lands.
  const [override, setOverride] = useState<{ id: string | null } | undefined>(undefined);

  const assigneeId = override ? override.id : row.assigneeId;
  const member = assigneeId ? members.find((m) => m.userId === assigneeId) : undefined;
  const name = member ? member.name || member.email : null;

  function commit(userId: string | null) {
    setEditing(false);
    if (userId === assigneeId) return;
    setOverride({ id: userId });
    run({ assigneeId: userId }, () => setOverride(undefined));
  }

  if (editing) {
    return (
      <EditSurface>
        <AssigneePicker
          members={members}
          value={assigneeId}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('assignee')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <AssigneeValue name={name} />
    </EditTrigger>
  );
}

function InlinePriorityEditor({ row }: { row: IssueRowData }) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState<WorkItemPriorityDto | undefined>(undefined);

  const priority = override ?? row.priority;

  function commit(next: WorkItemPriorityDto) {
    setEditing(false);
    if (next === priority) return;
    setOverride(next);
    run({ priority: next }, () => setOverride(undefined));
  }

  if (editing) {
    return (
      <EditSurface>
        <PriorityPicker
          value={priority}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('priority')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <PriorityValue priority={priority} />
    </EditTrigger>
  );
}

function InlineDueEditor({ row }: { row: IssueRowData }) {
  const t = useTranslations('issueViews');
  const locale = useLocale() as Locale;
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  // `undefined` = no pending edit; otherwise the optimistic ISO value (or null).
  const [override, setOverride] = useState<string | null | undefined>(undefined);

  const dueIso = override !== undefined ? override : row.dueDate;
  const label = dueIso ? formatDate(dueIso, locale) : null;

  // The DatePicker yields a `YYYY-MM-DD` string (or null); commit it as the same
  // UTC-midnight ISO the edit form writes, so an unchanged pick is a no-op.
  function commit(next: string | null) {
    setEditing(false);
    const iso = next ? new Date(`${next}T00:00:00.000Z`).toISOString() : null;
    if (iso === (row.dueDate ?? null)) return;
    setOverride(iso);
    run({ dueDate: iso }, () => setOverride(undefined));
  }

  if (editing) {
    return (
      <EditSurface>
        <DatePicker
          aria-label={t('dueDate')}
          value={dueIso ? dueIso.slice(0, 10) : null}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
          // Match the other inline editors' control height: the DatePicker's
          // default --height-input (44px) is TALLER than the Tree view's 40px
          // rows (TreeTable ROW_PX), so on the last row it overflows and the
          // card's overflow:hidden clips its bottom
          // (bug-inline-edit-clipped-when-table-short). --height-control (36px)
          // fits both the 40px tree row and the 44px list row.
          className="h-(--height-control)"
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('dueDate')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <DueValue label={label} />
    </EditTrigger>
  );
}

function InlineEstimateEditor({ row }: { row: IssueRowData }) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState<number | null | undefined>(undefined);
  // The free-text draft, seeded from the row (re-seeds on remount when the
  // authoritative value changes — the cell is keyed by `row.estimateMinutes`).
  const [draft, setDraft] = useState(
    row.estimateMinutes != null ? String(row.estimateMinutes) : '',
  );

  const estimate = override !== undefined ? override : row.estimateMinutes;
  const label = estimate != null ? formatDurationMinutes(estimate) : null;

  // Commit on blur / Enter (not per-keystroke), like the detail page's estimate
  // field. An empty field clears the estimate; an invalid number is a no-op.
  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) return;
    if (next === (row.estimateMinutes ?? null)) return;
    setOverride(next);
    run({ estimateMinutes: next }, () => setOverride(undefined));
  }

  if (editing) {
    // A compact, cell-sized field — the form-sized `Input` (taller
    // `--height-input` + FormField chrome) doesn't fit a table row. Same shape /
    // colour element tokens (control height, input radius, strong border), native
    // number spinners hidden (they overflow + aren't needed), right-aligned to
    // the column.
    return (
      <EditSurface>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          aria-label={t('estimateMinutes')}
          className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border-strong) bg-(--el-page-bg) px-(--spacing-control-x) text-right font-sans text-sm text-(--el-text) outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          disabled={pending}
          autoFocus
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('estimate')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
      className="w-full justify-end"
    >
      <EstimateValue label={label} />
    </EditTrigger>
  );
}

/** STATUS cell — inline-editable inside a provider, else the read-only pill. */
export function InlineStatusCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <StatusValue category={row.statusCategory} label={row.statusLabel} />;
  // Key by the authoritative value so a server change remounts the editor and
  // discards a stale optimistic override (the no-effect reconcile).
  return <InlineStatusEditor key={row.status} row={row} workflow={ctx.workflow} />;
}

/** ASSIGNEE cell — inline-editable inside a provider, else the read-only value. */
export function InlineAssigneeCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <AssigneeValue name={row.assigneeName} />;
  return (
    <InlineAssigneeEditor
      key={row.assigneeId ?? '__unassigned__'}
      row={row}
      members={ctx.members}
    />
  );
}

/** PRIORITY cell — inline-editable inside a provider, else the read-only chip. */
export function InlinePriorityCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <PriorityValue priority={row.priority} />;
  return <InlinePriorityEditor key={row.priority} row={row} />;
}

/** DUE cell — inline-editable inside a provider, else the read-only date. */
export function InlineDueCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <DueValue label={row.dueLabel} />;
  return <InlineDueEditor key={row.dueDate ?? '__none__'} row={row} />;
}

/** ESTIMATE cell — inline-editable inside a provider, else the read-only value. */
export function InlineEstimateCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <EstimateValue label={row.estimateLabel} />;
  return <InlineEstimateEditor key={row.estimateMinutes ?? '__none__'} row={row} />;
}
