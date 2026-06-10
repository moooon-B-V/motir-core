'use client';

import { createContext, useContext, useMemo, useRef, useState, useTransition } from 'react';
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

// The optimistic value for one inline cell, converging on the server's
// ACKNOWLEDGEMENT rather than on the first re-render that changes the prop
// (bug-inline-status-revert-on-second-edit). Two rapid edits on different rows
// put two action calls + two `router.refresh()`es in flight; a refresh that
// snapshotted the DB before this row's write committed can apply AFTER the
// fresh one, handing the cell stale server props. The old mechanic — key the
// cell by the authoritative value so any server change remounts it and drops
// the override — trusted whatever payload arrived last, so that stale payload
// re-rendered the row's OLD value (display-only; the DB held the new one).
//
// Instead the override carries the `updatedAt` the action returned for the
// row once the write is acknowledged, and yields to the server only when the
// row's `updatedAt` has caught up (`>=`, lexicographic — both sides are
// same-format UTC ISO-8601). An older snapshot is by definition missing our
// committed write, so the override keeps rendering; a snapshot at/after it
// includes the write (per-row `updatedAt` is monotonic), so the server value
// wins — which also lets a genuinely later edit by someone else show through.
// No remount, no setState-in-effect; a follow-up edit on the same cell
// replaces the override (the token keeps a superseded action's confirm/fail
// from clobbering it).
function useConvergingOverride<T>(serverValue: T, serverUpdatedAt: string) {
  const [override, setOverride] = useState<{ value: T; confirmedUpdatedAt?: string } | null>(null);
  const tokenRef = useRef(0);

  const serverCaughtUp =
    override?.confirmedUpdatedAt !== undefined && serverUpdatedAt >= override.confirmedUpdatedAt;
  const value = override !== null && !serverCaughtUp ? override.value : serverValue;

  function begin(next: T): number {
    const token = ++tokenRef.current;
    setOverride({ value: next });
    return token;
  }
  function confirm(token: number, updatedAt: string) {
    if (tokenRef.current !== token) return;
    setOverride((o) => (o === null ? o : { ...o, confirmedUpdatedAt: updatedAt }));
  }
  function fail(token: number) {
    if (tokenRef.current !== token) return;
    setOverride(null);
  }
  return { value, begin, confirm, fail };
}

