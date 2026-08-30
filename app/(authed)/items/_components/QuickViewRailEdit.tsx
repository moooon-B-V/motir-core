'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Check, CircleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { QuickViewData } from '@/lib/dto/quickView';
import {
  updateIssueAction,
  type IssueActionResult,
  type UpdateIssueInput,
} from '../[key]/edit/actions';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { serverActionRejectionKey } from '@/lib/utils/serverActionRejection';

// The quick-view rail's EDIT chrome (MOTIR-2563), built to
// design/work-items/quick-view.mock.html panels 7-9 + 12.
//
// The detail rail hangs its edit chevron in `FieldCard` chrome. The peek's rail
// is a denser <dl> with no card to hang one in, so the design put the chevron
// INLINE ON THE CAPTION LINE, right-aligned: it costs no vertical space in a
// 300px column already carrying fifteen rows. It is ALWAYS rendered (at
// --el-text-faint, strengthening on hover/focus) rather than revealed on hover,
// because reveal-on-hover is unreachable on touch and invisible to a keyboard
// user. The chevron is a real <button aria-label="Edit <field>">, so the rail
// stays a <dl> and every control is individually tab-reachable.
//
// ── The write mechanics are COPIED, not re-derived ────────────────────────────
// Both rules below exist because they were got wrong before, and the reasoning
// is preserved at length in `IssueInlineEdit.tsx` and in the header of
// `app/(authed)/items/[key]/edit/actions.ts`:
//
//  1. A successful action response IS the confirmation. The optimistic value
//     STAYS and no route refresh runs on success. Refreshing per successful edit
//     shipped a full RSC snapshot per change; two quick edits raced and a stale
//     snapshot landing last repainted an unrelated row with its old value
//     (`bug-inline-status-revert-on-second-edit`).
//  2. The optimistic-concurrency token must ADVANCE. Every confirmed write
//     returns a new `updatedAt`; a second edit in the same session must submit
//     THAT, not the one the payload was fetched with, or it dies on the stale
//     check.
//
// ── Why this needs no cross-remount ledger, unlike the list ───────────────────
// `IssueInlineEdit` keeps its ledger on a PROVIDER because `TreeTable`
// virtualizes: a row scrolled out of the window unmounts and re-renders from a
// cache the edit never wrote into. The peek has no such problem — the panel is a
// single mount for the life of the peek session, and closing it is exactly when
// the state should be discarded. So component state is the correct scope here,
// and adding a provider would be inventing a mechanism for a failure this
// surface cannot have.

/** The rail fields this chrome can edit. Keyed for the pending/confirmed/error UI. */
export type RailEditKey =
  | 'priority'
  | 'workItemType'
  | 'executor'
  | 'dueDate'
  | 'estimate'
  | 'storyPoints'
  | 'status'
  | 'assignee'
  | 'sprint'
  | 'parent'
  | 'labels'
  | 'components';

export interface QuickViewRailEdit {
  /** True when the actor may edit at all — the whole affordance hangs off this. */
  canEdit: boolean;
  /**
   * The item as the rail should render it: served values + optimistic overrides.
   * Null only while the peek is still loading / not-found, since the hook is
   * called above the panel's early returns (hooks cannot be conditional).
   */
  effective: QuickViewData | null;
  /** Which row is open for editing, if any. */
  editing: RailEditKey | null;
  toggle: (key: RailEditKey) => void;
  close: () => void;
  pending: RailEditKey | null;
  confirmed: RailEditKey | null;
  errorFor: { key: RailEditKey; message: string } | null;
  /** True once someone else's write beat ours — the rail shows the reload notice. */
  stale: boolean;
  /**
   * Commit a patch through the shipped `updateIssueAction`, optimistically.
   * `optimistic` is what the rail should show immediately; `patch` is what the
   * server is asked for. Returns nothing — the UI reads the state above.
   */
  commit: (
    key: RailEditKey,
    optimistic: Partial<QuickViewData>,
    patch: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>,
  ) => Promise<void>;
  /** Commit through a caller-supplied action (status / sprint have their own). */
  commitVia: (
    key: RailEditKey,
    optimistic: Partial<QuickViewData>,
    run: () => Promise<IssueActionResult>,
  ) => Promise<void>;
}

