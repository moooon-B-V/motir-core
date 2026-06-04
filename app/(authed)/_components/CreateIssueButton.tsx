'use client';

import { Plus } from 'lucide-react';
import { displayKey } from '@/lib/shortcuts';
import { useCreateIssue } from './CreateIssueProvider';

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
  const { openCreateIssue, canCreate } = useCreateIssue();
  if (!canCreate) return null;

  return (
    <button
      type="button"
      onClick={openCreateIssue}
      aria-keyshortcuts="C"
      aria-label="Create issue"
      className="text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-(--focus-ring-color) inline-flex h-9 items-center gap-2 rounded-(--radius-sm) border border-(--el-border) px-2.5 font-sans text-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
    >
      <Plus className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">Create</span>
      <kbd className="hidden rounded-(--radius-xs) border border-(--el-border) px-1 py-0.5 font-mono text-[10px] sm:inline">
        {displayKey('C')}
      </kbd>
    </button>
  );
}
