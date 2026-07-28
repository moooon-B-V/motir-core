'use client';

import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import type { PlanEditsState } from '@/lib/hooks/usePlanEditsJob';

// The item-scoped expand / re-plan review dock. It draws the run's PROPOSALS —
// the PlanItems its Plan carries (MOTIR-1747) — where it used to draw a
// `planDelta` that motir-ai never fills, and confirms through the plan approve
// route. The three ops it can receive are the Plan's own vocabulary: `add`,
// `modify`, `remove` — the last one had no delta counterpart at all, so a removal
// proposed by an expand/replan run was previously invisible here.

export interface PlanEditsReviewDockProps {
  state: PlanEditsState;
  onApprove: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}

export function PlanEditsReviewDock({
  state,
  onApprove,
  onDiscard,
  onDismiss,
}: PlanEditsReviewDockProps) {
  const t = useTranslations('planEdits');

  // A settled FAILURE — the run is over and produced nothing to review. It used
  // to render as nothing at all, so an expand that came back empty (which, with
  // the delta read, was EVERY expand) left the user staring at an unchanged page
  // (MOTIR-1747).
  if (state.phase === 'idle') {
    if (!state.errorCode) return null;
    return (
      <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-5 shadow-(--shadow-card)">
        <p role="alert" className="text-sm text-(--el-danger-text)">
          {state.errorCode === 'out_of_credits'
            ? t('creditsError')
            : state.errorCode === 'EMPTY'
              ? t('emptyError')
              : t('failedError')}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onDismiss}>
            {t('close')}
          </Button>
        </div>
      </div>
    );
  }

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
          <Button variant="ghost" size="sm" onClick={onDiscard}>
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
  if (!state.review) return null;

  const items = state.review.items;

  return (
    <div className="flex max-h-[70vh] flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) shadow-(--shadow-elevated)">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-(--el-border) px-5 py-3">
        <h2 className="font-serif font-semibold text-(--el-text)">{t('reviewTitle')}</h2>
        <Button variant="ghost" size="sm" leftIcon={<X className="size-4" />} onClick={onDiscard}>
          {t('close')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto px-5 py-4">
        {items.map((item) => (
          <ProposalRow key={item.planItemId} item={item} />
        ))}
      </div>

      {state.errorCode ? (
        <div className="shrink-0 border-t border-(--el-border) px-5 py-3">
          <p role="alert" className="text-xs font-medium text-(--el-danger-text)">
            {state.errorCode === 'immutable'
              ? t('immutableRejection')
              : state.errorCode === 'decided'
                ? t('decidedRejection')
                : t('actionError')}
          </p>
        </div>
      ) : null}

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-(--el-border) px-5 py-3">
        <p className="text-xs text-(--el-text-muted)">{t('itemCount', { count: items.length })}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onDiscard}>
            {t('declineCta')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Check className="size-4" aria-hidden />}
            onClick={onApprove}
          >
            {t('approveCta', { n: items.length })}
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** The op's chip label + tint. A `remove` reuses the canvas's removal language
 *  (`--el-tint-rose`), so the dock and the diff canvas say the same thing. */
const OP_CHIP: Record<PlanReviewItemDto['op'], { key: string; tint: string }> = {
  add: { key: 'opAdd', tint: 'bg-(--el-tint-mint)' },
  modify: { key: 'opChange', tint: 'bg-(--el-tint-sky)' },
  remove: { key: 'opRemove', tint: 'bg-(--el-tint-rose)' },
};

/** The named field labels the dock can localize; anything else (a field added
 *  later) falls back to its own id rather than rendering a missing-key error. */
const FIELD_KEYS: Record<string, string> = {
  title: 'field_title',
  priority: 'field_priority',
  type: 'field_type',
  description: 'field_description',
  links: 'field_links',
};

function ProposalRow({ item }: { item: PlanReviewItemDto }) {
  const t = useTranslations('planEdits');
  const chip = OP_CHIP[item.op];

  const secondary =
    item.op === 'add'
      ? [item.kind, item.priority, item.type].filter(Boolean).join(' · ')
      : item.changes.length > 0
        ? item.changes
            .map((change) =>
              FIELD_KEYS[change.field] ? t(FIELD_KEYS[change.field]!) : change.field,
            )
            .join(', ')
        : t('noChanges');

  return (
    <div className="flex items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-2">
      <span
        className={`inline-flex shrink-0 items-center rounded-(--radius-badge) ${chip.tint} px-(--spacing-chip-x) py-px text-[11px] font-semibold text-(--el-text-strong)`}
      >
        {t(chip.key)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={`truncate text-sm font-medium text-(--el-text) ${item.op === 'remove' ? 'line-through' : ''}`}
        >
          {item.title}
        </span>
        <span className="text-xs text-(--el-text-muted)">{secondary}</span>
      </div>
      {item.identifier ? (
        <span className="shrink-0 text-xs text-(--el-text-muted)">{item.identifier}</span>
      ) : null}
    </div>
  );
}
