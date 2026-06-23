'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ColorSwatchPicker } from '@/components/ui/ColorSwatchPicker';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { keyBetween } from '@/lib/workItems/positioning';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import {
  addTransitionAction,
  createStatusAction,
  deleteStatusAction,
  removeTransitionAction,
  reorderStatusAction,
  restoreDefaultTransitionsAction,
  setPolicyModeAction,
  updateStatusAction,
  type ActionResult,
} from '../actions';
import type {
  StatusCategoryDto,
  WorkflowPolicyModeDto,
  WorkflowStatusDto,
  WorkflowTransitionDto,
} from '@/lib/dto/workflows';

const CATEGORY_VALUES: readonly StatusCategoryDto[] = ['todo', 'in_progress', 'done'];

// Category → AA-safe semantic Pill (post-finding-#35). todo = neutral grey,
// in_progress = info blue, done = success green.
function CategoryPill({ category }: { category: StatusCategoryDto }) {
  const t = useTranslations('settings');
  if (category === 'in_progress')
    return <Pill severity="info">{t('workflow.category.in_progress')}</Pill>;
  if (category === 'done') return <Pill severity="success">{t('workflow.category.done')}</Pill>;
  return <Pill tone="neutral">{t('workflow.category.todo')}</Pill>;
}

// A default status (Subtask 2.2.10 / finding #49) is PROTECTED: recolor only —
// no rename, recategorize, reorder, or delete. The editor locks those
// affordances and shows a "Default" badge so the rule is legible in the UI.
const isDefaultStatus = (s: WorkflowStatusDto) => DEFAULT_STATUS_KEYS.has(s.key);

export interface WorkflowEditorProps {
  statuses: WorkflowStatusDto[];
  transitions: WorkflowTransitionDto[];
  policyMode: WorkflowPolicyModeDto;
  isAdmin: boolean;
}

