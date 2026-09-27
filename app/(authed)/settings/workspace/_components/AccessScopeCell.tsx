'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronsUpDown, Lock, TriangleAlert } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import type { WorkspaceAccessScope } from '@/generated/prisma/client';
import type { MemberAddedProjectDTO, WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';
import {
  listMemberAddedProjectsAction,
  openProjectAccessAction,
  setMemberAccessScopeAction,
} from '../actions';

// The Members page's ACCESS cell (Story MOTIR-6169 · MOTIR-6551 ·
// `design/workspaces/workspace-roles--access-scope.mock.html` W1–W6), beside the
// role column MOTIR-6465 built and sharing its conventions:
//
//   • a Manager row — a stored Manager, or an org Owner / Admin — shows a dashed,
//     locked "Full · Manager" chip whose reason is its Tooltip and aria-label:
//     scope is never read for a Manager (`canEnter`), so there is nothing to set;
//   • everyone else shows Full / Limited — the shipped Combobox for a Manager
//     viewer, the same shape as TEXT for anyone else (W6);
//   • a Limited row adds its "N projects" count, which opens a read-only popover
//     of those projects (W3, read when it opens), or at 0 a warning chip with a
//     row-help line saying what that means (W1).
//
// The scope is held by the row so a change repaints at once and reverts on a
// refusal (W5) — the page-state contract's case 1, like the role cell.

const SCOPES: readonly WorkspaceAccessScope[] = ['full', 'limited'];

export function AccessScopeCell({
  member,
  scope,
  onScopeChange,
  isManagerRow,
  canManage,
  workspaceName,
}: {
  member: WorkspaceMemberWithAccessDTO;
  /** The scope the row SHOWS — held by the row, which also draws the help line. */
  scope: WorkspaceAccessScope;
  onScopeChange: (scope: WorkspaceAccessScope) => void;
  /** The row's person is a Manager (stored, or by the org) — the locked chip. */
  isManagerRow: boolean;
  /** The VIEWER may change scopes (a Manager). */
  canManage: boolean;
  workspaceName: string;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const setScope = onScopeChange;

  if (isManagerRow) {
    const reason = t('members.scopeLockedReason');
    return (
      <Tooltip content={reason}>
        <span
          tabIndex={0}
          aria-label={`${t('members.scopeLockedManager')}: ${reason}`}
          className="border-(--el-border-strong) text-(--el-text-secondary) h-(--height-control) rounded-(--radius-input) px-(--spacing-control-x) inline-flex items-center gap-1.5 border border-dashed font-sans text-xs"
        >
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('members.scopeLockedManager')}
        </span>
      </Tooltip>
    );
  }

  const options: ComboboxOption<string>[] = SCOPES.map((s) => ({
    value: s,
    label: t(`members.scope.${s}`),
    description: t(`members.scopeDesc.${s}`),
  }));
  const selectLabel = t('members.scopeSelectLabel', { name: member.name });

  function pick(next: string) {
    const nextScope = next as WorkspaceAccessScope;
    if (nextScope === scope) return;
    const previous = scope;
    setScope(nextScope);
    startTransition(async () => {
      const result = await setMemberAccessScopeAction(member.userId, nextScope);
      if (result.ok) {
        toast({
          variant: 'success',
          title:
            nextScope === 'full'
              ? t('members.scopeChangedFull', { name: member.name, workspace: workspaceName })
              : t('members.scopeChangedLimited', { name: member.name }),
        });
        return;
      }
      setScope(previous);
      toast({
        variant: 'error',
        title: t('members.scopeChangeErrorTitle', { name: member.name }),
        description:
          result.code === 'SCOPE_NOT_APPLICABLE'
            ? t('members.scopeNotApplicableBody', { name: member.name })
            : result.error,
      });
    });
  }

  return (
    <div className="flex items-center gap-2">
      <div className="w-[7.25rem] shrink-0" data-testid={`member-access-${member.userId}`}>
        {canManage ? (
          <Combobox
            options={options}
            value={scope}
            onChange={pick}
            label={selectLabel}
            loading={pending}
            disabled={pending}
          />
        ) : (
          <Tooltip content={t('members.rolesManagerOnly')}>
            <span
              tabIndex={0}
              aria-label={`${selectLabel}: ${t(`members.scope.${scope}`)}`}
              className="border-(--el-border) bg-(--el-surface) text-(--el-text-secondary) h-(--height-control) rounded-(--radius-input) px-(--spacing-control-x) flex w-full items-center justify-between gap-1 border font-sans text-sm"
            >
              <span className="truncate">{t(`members.scope.${scope}`)}</span>
              <ChevronsUpDown className="text-(--el-text-faint) h-3.5 w-3.5 shrink-0" aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>
      {scope === 'limited' ? (
        member.addedProjectCount > 0 ? (
          <ProjectsPopover member={member} />
        ) : (
          <Pill className="bg-(--el-warning-surface) text-(--el-text-strong) shrink-0 border-transparent">
            <TriangleAlert className="h-3 w-3" aria-hidden />
            {t('members.noProjects')}
          </Pill>
        )
      ) : null}
    </div>
  );
}

/** The 0-projects row-help line (W1) — rendered by the row, under its cells. */
export function NoProjectsHelp({ name, workspaceName }: { name: string; workspaceName: string }) {
  const t = useTranslations('settings');
  return (
    <p className="text-(--el-text-secondary) flex items-center gap-1.5 pl-11 font-sans text-xs">
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {t('members.noProjectsHelp', { name, workspace: workspaceName })}
    </p>
  );
}

// "N projects" open (W3): a read-only list of the projects the person was added
// to, each a door to that project's Access & members page, read when opened.
function ProjectsPopover({ member }: { member: WorkspaceMemberWithAccessDTO }) {
  const t = useTranslations('settings');
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<MemberAddedProjectDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    startLoading(async () => {
      const result = await listMemberAddedProjectsAction(member.userId);
      if (result.ok) {
        setProjects(result.projects);
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="text-(--el-link) hover:text-(--el-link-pressed) shrink-0 font-sans text-xs underline underline-offset-2"
        >
          {t('members.projectCount', { count: member.addedProjectCount })}
        </button>
      </Popover.Trigger>
      <Popover.Content align="start" width={280} className="py-1">
        <div className="px-3 pb-1 pt-2">
          <span className="text-(--el-text-secondary) font-mono text-xs uppercase tracking-wider">
            {t('members.projectsPopoverTitle', { name: member.name })}
          </span>
        </div>
        {loading && projects === null ? (
          <p className="text-(--el-text-secondary) px-3 py-2 font-sans text-sm">…</p>
        ) : error ? (
          <p className="text-(--el-danger-on-surface) px-3 py-2 font-sans text-sm">{error}</p>
        ) : (
          <ul role="list" className="px-1">
            {(projects ?? []).map((p) => (
              <li key={p.id}>
                <form action={openProjectAccessAction.bind(null, p.identifier)}>
                  <button
                    type="submit"
                    className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none"
                  >
                    <span className="truncate font-sans text-sm text-(--el-text)">{p.name}</span>
                    <span className="text-(--el-text-secondary) shrink-0 font-mono text-xs">
                      {p.identifier}
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="border-(--el-border-soft) text-(--el-text-secondary) mt-1 border-t px-3 pb-1 pt-2 font-sans text-xs">
          {t('members.projectsPopoverFoot', { name: member.name })}
        </p>
      </Popover.Content>
    </Popover>
  );
}
