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
// · `Archive` · `Delete…`. Permission-gated, Jira-faithfully: `Edit` needs
// `canEdit`; `Archive`/`Restore` need `canArchive`; `Delete` needs `canDelete`.
//
// ⚠️ ARCHIVE HAS ITS OWN GATE NOW (MOTIR-3629), and it did not before: the row
// was drawn on `canEdit` while `archiveWorkItem` asserted `work_item:delete`, so
// a MEMBER — who holds edit and not delete — was offered an Archive row that
// 403'd on click. `work_item:archive` is the key that makes the affordance
// tellable: `member` holds it, so the row is now offered to exactly the actors
// the service admits. A user without a
// capability does NOT see that row (hidden, never shown-disabled); a viewer with
// neither collapses to just `Copy link`. Delete is the only danger-coloured row
// and opens the 2.8.4 confirm dialog; Archive (reversible) runs inline with an
// Undo toast (the only restore path until an archived-items view ships).
//
// The `archived` prop (Story 2.9 · Subtask 2.9.11, per delete-confirm.mock.html
// §2.9.7 "On the DETAIL page — panel 8") puts the menu in its ARCHIVED-item
// mode: the `canArchive` row swaps Archive→Restore (runs the same `runUnarchive`
// the Undo toast uses, inline), and `Delete…` opens the ARCHIVED variant of the
// confirm dialog (2.9.10 — no Archive escape-hatch + the live-descendant
// warning). Defaults to `false`, so the active surfaces are byte-for-byte
// unchanged. The host surface passes `archived` from its read.
//
// ⚠️ THIS MENU CARRIES NO PLAN DOORS ANY MORE (MOTIR-4258). It used to take a
// `planEdits` bundle and draw an `Expand` / `Re-plan` row from the shared
// `planEntranceFace` rule (MOTIR-903 · MOTIR-2097), opening the IN-PLACE
// plan-edits dock. Exactly ONE of this menu's five mounts ever passed that
// bundle — the `/items` row's own actions cell — and MOTIR-4258 removed
// that row's ⋯ entirely, which left the prop, the face derivation and both rows
// reachable from nowhere. They are deleted rather than kept warm: an optional
// prop no host passes is indistinguishable from a live one to the next reader.
//
// The per-item plan door that SURVIVES is `WorkItemPlanEntrance`
// (`components/planning/WorkItemPlanEntrance.tsx`, MOTIR-910) — the Plan /
// Re-plan pill on the detail-page header and the quick-view peek, which reads
// the SAME `planEntranceFace` rule and opens the universal planning workspace.
// That is the direction the product had already chosen when MOTIR-1731 retired
// the one-shot `Augment from prompt` button: changing a plan is a CONVERSATION,
// so the entrance is the workspace, not a per-surface control. What has no
// entrance left at all is the in-place dock's RE-PLAN job — see MOTIR-4261.

export const ITEM_CLASS =
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
  canArchive,
  canDelete,
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
  /** Edit gate — `work_item:edit`, the project EDIT capability. */
  canEdit: boolean;
  /**
   * Whether the actor may ARCHIVE or RESTORE a work item — `work_item:archive`,
   * the key `workItemsService.archiveWorkItem` / `unarchiveWorkItem` assert.
   *
   * ⚠️ ADDED BY MOTIR-3629, and its absence was a live mis-gate. Archive and
   * Restore were drawn on `canEdit` while the service asserted
   * `work_item:delete`, so the menu offered a MEMBER (edit yes, delete no) a row
   * that 403'd. There was no correct prop to pass: one key spanned the
   * reversible hide and the irreversible subtree destroy, so gating on it would
   * have hidden Archive from every member instead. The catalog now carries both
   * terms and `member` holds the archive one, so this prop can tell the truth.
   *
   * It is REQUIRED rather than defaulted: every host reads a permission set
   * already, and a default would let the next surface silently inherit whichever
   * answer happened to be convenient — which is how the first mis-gate lasted.
   */
  canArchive: boolean;
  /**
   * Whether the actor may DELETE a work item — `work_item:delete`, the key
   * `workItemsService.deleteWorkItem` (`:2267`) actually asserts.
   *
   * ⚠️ RENAMED FROM `canManage` BY MOTIR-2473, and the rename is the finding.
   * It used to carry *administers the project* (`project:administer`), because
   * when this menu was built there was no permission for deleting a work item.
   * There has been one since MOTIR-2291, and it does not belong to the same
   * people — the three built-in roles merely happen to make the two answers
   * agree, which is the shape of a defect waiting for the feature that separates
   * them.
   */
  canDelete: boolean;
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

  const href = editHref ?? `/items/${identifier}/edit`;
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

            {canArchive || canDelete ? (
              <div className="mx-1 my-1 h-px bg-(--el-border)" role="separator" />
            ) : null}

            {canArchive ? (
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

            {canDelete ? (
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
          //
          // ⚠️ AND NEITHER DOES AN ACTOR WITHOUT `canArchive` (MOTIR-3629). The
          // escape-hatch runs `runArchive`, so offering it to someone the archive
          // gate refuses would put the 403 this card removed back inside the
          // delete dialog. In practice the condition holds for every real actor —
          // `work_item:delete` CONFERS `work_item:archive` at resolution — which
          // is exactly why it is worth testing rather than assuming: the prop is
          // supplied by the host, and the invariant lives in the server's
          // resolution, not in this component.
          onArchiveInstead={
            archived || !canArchive
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
