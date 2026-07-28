'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Calendar, ChevronDown, Info } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { formatDurationMinutes } from '@/lib/utils/duration';
import type { ProposedSprint } from '@/lib/ai/types';
import type { SprintPlanReviewItemDto } from '@/lib/dto/aiSprintPlan';
import { BacklogRowBody } from './BacklogRow';
import type { StatusByKey } from './backlogShared';

// ONE proposed sprint in the AI sprint-planning review (Subtask MOTIR-1750, the
// design/ai-planning/sprint-planning asset panel 3).
//
// It is the shipped `SprintContainer` with the PROPOSED treatment — dashed
// `--el-accent` border, lavender head, a **Proposed** pill — and three removals:
// no drag grip, no selection circle, no row `⋯`, no sprint `⋯`, no Start sprint.
// A proposal has no lifecycle; those controls appear only once the sprints are
// real. Added: the capacity line and the "Why this order" callout.
//
// EVERY figure is a real `ProposedSprint` field (design-notes Part II §4); the
// only element not in the delta is the per-row "after MOTIR-…" caption, which is
// SERVER-derived from the `is_blocked_by` edges among the packed items and
// arrives on `SprintPlanReviewItemDto.blockedByKeys` — never guessed here.
//
// Editing a proposal is out of scope: v1 approves or discards WHOLE, and
// re-running is how you get a different packing.

