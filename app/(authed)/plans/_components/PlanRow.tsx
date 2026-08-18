'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  RotateCw,
  Sparkles,
  XCircle,
} from 'lucide-react';

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

/**
 * The plan's ATTRIBUTION — who asked for it and who wrote it (MOTIR-2991,
 * `design/ai-planning/design-notes.md` Part III).
 *
 * One entry in the row's existing meta line, never a pill: a second chip beside
 * the status pill reads as part of the status. Both halves are optional and the
 * entry renders NOTHING when neither is known — the *unattributed* state is an
 * absence, not a placeholder, because a placeholder in a scanned list is a value
 * the reader has to learn to ignore.
 *
 * ⚠️ A DECIDED row shows the DECIDER, not the requester (Part III §3). The row
 * already ends `approved yesterday` / `declined 3 days ago`, and while a plan is
 * undecided *who asked* is what you weigh — once it is decided, *who decided* is
 * the operative fact and the requester is history. Dropping it also stops two
 * bare person names landing in one scanned line, where a reader cannot tell
 * which one holds which role.
 *
 * The glyphs are DECORATIVE (`aria-hidden`, `--el-text-faint`): the words carry
 * the meaning, so neither party is ever conveyed by icon or colour alone.
 */
function PlanAttribution({ view }: { view: PlanRowView }) {
  const t = useTranslations('aiPlanning');
  const decided = view.status === 'approved' || view.status === 'declined';

  // WHO WROTE it. `mcp` + a harness is an agent; Motir is read off `sourceJobId`
  // and NOT off `authorSource === 'native'`, which no shipped writer produces
  // (the generator path is not retrofitted — MOTIR-2996).
  const agent =
    view.authorSource === 'mcp' && view.authorHarness
      ? { Icon: Bot, label: t('viaHarness', { harness: view.authorHarness }), truncates: true }
      : view.sourceJobId != null
        ? { Icon: Sparkles, label: t('viaMotir'), truncates: false }
        : null;

  // WHO ASKED — suppressed once decided, and replaced by the cadence marker when
  // nobody asked at all.
  const requester = decided
    ? null
    : view.origin === 'cadence'
      ? { kind: 'cadence' as const }
      : view.createdByName
        ? { kind: 'person' as const, name: view.createdByName }
        : null;

  if (!requester && !agent) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {requester?.kind === 'person' ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {requester.name.charAt(0).toUpperCase()}
          </span>
          <b className="max-w-[10rem] truncate font-semibold" title={requester.name}>
            {requester.name}
          </b>
        </>
      ) : null}
      {requester?.kind === 'cadence' ? (
        <>
          <RotateCw className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          {t('autoPlanned')}
        </>
      ) : null}
      {requester && agent ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {agent ? (
        <>
          <agent.Icon className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          <span
            className={cn('min-w-0', agent.truncates && 'max-w-[12rem] truncate')}
            title={agent.truncates ? (view.authorHarness ?? undefined) : undefined}
          >
            {agent.label}
          </span>
        </>
      ) : null}
    </span>
  );
}

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
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          <span>{t('itemCount', { count: view.itemCount })}</span>
          <span>{t(view.whenKey, { when: view.whenLabel })}</span>
          <PlanAttribution view={view} />
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
