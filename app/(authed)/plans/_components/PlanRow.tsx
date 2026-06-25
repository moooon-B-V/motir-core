'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type { PlanStatusDto } from '@/lib/dto/plans';

import type { PlanRowView } from './types';

// One Plans-list row (Subtask 7.21.1 / MOTIR-1338), built to the 843 design
// (`design/ai-planning/plans-surface.mock.html`, Panel A). Pure presentational —
// it binds the server-built `PlanRowView` (no service access, no relative-time
// derivation). The whole row is a single `<Link>` into the plan detail
// (MOTIR-847) — the access path. Status + staleness are conveyed by TEXT in the
// pills, not colour alone (the a11y rule); every colour routes through `--el-*`.

const STATUS_ICON: Record<PlanStatusDto, typeof Clock> = {
  generating: Loader2,
  planned: Clock,
  approved: CheckCircle2,
  declined: XCircle,
};

// The status hue lives in the icon-square TINT (charcoal/strong ink on top stays
// AA — finding #35); the declined square is a quiet muted fill, not a tint,
// matching the design's inactive-outcome treatment.
const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky)',
  planned: 'bg-(--el-tint-lavender)',
  approved: 'bg-(--el-tint-mint)',
  declined: 'bg-(--el-muted)',
};

/** The status pill, mapped to the shipped `Pill` tones the design specifies:
 *  generating→info(sky), planned→lavender, approved→success(mint),
 *  declined→archived(quiet muted). */
function StatusPill({ status, label }: { status: PlanStatusDto; label: string }) {
  if (status === 'generating') return <Pill severity="info">{label}</Pill>;
  if (status === 'planned') return <Pill status="planned">{label}</Pill>;
  if (status === 'approved') return <Pill severity="success">{label}</Pill>;
  return <Pill tone="archived">{label}</Pill>; // declined
}

export function PlanRow({ view }: { view: PlanRowView }) {
  const t = useTranslations('aiPlanning');
  const Icon = STATUS_ICON[view.status];
  const title = view.title || t('untitledPlan');
  // A `planned` plan is the one awaiting the user's review — the design gives it
  // an accent border so it stands out from decided/generating rows.
  const awaitingReview = view.status === 'planned';

  return (
    <Link
      href={`/plans/${view.id}`}
      className={cn(
        'flex items-center gap-3 rounded-(--radius-card) border bg-(--el-surface)',
        'px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle)',
        'transition-colors hover:border-(--el-border-strong)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
        awaitingReview ? 'border-(--el-accent)' : 'border-(--el-border)',
      )}
    >
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control)',
          STATUS_TINT[view.status],
        )}
        aria-hidden
      >
        <Icon
          className={cn(
            'h-4 w-4 text-(--el-text-strong)',
            view.status === 'generating' && 'animate-spin',
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-(--el-text)">{title}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-muted)">
          <span>{t('itemCount', { count: view.itemCount })}</span>
          <span>{t(view.whenKey, { when: view.whenLabel })}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {view.staleCount > 0 ? (
          <Pill severity="warning">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t('mayBeOutOfDate', { count: view.staleCount })}
          </Pill>
        ) : null}
        <StatusPill status={view.status} label={t(`status.${view.status}`)} />
      </div>
    </Link>
  );
}
