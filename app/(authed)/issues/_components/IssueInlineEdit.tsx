'use client';

import { createContext, useContext, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { changeStatusAction, updateIssueAction } from '../[key]/edit/actions';
import { StatusValue, AssigneeValue } from './issueCellPrimitives';
import type { IssueRowData } from './issueRows';

// Inline STATUS + ASSIGNEE editing for the /issues row cells (Subtask 2.5.5).
// This is a REUSE subtask, not new mutation work: the STATUS pill opens the
// shared `StatusPicker` and commits through 2.4.4's gated `changeStatusAction`
// (→ 2.2.4 `updateStatus`); the ASSIGNEE cell opens the shared `AssigneePicker`
// and commits through `updateIssueAction` (→ the status-free `updateWorkItem`,
// null = unassign, writes a revision) — the SAME components + Server Actions the
// detail page's `CoreFieldsPanel` uses, with identical workspace+membership
// gating (a forged cross-workspace id 404s server-side).
//
// A surface is editable only inside an `IssueInlineEditProvider` (which carries
// the project workflow → legal status targets, and the workspace members → the
// assignee options). Without the provider the cells render the read-only
// pill/avatar — so the loading skeleton or any non-interactive caller degrades
// gracefully. Both views (Tree + List) mount the provider, so the list and the
// detail page truly share the controls (no parallel components).

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
  const value = useMemo(() => ({ workflow, members }), [workflow, members]);
  return (
    <IssueInlineEditContext.Provider value={value}>{children}</IssueInlineEditContext.Provider>
  );
}

function useIssueInlineEdit() {
  return useContext(IssueInlineEditContext);
}

// The cell's clickable resting state — the value rendered as a button that opens
// the picker. `relative z-10` lifts it above the row's stretched detail link so
// the click opens the editor instead of navigating (the AC's "opening a control
// does not navigate the row"); `stopPropagation` is belt-and-braces.
function EditTrigger({
  label,
  onOpen,
  disabled,
  children,
}: {
  label: string;
  onOpen: () => void;
  disabled?: boolean;
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
      className="relative z-10 -mx-1 inline-flex max-w-full items-center rounded-(--radius-control) px-1 py-0.5 text-left hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
    >
      {children}
    </button>
  );
}

// The open editor wrapper — also above the row link, and swallows clicks so a
// pick inside the picker never bubbles to the row navigation.
function EditSurface({ children }: { children: ReactNode }) {
  return (
    <span className="relative z-10 block w-full" onClick={(e) => e.stopPropagation()}>
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
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  // `undefined` = no pending edit; `{ id }` = optimistic value (id may be null
  // for an unassign). The cell is keyed by `row.assigneeId` (see
  // InlineAssigneeCell), so the editor remounts (clearing the override) once the
  // server value lands — no setState-in-effect. On failure it's dropped here.
  const [override, setOverride] = useState<{ id: string | null } | undefined>(undefined);

  const assigneeId = override ? override.id : row.assigneeId;
  const member = assigneeId ? members.find((m) => m.userId === assigneeId) : undefined;
  const name = member ? member.name || member.email : null;

  function commit(userId: string | null) {
    setEditing(false);
    if (userId === assigneeId) return;
    setOverride({ id: userId });
    startTransition(async () => {
      const res = await updateIssueAction({
        id: row.id,
        expectedUpdatedAt: row.updatedAt,
        assigneeId: userId,
      });
      if (res.ok) {
        router.refresh();
      } else if (res.stale) {
        setOverride(undefined);
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
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

/** STATUS cell — inline-editable inside a provider, else the read-only pill. */
export function InlineStatusCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <StatusValue category={row.statusCategory} label={row.statusLabel} />;
  // Key by the authoritative status so a server change remounts the editor and
  // discards a stale optimistic override (the no-effect reconcile).
  return <InlineStatusEditor key={row.status} row={row} workflow={ctx.workflow} />;
}

/** ASSIGNEE cell — inline-editable inside a provider, else the read-only value. */
export function InlineAssigneeCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <AssigneeValue name={row.assigneeName} />;
  // Key by the authoritative assignee so a server change remounts the editor and
  // discards a stale optimistic override (the no-effect reconcile).
  return (
    <InlineAssigneeEditor
      key={row.assigneeId ?? '__unassigned__'}
      row={row}
      members={ctx.members}
    />
  );
}
