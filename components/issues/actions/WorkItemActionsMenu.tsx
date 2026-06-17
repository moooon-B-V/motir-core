'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Copy, Goal, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { DeleteWorkItemDialog } from './DeleteWorkItemDialog';
import {
  archiveWorkItem,
  setWorkItemSprint,
  unarchiveWorkItem,
  WorkItemActionError,
} from './workItemActionsClient';

// The shared work-item ⋯ actions menu (Story 2.8 · Subtask 2.8.4), per
// design/work-items/delete-confirm.mock.html panels 0–1 — IDENTICAL on the
// detail header, list rows, and board cards. The shipped `Popover` (no
// hand-rolled menu), keyboard-operable. Order: `Edit details` · `Copy link` · —
// · `Archive` · `Delete…`. Permission-gated, Jira-faithfully: `Edit`/`Archive`
// need `canEdit`; `Delete` needs `canManage` (project admin). A user without a
// capability does NOT see that row (hidden, never shown-disabled); a viewer with
// neither collapses to just `Copy link`. Delete is the only danger-coloured row
// and opens the 2.8.4 confirm dialog; Archive (reversible) runs inline with an
// Undo toast (the only restore path until an archived-items view ships).
//
// The `archived` prop (Story 2.9 · Subtask 2.9.11, per delete-confirm.mock.html
// §2.9.7 "On the DETAIL page — panel 8") puts the menu in its ARCHIVED-item
// mode: the `canEdit` row swaps Archive→Restore (runs the same `runUnarchive`
// the Undo toast uses, inline), and `Delete…` opens the ARCHIVED variant of the
// confirm dialog (2.9.10 — no Archive escape-hatch + the live-descendant
// warning). Defaults to `false`, so the active surfaces are byte-for-byte
// unchanged. The host surface passes `archived` from its read.

const ITEM_CLASS =
  'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none disabled:opacity-50';

// Exported so single-action surfaces (e.g. the archived-list row's Delete-only
// `⋯` menu, Subtask 2.9.5) reuse the SAME danger-row + trigger vocabulary as the
// full menu — one source of truth, no token drift.
export const MENU_DANGER_ITEM_CLASS =
  'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-danger) hover:bg-(--el-tint-rose) focus-visible:bg-(--el-tint-rose) focus-visible:outline-none';

