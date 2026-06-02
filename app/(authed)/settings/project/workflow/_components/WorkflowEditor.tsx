'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { keyBetween } from '@/lib/workItems/positioning';
import {
  addTransitionAction,
  createStatusAction,
  deleteStatusAction,
  removeTransitionAction,
  reorderStatusAction,
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

const CATEGORY_OPTIONS: ReadonlyArray<{ value: StatusCategoryDto; label: string }> = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

const CATEGORY_LABEL: Record<StatusCategoryDto, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
};

// Category → AA-safe semantic Pill (post-finding-#35). todo = neutral grey,
// in_progress = info blue, done = success green.
function CategoryPill({ category }: { category: StatusCategoryDto }) {
  if (category === 'in_progress') return <Pill severity="info">In Progress</Pill>;
  if (category === 'done') return <Pill severity="success">Done</Pill>;
  return <Pill tone="neutral">To Do</Pill>;
}

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
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [tab, setTab] = useState<'statuses' | 'transitions'>('statuses');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowStatusDto | null>(null);

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
        toast({ variant: 'error', title: res.error ?? 'Something went wrong' });
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
    run(() => reorderStatusAction({ statusId: statuses[index]!.id, position }), 'Reordered');
  }

  function toggleTransition(from: WorkflowStatusDto, to: WorkflowStatusDto) {
    const existing = transitionByPair.get(`${from.id}|${to.id}`);
    if (existing) {
      run(() => removeTransitionAction(existing.id), 'Transition removed');
    } else {
      run(
        () => addTransitionAction({ fromStatusId: from.id, toStatusId: to.id }),
        'Transition added',
      );
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Policy mode */}
      <section className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-sans text-sm font-semibold text-foreground">Transition policy</h2>
            <p className="text-muted-foreground font-sans text-xs">
              {policyMode === 'open'
                ? 'Open mode: any status can transition to any other.'
                : 'Restricted mode: only the transitions below are allowed.'}
            </p>
          </div>
          {/* Segmented control: one bordered track, two connected segments — the
              active one is a raised pill, not a separate solid button. */}
          <div
            role="group"
            aria-label="Transition policy mode"
            className="border-border bg-background inline-flex shrink-0 rounded-md border p-0.5"
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
                    if (!active) run(() => setPolicyModeAction(mode), `Policy set to ${mode}`);
                  }}
                  className={`rounded px-3 py-1 font-sans text-xs font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode === 'restricted' ? 'Restricted' : 'Open'}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Tabs */}
      <div
        className="border-border flex gap-1 border-b"
        role="tablist"
        aria-label="Workflow editor"
      >
        {(['statuses', 'transitions'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`-mb-px border-b-2 px-3 py-2 font-sans text-sm font-medium ${
              tab === t
                ? 'border-foreground text-foreground'
                : 'text-muted-foreground border-transparent'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'statuses' ? 'Statuses' : 'Transitions'}
          </button>
        ))}
      </div>

      {tab === 'statuses' ? (
        <section className="flex flex-col gap-2" aria-label="Statuses">
          <ul className="flex flex-col gap-2">
            {statuses.map((s, i) => (
              <li
                key={s.id}
                className="border-border bg-card flex items-center gap-3 rounded-lg border p-3"
              >
                <span
                  aria-hidden
                  className="h-3 w-3 shrink-0 rounded-full border border-border"
                  style={s.color ? { backgroundColor: s.color } : undefined}
                />
                <span className="font-sans text-sm font-medium text-foreground">{s.label}</span>
                <CategoryPill category={s.category} />
                {s.isInitial && <Pill tone="neutral">Initial</Pill>}
                {isAdmin && (
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${s.label} up`}
                      disabled={i === 0 || isPending}
                      onClick={() => moveStatus(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${s.label} down`}
                      disabled={i === statuses.length - 1 || isPending}
                      onClick={() => moveStatus(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => setEditing(s)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${s.label}`}
                      disabled={isPending}
                      onClick={() => run(() => deleteStatusAction(s.id), 'Status deleted')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
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
                Add status
              </Button>
            </div>
          )}
        </section>
      ) : (
        <section aria-label="Transitions" className="overflow-x-auto">
          <table className="border-collapse font-sans text-xs">
            <caption className="text-muted-foreground mb-2 text-left text-xs">
              Each cell is a legal move from the row status to the column status.
              {policyMode === 'open' && ' (Ignored while policy is Open.)'}
            </caption>
            <thead>
              <tr>
                <th className="text-muted-foreground p-2 text-left font-medium">From ↓ / To →</th>
                {statuses.map((to) => (
                  <th key={to.id} scope="col" className="text-muted-foreground p-2 font-medium">
                    {to.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {statuses.map((from) => (
                <tr key={from.id}>
                  <th scope="row" className="text-foreground p-2 text-left font-medium">
                    {from.label}
                  </th>
                  {statuses.map((to) => {
                    const self = from.id === to.id;
                    const on = transitionByPair.has(`${from.id}|${to.id}`);
                    return (
                      <td key={to.id} className="p-1 text-center">
                        {self ? (
                          <span aria-hidden className="text-muted-foreground">
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            aria-label={`${from.label} to ${to.label}`}
                            disabled={!isAdmin || isPending}
                            onClick={() => toggleTransition(from, to)}
                            className={`h-6 w-6 rounded border ${
                              on
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-border text-transparent'
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
        </section>
      )}

      {addOpen && (
        <StatusFormModal
          open={addOpen}
          onOpenChange={setAddOpen}
          title="Add status"
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
              'Status added',
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
          title={`Edit ${editing.label}`}
          isPending={isPending}
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
                updateStatusAction({
                  statusId: editing.id,
                  label: values.label,
                  category: values.category,
                  color: values.color || null,
                  isInitial: values.isInitial,
                }),
              'Status updated',
              () => setEditing(null),
            )
          }
        />
      )}
    </div>
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
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  isPending: boolean;
  initial?: Partial<StatusFormValues>;
  requireKey?: boolean;
  onSubmit: (values: StatusFormValues) => void;
}) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [category, setCategory] = useState<StatusCategoryDto>(initial?.category ?? 'todo');
  const [color, setColor] = useState(initial?.color ?? '');
  const [isInitial, setIsInitial] = useState(initial?.isInitial ?? false);

  const canSubmit = label.trim().length > 0 && (!requireKey || key.trim().length > 0);

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <h2 className="font-serif text-xl font-semibold text-foreground">{title}</h2>
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
        {requireKey && (
          <Input
            label="Key (machine id, lowercase)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="in_review"
            disabled={isPending}
            autoFocus
          />
        )}
        <Input
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="In Review"
          disabled={isPending}
        />
        <label className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-foreground font-medium">Category</span>
          <select
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as StatusCategoryDto)}
            disabled={isPending}
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {CATEGORY_LABEL[c.value]}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Color (hex, optional)"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="#6B778C"
          disabled={isPending}
        />
        {!requireKey && (
          <label className="flex items-center gap-2 font-sans text-sm">
            <input
              type="checkbox"
              checked={isInitial}
              onChange={(e) => setIsInitial(e.target.checked)}
              disabled={isPending}
            />
            <span className="text-foreground">Make this the initial status</span>
          </label>
        )}
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
            Save
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
