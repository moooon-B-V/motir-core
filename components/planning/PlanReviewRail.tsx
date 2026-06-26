'use client';

import Link from 'next/link';
import { AlertTriangle, Check, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { PlanHistoryEventDto, PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto, StaleReason } from '@/lib/dto/plans';

// The REVIEW RAIL of the plan detail (Subtask 7.4.5 / MOTIR-847) — the chat-side
// pane of the composed canvas+chat shell. It carries the Plans-substrate chrome
// the ai-planning design §3 Panel B adds: the plan status, a history timeline,
// the per-plan staleness summary, and the Approve(materialize) / Decline gate. A
// DECIDED plan (approved/declined) is read-only — its outcome + history stay
// shown. Presentational: the parent island owns the polling + the approve/decline
// actions + the stale-warning confirm; this renders state and fires handlers.

const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  planned: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  approved: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  declined: 'bg-(--el-muted) text-(--el-text-secondary)',
};

function formatAt(iso: string | null): string {
  if (!iso) return '—';
  // Fixed UTC formatting so the server + client renders match (finding #89).
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'siblings_added':
      return t('staleSiblingsAdded');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

export interface PlanReviewRailProps {
  review: PlanReviewDto;
  onApprove: () => void;
  onDecline: () => void;
  busy: boolean;
  errorCode: string | null;
}

export function PlanReviewRail({
  review,
  onApprove,
  onDecline,
  busy,
  errorCode,
}: PlanReviewRailProps) {
  const t = useTranslations('aiPlanning');
  const decided = review.status === 'approved' || review.status === 'declined';
  const planned = review.status === 'planned';
  const staleItems = review.items.filter((i) => i.stale);

  return (
    <aside
      aria-label={t('reviewRailAria')}
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto border-l border-(--el-border) bg-(--el-surface) p-5"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-serif text-lg font-semibold text-(--el-text)">
            {review.title ?? t('untitledPlan')}
          </h2>
          <span
            data-testid="plan-status-pill"
            className={`inline-flex shrink-0 items-center rounded-(--radius-badge) px-2 py-0.5 text-xs font-semibold ${STATUS_TINT[review.status]}`}
          >
            {t(`status_${review.status}`)}
          </span>
        </div>
        {review.summary ? (
          <p className="text-sm text-(--el-text-secondary)">{review.summary}</p>
        ) : null}
        <p className="text-xs text-(--el-text-muted)">{t('itemCount', { n: review.itemCount })}</p>
      </header>

      {/* HISTORY timeline */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-bold tracking-[0.05em] text-(--el-text-faint) uppercase">
          {t('history')}
        </h3>
        <ol className="flex flex-col gap-2">
          {review.history.map((ev) => (
            <HistoryRow key={ev.kind} ev={ev} t={t} />
          ))}
          {!decided ? (
            <li className="flex items-center gap-2 text-sm text-(--el-text-muted)">
              <span
                className="size-1.5 shrink-0 rounded-full bg-(--el-border-strong)"
                aria-hidden
              />
              {t('awaitingReview')}
            </li>
          ) : null}
        </ol>
      </section>

      {/* STALENESS summary */}
      {review.stale ? (
        <section
          data-testid="stale-summary"
          className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-yellow)/40 p-3"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {t('staleSummary', { n: review.staleCount })}
          </p>
          <ul className="flex flex-col gap-1">
            {staleItems.map((item) => (
              <li key={item.planItemId} className="text-xs text-(--el-text-secondary)">
                <span className="font-medium text-(--el-text)">{item.title}</span>
                {' — '}
                {item.staleReasons.map((r) => staleReasonLabel(r, t)).join(', ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The decision GATE (or the decided outcome). */}
      <div className="mt-auto flex flex-col gap-2">
        {errorCode ? (
          <p role="alert" className="text-xs font-medium text-(--el-danger-text)">
            {t('actionError')}
          </p>
        ) : null}
        {decided ? (
          <DecidedOutcome review={review} t={t} />
        ) : (
          <>
            <Button
              variant="primary"
              onClick={onApprove}
              disabled={!planned || busy}
              loading={busy}
              leftIcon={<Check className="size-4" aria-hidden="true" />}
            >
              {t('approveCta', { n: review.itemCount })}
            </Button>
            <Button
              variant="ghost"
              onClick={onDecline}
              disabled={!planned || busy}
              leftIcon={<X className="size-4" aria-hidden="true" />}
            >
              {t('declineCta')}
            </Button>
            <p className="text-center text-xs text-(--el-text-muted)">
              {planned
                ? review.stale
                  ? t('approveHintStale', { n: review.staleCount })
                  : t('approveHint')
                : t('reviewLocked')}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

function HistoryRow({ ev, t }: { ev: PlanHistoryEventDto; t: ReturnType<typeof useTranslations> }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--el-accent)" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="text-(--el-text)">
          {t(`event_${ev.kind}`)}
          {ev.byName ? <span className="text-(--el-text-muted)"> · {ev.byName}</span> : null}
        </span>
        <span className="text-xs text-(--el-text-faint)">{formatAt(ev.at)}</span>
      </div>
    </li>
  );
}

function DecidedOutcome({
  review,
  t,
}: {
  review: PlanReviewDto;
  t: ReturnType<typeof useTranslations>;
}) {
  const approved = review.status === 'approved';
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text)">
        {approved ? (
          <Sparkles className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
        ) : (
          <X className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden="true" />
        )}
        {approved ? t('approvedOutcome', { n: review.itemCount }) : t('declinedOutcome')}
      </p>
      {approved ? (
        <Link
          href="/items"
          className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('viewInBacklog')}
        </Link>
      ) : null}
    </div>
  );
}