export const MENU_TRIGGER_CLASS =
  'inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function WorkItemActionsMenu({
  itemId,
  identifier,
  title,
  canEdit,
  canManage,
  archived = false,
  onDeleted,
  onArchived,
  activeSprintId = null,
  activeSprintName = null,
  inActiveSprint = false,
  onSprintChanged,
  editHref,
  align = 'end',
  triggerClassName,
}: {
  itemId: string;
  /** The `PROD-N` key — used for the link, the menu label, and toasts. */
  identifier: string;
  title: string;
  /** Edit + Archive/Restore gate (the project EDIT capability). */
  canEdit: boolean;
  /** Delete gate (the project-admin MANAGE capability). */
  canManage: boolean;
  /**
   * ARCHIVED-item mode (Story 2.9 · Subtask 2.9.11). When true the `canEdit`
   * row is **Restore** (not Archive) and `Delete…` opens the archived confirm
   * variant. Defaults to `false` — the active behaviour is unchanged.
   */
  archived?: boolean;
  /** Run after a successful delete — the surface navigates away / refetches. */
  onDeleted: () => void;
  /** Run after a successful archive or restore — the surface refetches. */
  onArchived: () => void;
  /**
   * "Add to active sprint" (Subtask 2.4.14) — the project's currently-active
   * sprint id (the assign target) and name (the toast), plus whether THIS item
   * is already in it. The row appears ONLY when a host passes `onSprintChanged`
   * (the detail header); list rows / board cards omit it, so they are
   * byte-unchanged until a later subtask opts them in. Gated on `canEdit`
   * (hidden otherwise — the permission law); when shown but `!activeSprintId`
   * or `inActiveSprint`, the row is DISABLED + a Tooltip (the transient
   * STATE-gate deviation — design/work-items/sprint-field.mock.html panel 3).
   */
  activeSprintId?: string | null;
  activeSprintName?: string | null;
  inActiveSprint?: boolean;
  /** Refetch the surface after the item joins the active sprint. */
  onSprintChanged?: () => void;
  /** Override the edit destination (defaults to the issue's edit route). */
  editHref?: string;
  align?: 'start' | 'center' | 'end';
  /** Override the trigger button styling for a given surface's placement. */
  triggerClassName?: string;
}) {
  const t = useTranslations('workItemActions');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [addingToSprint, setAddingToSprint] = useState(false);

  const href = editHref ?? `/issues/${identifier}/edit`;
  const menuLabel = t('menuLabel', { key: identifier });

  async function copyLink() {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/issues/${identifier}`);
      toast({ variant: 'success', title: t('linkCopied') });
    } catch {
      // Clipboard blocked (insecure context / denied permission) — silently
      // no-op rather than surface a confusing error for a convenience action.
    }
  }

  async function runUnarchive() {
    setRestoring(true);
    try {
      await unarchiveWorkItem(itemId);
      toast({ variant: 'success', title: t('restoredToast', { key: identifier }) });
      onArchived();
    } catch (err) {
      void (err instanceof WorkItemActionError);
      toast({
        variant: 'error',
        title: t('restoreErrorTitle'),
        description: t('archiveErrorBody'),
      });
    } finally {
      setRestoring(false);
    }
  }

  async function runArchive() {
    setOpen(false);
    setArchiving(true);
    try {
      await archiveWorkItem(itemId);
      toast({
        variant: 'success',
        title: t('archivedToast', { key: identifier }),
        action: { label: t('undo'), onClick: () => void runUnarchive() },
      });
      onArchived();
    } catch (err) {
      void (err instanceof WorkItemActionError);
      toast({
        variant: 'error',
        title: t('archiveErrorTitle'),
        description: t('archiveErrorBody'),
      });
    } finally {
      setArchiving(false);
    }
  }

  // "Add to active sprint" — one-click assign into the project's active sprint
  // via the shared assign route (4.1.4). Shown only when the host opts in
  // (onSprintChanged passed) and the actor canEdit; enabled only when an active
  // sprint exists and the item isn't already in it (else the row is a disabled
  // STATE-gate, below).
  const showSprintRow = canEdit && !archived && onSprintChanged != null;
  const sprintReason = !activeSprintId
    ? t('noActiveSprint')
    : inActiveSprint
      ? t('alreadyInActiveSprint')
      : null;

  async function runAddToActiveSprint() {
    if (!activeSprintId || inActiveSprint) return;
    setOpen(false);
    setAddingToSprint(true);
    try {
      await setWorkItemSprint(itemId, activeSprintId);
      toast({
        variant: 'success',
        title: t('addedToSprintToast', { key: identifier, sprint: activeSprintName ?? '' }),
      });
      onSprintChanged?.();
    } catch (err) {
      void (err instanceof WorkItemActionError);
      toast({
        variant: 'error',
        title: t('addToSprintErrorTitle'),
        description: t('archiveErrorBody'),
      });
    } finally {
      setAddingToSprint(false);
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={menuLabel}
          // The trigger is a sibling control of the row/card — stop the
          // pointer-down/click from reaching a drag listener or row selection
          // (board card / list row), mirroring the backlog RowActionsMenu.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={triggerClassName ?? MENU_TRIGGER_CLASS}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Content width={232} align={align} className="p-0">
          <div className="p-1" role="menu" aria-label={menuLabel}>
            {canEdit ? (
              // A plain anchor (not router.push) so the menu carries no
              // app-router hook dependency — it mounts inside board cards / list
              // rows everywhere, and Edit navigates to a separate page anyway.
              <a href={href} role="menuitem" className={ITEM_CLASS} onClick={() => setOpen(false)}>
                <Pencil className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                {t('editDetails')}
              </a>
            ) : null}

            {/* Add to active sprint (2.4.14) — after Edit details. Enabled when an
                active sprint exists and the item isn't in it; otherwise a DISABLED
                state-gate row (opacity-50, no hover) carrying a Tooltip with the
                reason. !canEdit hides it (the permission law, above). */}
            {showSprintRow ? (
              sprintReason ? (
                <Tooltip content={sprintReason}>
                  <div
                    role="menuitem"
                    aria-disabled="true"
                    tabIndex={0}
                    className="flex h-(--height-control) w-full cursor-default items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) opacity-50 focus-visible:outline-none"
                  >
                    <Goal className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                    {t('addToActiveSprint')}
                  </div>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  disabled={addingToSprint}
                  onClick={() => void runAddToActiveSprint()}
                >
                  <Goal className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                  {t('addToActiveSprint')}
                </button>
              )
            ) : null}

            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              onClick={() => void copyLink()}
            >
              <Copy className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              {t('copyLink')}
            </button>

            {canEdit || canManage ? (
              <div className="mx-1 my-1 h-px bg-(--el-border)" role="separator" />
            ) : null}

            {canEdit ? (
              archived ? (
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  disabled={restoring}
                  onClick={() => {
                    setOpen(false);
                    void runUnarchive();
                  }}
                >
                  <RotateCcw className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                  {t('restore')}
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={ITEM_CLASS}
                  disabled={archiving}
                  onClick={() => void runArchive()}
                >
                  <Archive className="h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
                  {t('archive')}
                </button>
              )
            ) : null}

            {canManage ? (
              <button
                type="button"
                role="menuitem"
                className={MENU_DANGER_ITEM_CLASS}
                onClick={() => {
                  setOpen(false);
                  setDialogOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                {t('delete')}
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover>

      {dialogOpen ? (
        <DeleteWorkItemDialog
          itemId={itemId}
          identifier={identifier}
          title={title}
          archived={archived}
          onClose={() => setDialogOpen(false)}
          onDeleted={() => {
            setDialogOpen(false);
            onDeleted();
          }}
          // The archived variant has no "Archive instead" escape-hatch (the item
          // is already archived) — omit the handler so the dialog drops the row.
          onArchiveInstead={
            archived
              ? undefined
              : () => {
                  setDialogOpen(false);
                  void runArchive();
                }
          }
        />
      ) : null}
    </>
  );
}