// The shared commit path for the `updateIssueAction` fields (assignee / priority
// / due / estimate). Optimistic: the caller begins a converging override, then
// `run` fires the gated action with the row's `expectedUpdatedAt`; on success
// `onConfirm` receives the acknowledged `updatedAt` (the override's converge
// point) before the route revalidates; on a stale / error result `onFail` drops
// the override and a toast surfaces the typed message.
function useUpdateField(row: IssueRowData) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations('issueViews');
  const [pending, startTransition] = useTransition();
  function run(
    patch: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>,
    handlers: { onConfirm: (updatedAt: string) => void; onFail: () => void },
  ) {
    startTransition(async () => {
      const res = await updateIssueAction({
        id: row.id,
        expectedUpdatedAt: row.updatedAt,
        ...patch,
      });
      if (res.ok) {
        handlers.onConfirm(res.updatedAt);
        router.refresh();
      } else if (res.stale) {
        handlers.onFail();
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        handlers.onFail();
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
  // Optimistic override: the just-picked key, held until the server's row
  // catches up with the acknowledged write (see useConvergingOverride — a
  // stale refresh payload must not revert the cell). On failure the override
  // is dropped and the cell reverts.
  const status = useConvergingOverride(row.status, row.updatedAt);

  const statusKey = status.value;
  const meta = workflow.statuses.find((s) => s.key === statusKey);
  const label = meta?.label ?? statusKey;
  const category = meta?.category ?? null;

  function commit(toStatusKey: string) {
    setEditing(false);
    if (toStatusKey === statusKey) return;
    const token = status.begin(toStatusKey);
    startTransition(async () => {
      const res = await changeStatusAction({ id: row.id, toStatusKey });
      if (res.ok) {
        status.confirm(token, res.updatedAt);
        router.refresh();
      } else {
        status.fail(token);
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
  // Converging override (the value may be null for an unassign) — held until
  // the server's row catches up with the acknowledged write.
  const assignee = useConvergingOverride(row.assigneeId, row.updatedAt);

  const assigneeId = assignee.value;
  const member = assigneeId ? members.find((m) => m.userId === assigneeId) : undefined;
  const name = member ? member.name || member.email : null;

  function commit(userId: string | null) {
    setEditing(false);
    if (userId === assigneeId) return;
    const token = assignee.begin(userId);
    run(
      { assigneeId: userId },
      {
        onConfirm: (updatedAt) => assignee.confirm(token, updatedAt),
        onFail: () => assignee.fail(token),
      },
    );
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
  const priorityField = useConvergingOverride(row.priority, row.updatedAt);

  const priority = priorityField.value;

  function commit(next: WorkItemPriorityDto) {
    setEditing(false);
    if (next === priority) return;
    const token = priorityField.begin(next);
    run(
      { priority: next },
      {
        onConfirm: (updatedAt) => priorityField.confirm(token, updatedAt),
        onFail: () => priorityField.fail(token),
      },
    );
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
  // Converging override over the ISO value (or null for a cleared date).
  const due = useConvergingOverride(row.dueDate, row.updatedAt);

  const dueIso = due.value;
  const label = dueIso ? formatDate(dueIso, locale) : null;

  // The DatePicker yields a `YYYY-MM-DD` string (or null); commit it as the same
  // UTC-midnight ISO the edit form writes, so an unchanged pick is a no-op.
  function commit(next: string | null) {
    setEditing(false);
    const iso = next ? new Date(`${next}T00:00:00.000Z`).toISOString() : null;
    if (iso === (dueIso ?? null)) return;
    const token = due.begin(iso);
    run(
      { dueDate: iso },
      {
        onConfirm: (updatedAt) => due.confirm(token, updatedAt),
        onFail: () => due.fail(token),
      },
    );
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
  const estimateField = useConvergingOverride(row.estimateMinutes, row.updatedAt);
  // The free-text draft, seeded from the shown value each time the editor
  // opens (the cell no longer remounts on a server change, so a mount-time
  // seed would go stale).
  const [draft, setDraft] = useState('');

  const estimate = estimateField.value;
  const label = estimate != null ? formatDurationMinutes(estimate) : null;

  function open() {
    setDraft(estimate != null ? String(estimate) : '');
    setEditing(true);
  }

  // Commit on blur / Enter (not per-keystroke), like the detail page's estimate
  // field. An empty field clears the estimate; an invalid number is a no-op.
  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) return;
    if (next === (estimate ?? null)) return;
    const token = estimateField.begin(next);
    run(
      { estimateMinutes: next },
      {
        onConfirm: (updatedAt) => estimateField.confirm(token, updatedAt),
        onFail: () => estimateField.fail(token),
      },
    );
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
      onOpen={open}
      disabled={pending}
      className="w-full justify-end"
    >
      <EstimateValue label={label} />
    </EditTrigger>
  );
}

// NOTE (bug-inline-status-revert-on-second-edit): the editors below are
// deliberately NOT keyed by their authoritative row value. The old keyed
// remount discarded the optimistic override on the FIRST server change —
// which let a stale refresh payload, applied after the fresh one, revert a
// row another in-flight edit had already committed. Reconciliation now lives
// in useConvergingOverride (the override yields only once the row's
// `updatedAt` reaches the acknowledged write).

/** STATUS cell — inline-editable inside a provider, else the read-only pill. */
export function InlineStatusCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <StatusValue category={row.statusCategory} label={row.statusLabel} />;
  return <InlineStatusEditor row={row} workflow={ctx.workflow} />;
}

/** ASSIGNEE cell — inline-editable inside a provider, else the read-only value. */
export function InlineAssigneeCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <AssigneeValue name={row.assigneeName} />;
  return <InlineAssigneeEditor row={row} members={ctx.members} />;
}

/** PRIORITY cell — inline-editable inside a provider, else the read-only chip. */
export function InlinePriorityCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <PriorityValue priority={row.priority} />;
  return <InlinePriorityEditor row={row} />;
}

/** DUE cell — inline-editable inside a provider, else the read-only date. */
export function InlineDueCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <DueValue label={row.dueLabel} />;
  return <InlineDueEditor row={row} />;
}

/** ESTIMATE cell — inline-editable inside a provider, else the read-only value. */
export function InlineEstimateCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <EstimateValue label={row.estimateLabel} />;
  return <InlineEstimateEditor row={row} />;
}
