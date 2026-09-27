'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, TriangleAlert, Users } from 'lucide-react';
import { MultiSelectPicker, type MultiSelectOption } from '@/components/ui/MultiSelectPicker';
import type { WorkspaceAccessScope } from '@/generated/prisma/client';
import type { MemberAddedProjectDTO } from '@/lib/dto/workspaces';

// The invite's ACCESS choice (Story MOTIR-6169 · MOTIR-6551 ·
// `design/workspaces/workspace-roles--access-scope.mock.html` W7 / W8): two
// compact radio cards in the project mode control's markup (Full · Limited), and
// — for Limited — the shipped `MultiSelectPicker` over the Manager's projects.
// An empty pick is allowed and warned about; a send-time refusal renders as the
// picker's field error. Offered to a Manager only: a Full non-Manager sends Full
// invites, and the modal draws no choice for them (W9).

const SCOPE_ICON: Record<WorkspaceAccessScope, typeof Users> = { full: Users, limited: Lock };
const SCOPE_TINT: Record<WorkspaceAccessScope, string> = {
  full: 'bg-(--el-tint-mint)',
  limited: 'bg-(--el-tint-lavender)',
};

export function InviteAccessFields({
  scope,
  onScopeChange,
  projects,
  projectIds,
  onProjectIdsChange,
  error,
  disabled = false,
}: {
  scope: WorkspaceAccessScope;
  onScopeChange: (scope: WorkspaceAccessScope) => void;
  projects: MemberAddedProjectDTO[];
  projectIds: string[];
  onProjectIdsChange: (ids: string[]) => void;
  /** A send-time refusal about the projects (MOTIR-6546), as the picker's error. */
  error?: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('settings.members');
  const [query, setQuery] = useState('');

  const asOption = (p: MemberAddedProjectDTO): MultiSelectOption => ({
    id: p.id,
    label: `${p.name} · ${p.identifier}`,
  });
  const selected = useMemo(
    () => projects.filter((p) => projectIds.includes(p.id)).map(asOption),
    [projects, projectIds],
  );
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => !q || `${p.name} ${p.identifier}`.toLowerCase().includes(q))
      .map(asOption);
  }, [projects, query]);

  function toggle(option: MultiSelectOption) {
    onProjectIdsChange(
      projectIds.includes(option.id)
        ? projectIds.filter((id) => id !== option.id)
        : [...projectIds, option.id],
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t('inviteAccessLabel')} className="flex flex-col gap-1.5">
        <span className="font-sans text-sm font-medium text-(--el-text)" aria-hidden>
          {t('inviteAccessLabel')}
        </span>
        {(['full', 'limited'] as const).map((s) => {
          const Icon = SCOPE_ICON[s];
          const checked = scope === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => onScopeChange(s)}
              className={`focus-visible:ring-(--focus-ring-color) rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) flex items-center gap-3 border text-left focus-visible:outline-none focus-visible:ring-2 ${
                checked ? 'border-(--el-accent)' : 'border-(--el-border)'
              }`}
            >
              <span
                className={`text-(--el-text-strong) inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) ${SCOPE_TINT[s]}`}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
              <span className="flex-1">
                <span className="block font-sans text-sm font-medium text-(--el-text)">
                  {t(`scope.${s}`)}
                </span>
                <span className="text-(--el-text-secondary) block font-sans text-xs">
                  {s === 'full' ? t('inviteAccessFullDesc') : t('inviteAccessLimitedDesc')}
                </span>
              </span>
              <span
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  checked ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                }`}
                aria-hidden
              >
                {checked ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
              </span>
            </button>
          );
        })}
      </div>

      {scope === 'limited' ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-sans text-sm font-medium text-(--el-text)" aria-hidden>
            {t('inviteProjectsLabel')}
          </span>
          <MultiSelectPicker
            values={selected}
            options={options}
            onToggle={toggle}
            onRemove={toggle}
            query={query}
            onQueryChange={setQuery}
            label={t('inviteProjectsLabel')}
            placeholder={t('inviteProjectsPlaceholder')}
            removeLabel={(label) => t('inviteProjectsRemove', { project: label })}
            hint={t('inviteProjectsHint')}
            error={error}
            disabled={disabled}
          />
          {projectIds.length === 0 ? (
            <p className="bg-(--el-warning-surface) text-(--el-text-strong) rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) flex items-start gap-2 font-sans text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('inviteNoProjectsWarning')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
