'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { displayKey } from '@/lib/shortcuts';
import { Tooltip } from '@/components/ui/Tooltip';
import { useCreateIssue } from './CreateIssueProvider';
import { useProjectAccess } from './ProjectAccessProvider';

/**
 * CreateIssueButton — the top-nav "+" affordance that opens the create-issue
 * modal (Subtask 2.3.3). One of three entry points; the open state + the "C"
 * key binding live in CreateIssueProvider (consumed via `useCreateIssue`). The
 * trailing chip mirrors the global shortcut so the keyboard path is
 * discoverable, matching the CommandPaletteTrigger's treatment.
 *
 * Hidden when there's no active project (`canCreate` false) — an issue needs a
 * project to belong to, and the modal isn't mounted in that state.
 */
export function CreateIssueButton() {
  const t = useTranslations('shell');
  const ta = useTranslations('projectAccess');
  const { openCreateIssue, canCreate } = useCreateIssue();
  const { canEdit } = useProjectAccess();
  if (!canCreate) return null;

  const base =
    'inline-flex h-9 items-center gap-2 rounded-(--radius-sm) border border-(--el-border) px-2.5 font-sans text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

  // Read-only (a viewer, or a member on a limited project): keep the affordance
  // VISIBLE but disabled with an explanatory tooltip, rather than hiding it —
  // the 6.4.6 role-affordance treatment (design 6.4.1).
  if (!canEdit) {
    return (
      <Tooltip content={ta('readOnlyHint')}>
        <span
          aria-disabled
          aria-label={t('createIssue.title')}
          className={`${base} text-(--el-text-faint) cursor-not-allowed opacity-60`}
        >
          <Plus className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">{t('createIssue.create')}</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={openCreateIssue}
      aria-keyshortcuts="C"
      aria-label={t('createIssue.title')}
      className={`${base} text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)`}
    >
      <Plus className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{t('createIssue.create')}</span>
      <kbd className="hidden rounded-(--radius-xs) border border-(--el-border) px-1 py-0.5 font-mono text-[10px] sm:inline">
        {displayKey('C')}
      </kbd>
    </button>
  );
}
