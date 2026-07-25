'use client';

import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import type { PlanDelta, PlanDeltaCreateOp, PlanDeltaUpdateOp } from '@/lib/ai/planDelta';
import type { PlanEditsState } from '@/lib/hooks/usePlanEditsJob';

export interface PlanEditsReviewDockProps {
  state: PlanEditsState;
  onApprove: (editedDelta?: PlanDelta) => void;
  onCancel: () => void;
  onDismiss: () => void;
}

export function PlanEditsReviewDock({
  state,
  onApprove,
  onCancel,
  onDismiss,
}: PlanEditsReviewDockProps) {
  const t = useTranslations('planEdits');

  if (state.phase === 'idle') return null;

  if (state.phase === 'submitting' || state.phase === 'running') {
    return (
      <div
        className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-4 py-3 shadow-(--shadow-card)"
        role="status"
        aria-live="polite"
      >
        <Spinner size="sm" className="text-(--el-accent-on-surface)" />
        <span className="text-sm text-(--el-text-secondary)">
          {state.phase === 'submitting' ? t('submitting') : t('running')}
        </span>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-5 shadow-(--shadow-card)">
        <div className="flex items-center gap-2">
          <Check className="size-5 shrink-0 text-(--el-success)" aria-hidden />
          <h3 className="font-semibold text-(--el-text)">{t('doneTitle')}</h3>
        </div>
        {state.approved ? (
          <p className="text-sm text-(--el-text-secondary)">
            {t('doneBody', {
              created: state.approved.created.length,
              updated: state.approved.updated.length,
            })}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={onDismiss}>
            {t('doneClose')}
          </Button>
        </div>
      </div>
    );
  }

  if (state.phase === 'approving') {
    return (
      <div
        className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-4 py-3 shadow-(--shadow-card)"
        role="status"
        aria-live="polite"
      >
        <Spinner size="sm" className="text-(--el-accent-on-surface)" />
        <span className="text-sm text-(--el-text-secondary)">{t('approving')}</span>
      </div>
    );
  }

  // phase === 'review'
  if (!state.delta) return null;

  const delta = state.delta;

  return (
    <div className="flex max-h-[70vh] flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-elevated)">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-(--el-border) px-5 py-3">
        <h2 className="font-serif font-semibold text-(--el-text)">{t('reviewTitle')}</h2>
        <Button variant="ghost" size="sm" leftIcon={<X className="size-4" />} onClick={onCancel}>
          {t('close')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto px-5 py-4">
        {delta.operations.map((op, i) => (
          <DeltaRow key={i} op={op} />
        ))}
      </div>

      {state.errorCode ? (
        <div className="shrink-0 border-t border-(--el-border) px-5 py-3">
          <p role="alert" className="text-xs font-medium text-(--el-danger-text)">
            {state.errorCode === 'immutable' ? t('immutableRejection') : t('actionError')}
          </p>
        </div>
      ) : null}

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-(--el-border) px-5 py-3">
        <p className="text-xs text-(--el-text-muted)">
          {t('itemCount', { count: delta.operations.length })}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('declineCta')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Check className="size-4" aria-hidden />}
            onClick={() => onApprove(state.delta ?? undefined)}
          >
            {t('approveCta', { n: delta.operations.length })}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function DeltaRow({ op }: { op: PlanDeltaCreateOp | PlanDeltaUpdateOp }) {
  const t = useTranslations('planEdits');

  if (op.op === 'create') {
    return (
      <div className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-2">
        <span className="inline-flex shrink-0 items-center rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-px text-[11px] font-semibold text-(--el-text-strong)">
          {t('opAdd')}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-(--el-text)">{op.fields.title}</span>
          <span className="text-xs text-(--el-text-muted)">
            {op.kind}
            {op.fields.priority ? ` · ${op.fields.priority}` : ''}
            {op.fields.type ? ` · ${op.fields.type}` : ''}
          </span>
        </div>
        {op.parentKey || op.parentRef ? (
          <Tooltip content={`Parent: ${op.parentKey ?? op.parentRef}`}>
            <span className="text-xs text-(--el-text-muted)">
              {op.parentKey ? `↳ ${op.parentKey}` : '↳ linked'}
            </span>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  // update op
  const changes: string[] = [];
  if (op.fields.title !== undefined && op.fields.title !== null) changes.push(t('field_title'));
  if (op.fields.priority !== undefined) changes.push(t('field_priority'));
  if (op.fields.type !== undefined) changes.push(t('field_type'));

  return (
    <div className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-2">
      <span className="inline-flex shrink-0 items-center rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-px text-[11px] font-semibold text-(--el-text-strong)">
        {t('opChange')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-(--el-text)">{op.targetKey}</span>
        {changes.length > 0 ? (
          <span className="text-xs text-(--el-text-muted)">{changes.join(', ')}</span>
        ) : (
          <span className="text-xs text-(--el-text-muted)">{t('noChanges')}</span>
        )}
      </div>
    </div>
  );
}