/**
 * The rail's edit state machine for one peek session.
 *
 * `onEdited` is called ONCE, the first time a write is confirmed. The driver
 * uses it to decide whether the host surface behind the modal needs re-reading
 * when the peek closes — the design's decision (panel 12): re-read on CLOSE, not
 * per edit, and not at all if nothing changed.
 */
export function useQuickViewRailEdit(
  data: QuickViewData | null,
  onEdited?: () => void,
): QuickViewRailEdit {
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  // Only for the REJECTION message below — every other string on this rail is
  // rendered by the components, and a refusal arrives already translated from
  // the action.
  const t = useTranslations('issueViews');

  const [overrides, setOverrides] = useState<Partial<QuickViewData>>({});
  const [ackUpdatedAt, setAckUpdatedAt] = useState<string | null>(null);
  const [editing, setEditing] = useState<RailEditKey | null>(null);
  const [pending, setPending] = useState<RailEditKey | null>(null);
  const [confirmed, setConfirmed] = useState<RailEditKey | null>(null);
  const [errorFor, setErrorFor] = useState<{ key: RailEditKey; message: string } | null>(null);
  const [stale, setStale] = useState(false);

  // The confirmed check fades. A ref-held timer so a second edit (or unmount)
  // cannot leave a stale tick on screen.
  const fadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (fadeRef.current && clearTimeout(fadeRef.current)), []);

  const notifiedRef = useRef(false);
  const noteEdited = useCallback(() => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    onEdited?.();
  }, [onEdited]);

  const effective = data ? ({ ...data, ...overrides } as QuickViewData) : null;

  const finish = useCallback(
    (key: RailEditKey, res: IssueActionResult, optimistic: Partial<QuickViewData>) => {
      if (res.ok) {
        // The response IS the confirmation: keep the optimistic value and
        // advance the concurrency token so the NEXT edit submits a fresh one.
        setAckUpdatedAt(res.updatedAt);
        setErrorFor(null);
        setConfirmed(key);
        noteEdited();
        if (fadeRef.current) clearTimeout(fadeRef.current);
        fadeRef.current = setTimeout(() => setConfirmed(null), 2000);
        return;
      }
      // Refused: drop the optimistic value back to what the server last served,
      // and say why ON THE ROW (the design rejected a toast — the modal owns the
      // viewport, so a message about one field belongs on that field).
      setOverrides((o) => {
        const next = { ...o };
        for (const k of Object.keys(optimistic)) delete next[k as keyof QuickViewData];
        return next;
      });
      setErrorFor({ key, message: res.error });
      // A stale conflict is not a field error — the whole payload is behind, so
      // the rail says so at the top and the driver re-reads.
      if (res.stale) setStale(true);
    },
    [noteEdited],
  );

  const commitVia = useCallback<QuickViewRailEdit['commitVia']>(
    async (key, optimistic, run) => {
      setEditing(null);
      setErrorFor(null);
      setPending(key);
      setOverrides((o) => ({ ...o, ...optimistic }));
      try {
        finish(key, await run(), optimistic);
      } catch (err) {
        // A REJECTION is the third outcome, and it used to fall through this
        // block untouched (MOTIR-3948): `finish` never ran, so the optimistic
        // value STAYED on the row with no message — a write the server refused,
        // rendered exactly like one it took. The commonest cause is a tab older
        // than the running build, whose Server Action ids no longer resolve.
        //
        // It routes through `finish`'s own refusal arm rather than a second
        // rollback path: one place drops the optimistic keys, one place writes
        // the row's message, and the two cannot drift.
        finish(key, { ok: false, error: t(serverActionRejectionKey(err)) }, optimistic);
      } finally {
        setPending(null);
      }
    },
    [finish, t],
  );

  const commit = useCallback<QuickViewRailEdit['commit']>(
    (key, optimistic, patch) =>
      commitVia(key, optimistic, () =>
        updateIssueAction({
          id: data!.id,
          // The ACKNOWLEDGED token when we have one, else the served one.
          expectedUpdatedAt: ackUpdatedAt ?? data!.updatedAt,
          ...patch,
        }),
      ),
    [commitVia, data, ackUpdatedAt],
  );

  return {
    canEdit,
    effective,
    editing,
    toggle: useCallback((key: RailEditKey) => setEditing((cur) => (cur === key ? null : key)), []),
    close: useCallback(() => setEditing(null), []),
    pending,
    confirmed,
    errorFor,
    stale,
    commit,
    commitVia,
  };
}

