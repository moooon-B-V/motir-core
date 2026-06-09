'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ISSUE_TYPES, TYPES_REQUIRING_PARENT, type IssueType } from '@/lib/issues/parentRules';
import { useBacklogDnd } from './BacklogDndProvider';

// The inline "+ Create issue" row (Story 4.2 · Subtask 4.2.5), per
// design/backlog/backlog.mock.html panel 1. PLACED in 4.2.3 (the read render),
// WIRED here: clicking it reveals an inline create form (a type picker + a title
// field) that calls the coordinator's `createInto` → 4.2.2 `createBacklogIssue`,
// creating straight into the backlog (`sprintId == null`, rank-appended) or this
// sprint (assigned). On success the new row appears in place (the action appends
// it) and the form stays open for rapid entry (the Jira inline-create idiom);
// Escape / Cancel closes it.
//
// Types offered EXCLUDE subtask — it requires a parent (TYPES_REQUIRING_PARENT),
// which the flat backlog create can't supply (it would 422). Defaults to Story.

const CREATE_TYPES: IssueType[] = ISSUE_TYPES.filter((k) => !TYPES_REQUIRING_PARENT.has(k));

export function CreateIssueRow({ sprintId = null }: { sprintId?: string | null }) {
  const t = useTranslations('backlog');
  const tl = useTranslations('labels');
  const { createInto } = useBacklogDnd();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<IssueType>('story');
  const [typeOpen, setTypeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset() {
    setEditing(false);
    setTitle('');
    setKind('story');
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await createInto({ kind, title: trimmed, sprintId });
    setBusy(false);
    if (ok) setTitle(''); // keep the form open for rapid entry
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        data-testid={sprintId ? `create-issue-sprint-${sprintId}` : 'create-issue-backlog'}
        className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm font-medium text-(--el-link) hover:bg-(--el-surface-soft)"
      >
        <Plus className="h-4 w-4 shrink-0" aria-hidden />
        {t('createIssue')}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      {/* Type picker — a compact Popover over the parent-free issue types. */}
      <Popover open={typeOpen} onOpenChange={setTypeOpen}>
        <Popover.Trigger
          aria-label={t('createIssueType', { type: tl(`issueType.${kind}`) })}
          data-testid="create-issue-type"
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <IssueTypeIcon type={kind} className="h-4 w-4" />
        </Popover.Trigger>
        <Popover.Content width={180} align="start" className="p-1">
          <div role="menu" aria-label={t('createIssueTypeMenu')}>
            {CREATE_TYPES.map((k) => (
              <button
                key={k}
                type="button"
                role="menuitemradio"
                aria-checked={k === kind}
                onClick={() => {
                  setKind(k);
                  setTypeOpen(false);
                }}
                className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none"
              >
                <IssueTypeIcon type={k} className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{tl(`issueType.${k}`)}</span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover>

      {/* Focused on open — the inline form opens on an explicit click, so the
          field is the expected next step (the board's inline editors do the same). */}
      <input
        type="text"
        autoFocus
        value={title}
        placeholder={t('createIssuePlaceholder')}
        aria-label={t('createIssueTitleLabel')}
        data-testid="create-issue-input"
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            reset();
          }
        }}
        className="h-(--height-control) min-w-0 flex-1 rounded-(--radius-input) border border-(--el-border-strong) bg-(--el-page-bg) px-(--spacing-control-x) font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
      />

      <Button size="sm" variant="primary" loading={busy} onClick={() => void submit()}>
        {t('createIssueSubmit')}
      </Button>
      <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
        {t('createIssueCancel')}
      </Button>
    </div>
  );
}