export function ProposedSprintPanel({
  sprint,
  order,
  agentMinutesPerDay,
  items,
  statusByKey,
  assigneeNameById,
}: {
  sprint: ProposedSprint;
  /** 0-based position in the proposal — the first sprint is the unblocked one. */
  order: number;
  /** `delta.agentMinutesPerDay` — the per-day budget the capacity line names. */
  agentMinutesPerDay: number;
  /** Every packed key resolved for render, keyed by identifier. */
  items: Record<string, SprintPlanReviewItemDto>;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
}) {
  const t = useTranslations('backlog');
  const [collapsed, setCollapsed] = useState(false);

  const over = sprint.totalEstimateMinutes > sprint.capacityMinutes;
  // Guard the divide: a zero-capacity sprint is degenerate but must not render
  // `NaN%`. The BAR is clamped at 100%; the LINE still states the real overage.
  const pct =
    sprint.capacityMinutes > 0
      ? Math.round((sprint.totalEstimateMinutes / sprint.capacityMinutes) * 100)
      : 0;
  const oversizedInSprint = sprint.oversizedKeys.length;

  return (
    <section
      aria-label={t('aiPlan.sprintRegionLabel', {
        name: sprint.name,
        count: sprint.itemKeys.length,
      })}
      data-testid={`proposed-sprint-${sprint.tempId}`}
      className="rounded-(--radius-card) border border-dashed border-(--el-accent) bg-(--el-page-bg)"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-(--el-accent) bg-(--el-tint-lavender) px-(--spacing-card-padding) py-(--spacing-control-y)">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('expandSprint') : t('collapseSprint')}
          className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-page-bg)"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        <span className="font-semibold text-(--el-text-strong)">{sprint.name}</span>
        {/* The state chip sits ON the lavender head, so it flips to the page fill
            + accent ink — a lavender chip on a lavender head is not a chip. Both
            are palette tokens; no hue is invented. */}
        <Pill
          status="planned"
          className="bg-(--el-page-bg) text-(--el-accent-on-surface)"
          data-testid={`proposed-sprint-pill-${sprint.tempId}`}
        >
          {t('aiPlan.proposed')}
        </Pill>
        <span className="flex items-center gap-1 text-xs text-(--el-text-muted)">
          <Calendar className="h-3.5 w-3.5" aria-hidden />
          {t('aiPlan.lengthDays', { days: sprint.lengthDays })}
        </span>
        <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) text-xs font-semibold text-(--el-text-secondary)">
          {sprint.itemKeys.length}
        </span>
        <span className="flex-1" />
        {oversizedInSprint > 0 ? (
          <Pill severity="warning" className="bg-(--el-warning-surface) text-(--el-warning-text)">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t('aiPlan.oversizedCount', { count: oversizedInSprint })}
          </Pill>
        ) : order === 0 ? (
          <span className="text-xs text-(--el-text-muted)">{t('aiPlan.firstSprint')}</span>
        ) : null}
      </div>

      {/* Capacity — `totalEstimateMinutes` against `capacityMinutes`, which the
          delta defines as `sprintLengthDays × agentMinutesPerDay`. Over capacity
          turns the bar to `--el-warning`; the text says so too (colour is never
          the only signal). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-(--spacing-card-padding) pt-2 text-xs text-(--el-text-muted)">
        <span
          aria-hidden
          className="relative h-1.5 w-32 shrink-0 overflow-hidden rounded-(--radius-badge) bg-(--el-muted)"
        >
          <span
            className={`absolute inset-y-0 left-0 block ${over ? 'bg-(--el-warning)' : 'bg-(--el-accent)'}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </span>
        <span>
          {over
            ? sprint.oversizedKeys[0]
              ? t('aiPlan.capacityOver', {
                  used: formatDurationMinutes(sprint.totalEstimateMinutes),
                  total: formatDurationMinutes(sprint.capacityMinutes),
                  over: formatDurationMinutes(sprint.totalEstimateMinutes - sprint.capacityMinutes),
                  key: sprint.oversizedKeys[0],
                })
              : t('aiPlan.capacityOverPlain', {
                  used: formatDurationMinutes(sprint.totalEstimateMinutes),
                  total: formatDurationMinutes(sprint.capacityMinutes),
                  over: formatDurationMinutes(sprint.totalEstimateMinutes - sprint.capacityMinutes),
                })
            : t('aiPlan.capacity', {
                used: formatDurationMinutes(sprint.totalEstimateMinutes),
                total: formatDurationMinutes(sprint.capacityMinutes),
                pct,
                days: sprint.lengthDays,
                minutes: agentMinutesPerDay,
              })}
        </span>
      </div>

      {collapsed ? null : (
        <>
          {/* A static list, NOT the sortable row grid — these rows are not
              draggable, and claiming row semantics for a static list would
              mislead a screen reader. */}
          <div
            role="list"
            aria-label={t('aiPlan.sprintRowsLabel', { name: sprint.name })}
            className="flex flex-col gap-px p-(--spacing-control-x)"
          >
            {sprint.itemKeys.map((key) => (
              <ProposedRow
                key={key}
                itemKey={key}
                entry={items[key]}
                statusByKey={statusByKey}
                assigneeNameById={assigneeNameById}
                oversized={sprint.oversizedKeys.includes(key)}
              />
            ))}
          </div>

          {sprint.rationale ? (
            <div className="mx-(--spacing-card-padding) mt-1 mb-(--spacing-card-padding) flex items-start gap-2 rounded-(--radius-card) bg-(--el-surface) px-3 py-2 text-xs leading-relaxed text-(--el-text-secondary)">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <b className="font-semibold text-(--el-text-strong)">{t('aiPlan.whyLabel')}</b>{' '}
                {sprint.rationale}
              </span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * One proposed member. The row is the shipped backlog row body in its read-only
 * form; the two proposal-only marks (the dependency caption and the
 * bigger-than-a-sprint / no-estimate flags) ride its `trailing` slot.
 *
 * A key the review could not resolve (the item was deleted between the run and
 * the review) still renders — as its bare identifier — rather than vanishing: a
 * silently shorter list would misrepresent what approving would attempt, and the
 * approve path is what refuses the stale packing, with nothing written.
 */
function ProposedRow({
  itemKey,
  entry,
  statusByKey,
  assigneeNameById,
  oversized,
}: {
  itemKey: string;
  entry: SprintPlanReviewItemDto | undefined;
  statusByKey: StatusByKey;
  assigneeNameById: Map<string, string>;
  oversized: boolean;
}) {
  const t = useTranslations('backlog');

  const flags = (
    <>
      {entry && entry.blockedByKeys.length > 0 ? (
        <span className="shrink-0 text-xs text-(--el-text-faint)">
          {t('aiPlan.after', { key: entry.blockedByKeys.join(', ') })}
        </span>
      ) : null}
      {oversized ? (
        <Pill
          severity="warning"
          className="shrink-0 bg-(--el-warning-surface) text-(--el-warning-text)"
        >
          {t('aiPlan.oversized')}
        </Pill>
      ) : null}
      {entry && entry.item.estimateMinutes === null && entry.item.storyPoints === null ? (
        <Pill severity="info" className="shrink-0">
          {t('aiPlan.unestimated')}
        </Pill>
      ) : null}
    </>
  );

  if (!entry) {
    return (
      <div
        role="listitem"
        data-testid={`proposed-row-${itemKey}`}
        className="flex items-center gap-2 rounded-(--radius-control) border border-transparent px-(--spacing-control-x) py-(--spacing-control-y)"
      >
        <span className="shrink-0 font-mono text-xs text-(--el-text-muted)">{itemKey}</span>
        <span className="flex-1" />
        {flags}
      </div>
    );
  }

  return (
    <BacklogRowBody
      item={entry.item}
      statusByKey={statusByKey}
      assigneeNameById={assigneeNameById}
      showGrip={false}
      rowRole="listitem"
      testIdPrefix="proposed-row"
      readOnlyEstimate
      trailing={flags}
    />
  );
}