export function WorkflowEditor({
  statuses,
  transitions,
  policyMode,
  isAdmin,
}: WorkflowEditorProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<'statuses' | 'transitions'>('statuses');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowStatusDto | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Delete-with-reassign target prompt (Subtask 2.3.1): set when a delete is
  // refused because the status is in use, carrying the affected-item count.
  const [reassign, setReassign] = useState<{ status: WorkflowStatusDto; count: number } | null>(
    null,
  );

  // Statuses arrive position-ordered from getWorkflow.
  const transitionByPair = new Map(
    transitions.map((t) => [`${t.fromStatusId}|${t.toStatusId}`, t]),
  );

  function run(action: () => Promise<ActionResult>, successTitle: string, onSuccess?: () => void) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        toast({ variant: 'success', title: successTitle });
        onSuccess?.(); // e.g. close the modal — ONLY on success, so a failure keeps the form
        router.refresh();
      } else {
        toast({ variant: 'error', title: res.error ?? t('workflow.toast.genericError') });
      }
    });
  }

  // First-pass delete (no target). If the status is in use the server returns
  // the affected count instead of an error toast — open the reassign modal.
  function handleDelete(s: WorkflowStatusDto) {
    startTransition(async () => {
      const res = await deleteStatusAction(s.id);
      if (res.ok) {
        toast({ variant: 'success', title: t('workflow.toast.statusDeleted') });
        router.refresh();
      } else if (res.statusInUse) {
        setReassign({ status: s, count: res.statusInUse.count });
      } else {
        toast({ variant: 'error', title: res.error ?? t('workflow.toast.genericError') });
      }
    });
  }

  function moveStatus(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= statuses.length) return;
    // Reposition between the neighbour we're crossing and the one beyond it.
    const beyond =
      dir === -1
        ? (statuses[index - 2]?.position ?? null)
        : (statuses[index + 2]?.position ?? null);
    const neighbour = statuses[target]!.position;
    const [lo, hi] = dir === -1 ? [beyond, neighbour] : [neighbour, beyond];
    const position = keyBetween(lo, hi);
    run(
      () => reorderStatusAction({ statusId: statuses[index]!.id, position }),
      t('workflow.toast.reordered'),
    );
  }

  function toggleTransition(from: WorkflowStatusDto, to: WorkflowStatusDto) {
    const existing = transitionByPair.get(`${from.id}|${to.id}`);
    if (existing) {
      run(() => removeTransitionAction(existing.id), t('workflow.toast.transitionRemoved'));
    } else {
      run(
        () => addTransitionAction({ fromStatusId: from.id, toStatusId: to.id }),
        t('workflow.toast.transitionAdded'),
      );
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Policy mode */}
      <section className="border-(--el-border) bg-(--el-card) flex flex-col gap-2 rounded-(--radius-card) border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('workflow.policyHeading')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-xs">
              {policyMode === 'open'
                ? t('workflow.policyOpenDesc')
                : t('workflow.policyRestrictedDesc')}
            </p>
          </div>
          {/* Segmented control: one bordered track, two connected segments — the
              active one is a raised pill, not a separate solid button. */}
          <div
            role="group"
            aria-label={t('workflow.policyGroupLabel')}
            className="border-(--el-border) bg-(--el-page-bg) inline-flex shrink-0 rounded-md border p-0.5"
          >
            {(['restricted', 'open'] as const).map((mode) => {
              const active = policyMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  disabled={!isAdmin || isPending}
                  onClick={() => {
                    // Clicking the active segment is a harmless no-op; the other switches.
                    if (!active)
                      run(() => setPolicyModeAction(mode), t('workflow.policySetToast', { mode }));
                  }}
                  className={`rounded px-3 py-1 font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? 'bg-(--el-text) text-(--el-text-inverted)'
                      : 'text-(--el-text-muted) hover:text-(--el-text)'
                  }`}
                >
                  {mode === 'restricted'
                    ? t('workflow.policyRestricted')
                    : t('workflow.policyOpen')}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Tabs */}
      <div
        className="border-(--el-border) flex gap-1 border-b"
        role="tablist"
        aria-label={t('workflow.tablistLabel')}
      >
        {(['statuses', 'transitions'] as const).map((tabKey) => (
          <button
            key={tabKey}
            role="tab"
            aria-selected={tab === tabKey}
            className={`-mb-px border-b-2 px-3 py-2 font-sans text-sm font-medium ${
              tab === tabKey
                ? 'border-(--el-text) text-(--el-text)'
                : 'text-(--el-text-muted) border-transparent'
            }`}
            onClick={() => setTab(tabKey)}
          >
            {tabKey === 'statuses' ? t('workflow.tabStatuses') : t('workflow.tabTransitions')}
          </button>
        ))}
      </div>

      {tab === 'statuses' ? (
        <section className="flex flex-col gap-2" aria-label="Statuses">
          <ul className="flex flex-col gap-2">
            {statuses.map((s, i) => {
              const isDefault = isDefaultStatus(s);
              return (
                <li
                  key={s.id}
                  className="border-(--el-border) bg-(--el-card) flex items-center gap-3 rounded-lg border p-3"
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full border border-(--el-border)"
                    style={s.color ? { backgroundColor: s.color } : undefined}
                  />
                  <span className="font-sans text-sm font-medium text-(--el-text)">{s.label}</span>
                  <CategoryPill category={s.category} />
                  {s.isInitial && <Pill tone="neutral">{t('workflow.initialBadge')}</Pill>}
                  {isDefault && <Pill tone="neutral">{t('workflow.defaultBadge')}</Pill>}
                  {isAdmin && (
                    <div className="ml-auto flex items-center gap-1">
                      {/* Defaults are non-reorderable (protected) — hide the
                          up/down controls; custom statuses keep them. */}
                      {!isDefault && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('workflow.moveUp', { label: s.label })}
                            disabled={i === 0 || isPending}
                            onClick={() => moveStatus(i, -1)}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('workflow.moveDown', { label: s.label })}
                            disabled={i === statuses.length - 1 || isPending}
                            onClick={() => moveStatus(i, 1)}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={
                          isDefault ? t('workflow.changeColor', { label: s.label }) : undefined
                        }
                        disabled={isPending}
                        onClick={() => setEditing(s)}
                      >
                        {isDefault ? t('workflow.colorButton') : t('workflow.editButton')}
                      </Button>
                      {/* Defaults can't be deleted (protected) — no delete button. */}
                      {!isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('workflow.deleteStatus', { label: s.label })}
                          disabled={isPending}
                          onClick={() => handleDelete(s)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {isAdmin && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                disabled={isPending}
                onClick={() => setAddOpen(true)}
              >
                {t('workflow.addStatus')}
              </Button>
            </div>
          )}
        </section>
      ) : (
        <section aria-label="Transitions" className="flex flex-col gap-3">
          {/* Restore lives here — it re-adds default transition edges, so it
              belongs to the Transitions tab, not the always-visible header. */}
          {isAdmin && (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                disabled={isPending}
                onClick={() => setRestoreOpen(true)}
              >
                {t('workflow.restoreDefaults')}
              </Button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="border-collapse font-sans text-xs">
              <caption className="text-(--el-text-muted) mb-2 text-left text-xs">
                {t('workflow.tableCaption')}
                {policyMode === 'open' && t('workflow.tableCaptionOpen')}
              </caption>
              <thead>
                <tr>
                  <th className="text-(--el-text-muted) p-2 text-left font-medium">
                    {t('workflow.fromToHeader')}
                  </th>
                  {statuses.map((to) => (
                    <th key={to.id} scope="col" className="text-(--el-text-muted) p-2 font-medium">
                      {to.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statuses.map((from) => (
                  <tr key={from.id}>
                    <th scope="row" className="text-(--el-text) p-2 text-left font-medium">
                      {from.label}
                    </th>
                    {statuses.map((to) => {
                      const self = from.id === to.id;
                      const on = transitionByPair.has(`${from.id}|${to.id}`);
                      return (
                        <td key={to.id} className="p-1 text-center">
                          {self ? (
                            <span aria-hidden className="text-(--el-text-muted)">
                              —
                            </span>
                          ) : (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              aria-label={t('workflow.transitionCell', {
                                from: from.label,
                                to: to.label,
                              })}
                              disabled={!isAdmin || isPending}
                              onClick={() => toggleTransition(from, to)}
                              className={`h-6 w-6 rounded border ${
                                on
                                  ? 'border-(--el-text) bg-(--el-text) text-(--el-text-inverted)'
                                  : 'border-(--el-border) text-transparent'
                              } disabled:opacity-50`}
                            >
                              {on ? '✓' : '·'}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {addOpen && (
        <StatusFormModal
          open={addOpen}
          onOpenChange={setAddOpen}
          title={t('workflow.addStatus')}
          isPending={isPending}
          onSubmit={(values) =>
            run(
              () =>
                createStatusAction({
                  key: values.key,
                  label: values.label,
                  category: values.category,
                  color: values.color || null,
                }),
              t('workflow.toast.statusAdded'),
              () => setAddOpen(false),
            )
          }
          requireKey
        />
      )}

      {editing && (
        <StatusFormModal
          open={Boolean(editing)}
          onOpenChange={(o) => !o && setEditing(null)}
          title={
            isDefaultStatus(editing)
              ? t('workflow.colorTitle', { label: editing.label })
              : t('workflow.editTitle', { label: editing.label })
          }
          isPending={isPending}
          // A default status is recolor-only (finding #49): the form hides the
          // label/category/initial fields and the action sends just `color`.
          colorOnly={isDefaultStatus(editing)}
          initial={{
            key: editing.key,
            label: editing.label,
            category: editing.category,
            color: editing.color ?? '',
            isInitial: editing.isInitial,
          }}
          onSubmit={(values) =>
            run(
              () =>
                isDefaultStatus(editing)
                  ? updateStatusAction({ statusId: editing.id, color: values.color || null })
                  : updateStatusAction({
                      statusId: editing.id,
                      label: values.label,
                      category: values.category,
                      color: values.color || null,
                      isInitial: values.isInitial,
                    }),
              t('workflow.toast.statusUpdated'),
              () => setEditing(null),
            )
          }
        />
      )}

      {restoreOpen && (
        <Modal open={restoreOpen} onOpenChange={setRestoreOpen} size="md">
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('workflow.restoreModalTitle')}
          </h2>
          <p className="text-(--el-text-muted) mt-2 font-sans text-sm">
            {t.rich('workflow.restoreModalDesc', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <Modal.Footer>
            <Button variant="ghost" onClick={() => setRestoreOpen(false)} disabled={isPending}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              loading={isPending}
              onClick={() =>
                run(
                  () => restoreDefaultTransitionsAction(),
                  t('workflow.toast.transitionsRestored'),
                  () => setRestoreOpen(false),
                )
              }
            >
              {t('workflow.restoreDefaults')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {reassign && (
        <ReassignModal
          status={reassign.status}
          count={reassign.count}
          targets={statuses.filter((s) => s.id !== reassign.status.id)}
          isPending={isPending}
          onCancel={() => setReassign(null)}
          onConfirm={(targetId) =>
            run(
              () => deleteStatusAction(reassign.status.id, targetId),
              t('workflow.toast.statusDeleted'),
              () => setReassign(null),
            )
          }
        />
      )}
    </div>
  );
}

// Delete-with-reassign prompt (Subtask 2.3.1). Shown only when a delete was
// refused because the status is still in use: the admin picks a target status
// and every referencing work item is migrated to it before the status is
// removed (server-side, in one transaction).
function ReassignModal({
  status,
  count,
  targets,
  isPending,
  onCancel,
  onConfirm,
}: {
  status: WorkflowStatusDto;
  count: number;
  targets: WorkflowStatusDto[];
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (targetId: string) => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [targetId, setTargetId] = useState('');
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="md">
      <h2 className="font-serif text-xl font-semibold text-(--el-text)">
        {t('workflow.reassignTitle', { label: status.label })}
      </h2>
      <p
        className="text-(--el-text-muted) mt-2 font-sans text-sm"
        data-testid="reassign-affected-count"
      >
        {t('workflow.reassignAffected', { count, label: status.label })}
      </p>
      <label className="mt-4 flex flex-col gap-1">
        <span className="font-sans text-sm font-medium text-(--el-text)">
          {t('workflow.reassignMoveTo')}
        </span>
        <select
          className="border-(--el-border) bg-(--el-card) text-(--el-text) rounded-md border px-3 py-2 font-sans text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="" disabled>
            {t('workflow.selectStatusPlaceholder')}
          </option>
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel} disabled={isPending}>
          {tc('cancel')}
        </Button>
        <Button
          variant="primary"
          loading={isPending}
          disabled={!targetId}
          onClick={() => onConfirm(targetId)}
        >
          {t('workflow.reassignConfirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

interface StatusFormValues {
  key: string;
  label: string;
  category: StatusCategoryDto;
  color: string;
  isInitial: boolean;
}

function StatusFormModal({
  open,
  onOpenChange,
  title,
  isPending,
  initial,
  requireKey = false,
  colorOnly = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  isPending: boolean;
  initial?: Partial<StatusFormValues>;
  requireKey?: boolean;
  // Recolor-only: a protected default status (finding #49). Hides every field
  // but the color picker; the label/category/initial values pass through
  // unchanged so the submitted shape is still a full StatusFormValues.
  colorOnly?: boolean;
  onSubmit: (values: StatusFormValues) => void;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [key, setKey] = useState(initial?.key ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [category, setCategory] = useState<StatusCategoryDto>(initial?.category ?? 'todo');
  const [color, setColor] = useState(initial?.color ?? '');
  const [isInitial, setIsInitial] = useState(initial?.isInitial ?? false);

  const canSubmit =
    colorOnly || (label.trim().length > 0 && (!requireKey || key.trim().length > 0));

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <h2 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h2>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            key: key.trim(),
            label: label.trim(),
            category,
            color: color.trim(),
            isInitial,
          });
        }}
      >
        {colorOnly && (
          <p className="text-(--el-text-muted) font-sans text-sm">
            {t.rich('workflow.defaultStatusNote', {
              name: () => <span className="text-(--el-text) font-medium">{initial?.label}</span>,
            })}
          </p>
        )}
        {!colorOnly && requireKey && (
          <Input
            label={t('workflow.keyLabel')}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="in_review"
            disabled={isPending}
            autoFocus
          />
        )}
        {!colorOnly && (
          <Input
            label={t('workflow.labelLabel')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('workflow.labelPlaceholder')}
            disabled={isPending}
          />
        )}
        {!colorOnly && (
          <label className="flex flex-col gap-1 font-sans text-sm">
            <span className="text-(--el-text) font-medium">{t('workflow.categoryLabel')}</span>
            <select
              className="border-(--el-border) bg-(--el-page-bg) rounded-md border px-3 py-2 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value as StatusCategoryDto)}
              disabled={isPending}
            >
              {CATEGORY_VALUES.map((c) => (
                <option key={c} value={c}>
                  {t(`workflow.category.${c}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <ColorSwatchPicker
          label={t('workflow.colorButton')}
          value={color || null}
          onChange={(v) => setColor(v ?? '')}
          disabled={isPending}
        />
        {!colorOnly && !requireKey && (
          <label className="flex items-center gap-2 font-sans text-sm">
            <input
              type="checkbox"
              checked={isInitial}
              onChange={(e) => setIsInitial(e.target.checked)}
              disabled={isPending}
            />
            <span className="text-(--el-text)">{t('workflow.makeInitial')}</span>
          </label>
        )}
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
            {tc('save')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
