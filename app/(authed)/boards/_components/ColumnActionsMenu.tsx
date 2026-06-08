'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Check, CircleGauge, Columns3, MoreHorizontal, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';

// ColumnActionsMenu (Subtask 3.3.6) — the column `[⋯]` menu, per
// `design/boards/swimlanes-wip.mock.html` (panel 5) + the "Swimlanes + WIP"
// design notes. The 3.2.3 header reserved a DISABLED `[⋯]` seam; this fills it
// with the board-config action this subtask owns: **Set WIP limit**.
//
// The "Set WIP limit" item reveals an inline editor (a non-negative integer
// field, clearable). Saving hands the parsed limit up to `onSetWipLimit`
// (BoardContainer PATCHes `…/board/columns/[id]` 3.3.3 + reconciles
// optimistically); Clear hands up `null` (remove the limit). Validation mirrors
// the service — a negative / non-integer / empty entry is BLOCKED client-side
// with the error copy and `onSetWipLimit` is not called.
//
// The menu also carries (Subtask 3.6.3) a **"Board settings →"** link to
// `settings/project/board` — the board-configuration admin (column manager +
// status mapping). The 3.2.1 mock drew this column `[⋯]` entry as a seam; 3.6.3
// wires it now that the admin surface exists.
//
// Shape via element tokens (`--radius-control`/`-input`, `--height-control`,
// `--spacing-control-x`); colour strictly `--el-*`. Reuses the shipped `Popover`
// (the menu primitive) + `Button`.

const VALID_LIMIT = /^\d+$/; // non-negative integer (no sign, no decimal, no exponent)

export function ColumnActionsMenu({
  columnId,
  wipLimit,
  onSetWipLimit,
}: {
  columnId: string;
  wipLimit: number | null;
  onSetWipLimit: (columnId: string, limit: number | null) => void;
}) {
  const t = useTranslations('boards');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setEditing(false);
    setDraft('');
    setError(null);
  }

  function startEditing() {
    setDraft(wipLimit != null ? String(wipLimit) : '');
    setError(null);
    setEditing(true);
  }

  function save() {
    const trimmed = draft.trim();
    if (!VALID_LIMIT.test(trimmed)) {
      setError(t('wipInvalid'));
      return;
    }
    onSetWipLimit(columnId, Number(trimmed));
    setOpen(false);
    reset();
  }

  function clear() {
    onSetWipLimit(columnId, null);
    setOpen(false);
    reset();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Popover.Trigger
        aria-label={t('columnActions')}
        data-testid={`board-column-actions-${columnId}`}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      {/* p-0 on the rounded, overflow-hidden Popover content; the items live in
          an inner padded container so a glyph never sits in the clipped corner
          arc (the UserMenu / IssueFilterBar / Combobox menu idiom). */}
      <Popover.Content width={248} align="end" className="p-0">
        <div className="p-1">
          <button
            type="button"
            onClick={startEditing}
            aria-current={editing || undefined}
            className={`flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) ${
              editing ? 'bg-(--el-muted)' : ''
            }`}
          >
            <CircleGauge className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="flex-1 truncate">{t('setWipLimit')}</span>
          </button>

          <Link
            href="/settings/project/board"
            data-testid={`board-column-settings-link-${columnId}`}
            className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <Columns3 className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <span className="flex-1 truncate">{t('columnActionsBoardSettings')} →</span>
          </Link>

          {editing ? (
            <>
              <div className="mx-1 my-1.5 h-px bg-(--el-border)" />
              <div className="px-(--spacing-control-x) pb-1.5">
                <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
                  {t('wipLimitLabel')}
                </p>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  autoFocus
                  value={draft}
                  aria-label={t('wipFieldAria')}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      save();
                    }
                  }}
                  data-testid={`board-wip-input-${columnId}`}
                  className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) font-sans text-sm text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                {error ? (
                  <p
                    role="alert"
                    data-testid={`board-wip-error-${columnId}`}
                    className="mt-1.5 rounded-(--radius-control) bg-(--el-tint-rose) px-2 py-1 text-[11.5px] text-(--el-text-strong)"
                  >
                    {error}
                  </p>
                ) : null}
                <div className="mt-2 flex justify-end gap-1.5">
                  <Button size="sm" variant="secondary" leftIcon={<X />} onClick={clear}>
                    {t('wipClear')}
                  </Button>
                  <Button size="sm" variant="primary" leftIcon={<Check />} onClick={save}>
                    {t('wipSave')}
                  </Button>
                </div>
                <p className="mt-2 text-[11.5px] leading-snug text-(--el-text-muted)">
                  {t('wipHint')}
                </p>
              </div>
            </>
          ) : null}
        </div>
      </Popover.Content>
    </Popover>
  );
}