/**
 * An editable rail row. Renders exactly like the read-only `RailField` until the
 * actor can edit, at which point the caption line gains its chevron.
 *
 * A read-only actor gets the affordance ABSENT, not disabled (design panel 10):
 * a disabled chevron advertises a capability the viewer does not have and
 * invites a click that can only fail.
 */
export function EditableRailField({
  label,
  fieldKey,
  edit,
  control,
  children,
}: {
  label: string;
  fieldKey: RailEditKey;
  edit: QuickViewRailEdit;
  /** The control to swap the value for while this row is open. */
  control?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('issueViews');
  const isEditing = edit.editing === fieldKey && control != null;
  const isPending = edit.pending === fieldKey;
  const err = edit.errorFor?.key === fieldKey ? edit.errorFor.message : null;
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The design's panel-8 consequence: the picker's menu renders IN FLOW (the
  // shipped Combobox / MultiSelectPicker detect an enclosing role="dialog" and
  // skip their body portal), so an opened control near the foot of the rail
  // EXTENDS the rail's scroll height rather than floating over it. Bring it into
  // view instead of assuming it is visible.
  useEffect(() => {
    if (isEditing) boxRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isEditing]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5" ref={boxRef}>
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {label}
        {edit.confirmed === fieldKey ? (
          <span className="inline-flex text-(--el-success)">
            <Check className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t('quickViewFieldSaved')}</span>
          </span>
        ) : null}
        {edit.canEdit && control != null ? (
          <button
            type="button"
            onClick={() => edit.toggle(fieldKey)}
            aria-label={
              isEditing
                ? t('quickViewCloseField', { field: label })
                : t('quickViewEditField', { field: label })
            }
            aria-expanded={isEditing}
            className="ml-auto inline-flex rounded-(--radius-control) p-0.5 text-(--el-text-faint) transition-colors hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${isEditing ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
        ) : null}
      </dt>
      <dd
        className={`m-0 flex min-w-0 items-center gap-1.5 text-sm text-(--el-text-secondary) ${
          isPending ? 'opacity-55' : ''
        }`}
      >
        {isEditing ? control : children}
      </dd>
      {isPending ? (
        // No spinner and no disabled row, on purpose: the value the user picked
        // is ALREADY on screen (the optimistic commit), so the response only
        // confirms it. A hairline bar says "in flight" without implying the
        // answer is still unknown.
        <div
          className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-(--el-border-soft)"
          role="status"
        >
          <span className="block h-full w-2/5 animate-pulse rounded-full bg-(--el-accent)" />
          <span className="sr-only">{t('quickViewFieldSaving')}</span>
        </div>
      ) : null}
      {err ? (
        // The danger hue is on the GLYPH only. `--el-danger-text` is #ffffff (ink
        // FOR a danger fill) and `--el-danger` as text measures 4.25:1 on the
        // dark page — under AA at this size. A glyph needs 3:1, so the hue
        // carries the meaning and the words stay readable in both themes.
        <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-(--el-text)">
          <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
          <span>{err}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The rail-top notice shown once someone else's write has landed first. */
export function RailStaleNotice() {
  const t = useTranslations('issueViews');
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-2.5 py-2 text-[11.5px] leading-relaxed text-(--el-text-secondary)">
      <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
      <span>{t('quickViewStaleReloaded')}</span>
    </div>
  );
}
