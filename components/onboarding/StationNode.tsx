'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  MapPin,
  Network,
  Palette,
  Search,
  Shapes,
  Shield,
  Sparkles,
} from 'lucide-react';
import {
  type DirectionDocKind,
  type DirectionDocView,
  TIER_META,
} from '@/lib/onboarding/directionDoc';
import type { DiscoverySession } from '@/lib/onboarding/discoveryLoop';
import { type StationKind, type StationView, captureLines } from '@/lib/onboarding/canvasModel';

// The CONTENT of a canvas node (Subtask 7.3.11 / MOTIR-840) — the station card the
// onboarding canvas (`OnboardingCanvas`) renders inside each `PlanningCanvas`
// node. The canvas owns the box, position + drag; this owns the card's look: the
// tier-coloured tile, title + subtitle, state pill (Reviewed / You-are-here /
// Deciding), and the captured-findings rows. Tokens only (`--el-*` + shape).

const ICON: Record<StationKind, LucideIcon> = {
  discovery: Search,
  vision: Shapes,
  feasibility: Shield,
  validation: ListChecks,
  design: Palette,
  plan: Network,
};

const TIER_TINT: Record<DirectionDocKind, string> = {
  discovery: 'bg-(--el-tint-sky)',
  vision: 'bg-(--el-tint-lavender)',
  feasibility: 'bg-(--el-tint-mint)',
  validation: 'bg-(--el-tint-peach)',
};

function isTierKind(kind: StationKind): kind is DirectionDocKind {
  return kind in TIER_META;
}

export function IdeaCard({ idea }: { idea: string }) {
  const t = useTranslations('onboarding.chat.canvas');
  return (
    <div className="w-[200px] rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-subtle)">
      <div className="flex items-center gap-2">
        <span
          className="flex size-7 items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-(--el-accent-text)"
          aria-hidden="true"
        >
          <Lightbulb className="size-4" />
        </span>
        <span className="font-mono text-xs text-(--el-text-faint)">{t('ideaLabel')}</span>
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm text-(--el-text-secondary) italic">“{idea}”</p>
    </div>
  );
}

export function StationCard({
  station,
  doc,
  session,
}: {
  station: StationView;
  doc: DirectionDocView | undefined;
  session: DiscoverySession;
}) {
  const t = useTranslations('onboarding.chat.canvas');
  const Icon = ICON[station.kind];
  const tierKind: DirectionDocKind | null = isTierKind(station.kind) ? station.kind : null;
  const active = station.state === 'active' || station.state === 'deciding';
  const title = tierKind ? TIER_META[tierKind].label : t(`stations.${station.kind}.title`);
  const subtitle = t(`stations.${station.kind}.subtitle`);
  const showCaptured = tierKind !== null && (station.state === 'done' || active);

  return (
    <div
      className={[
        'w-[300px] rounded-(--radius-card) border p-(--spacing-card-padding)',
        active
          ? 'border-(--el-accent) bg-(--el-surface-soft) shadow-(--shadow-card)'
          : station.state === 'upcoming'
            ? 'border-(--el-border-soft) bg-(--el-surface) opacity-80'
            : 'border-(--el-border-soft) bg-(--el-surface) shadow-(--shadow-subtle)',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) ${
            tierKind ? TIER_TINT[tierKind] : 'bg-(--el-muted)'
          }`}
          style={
            tierKind
              ? ({ color: `var(${TIER_META[tierKind].accentVar})` } as CSSProperties)
              : undefined
          }
          aria-hidden="true"
        >
          <Icon className={tierKind ? 'size-4.5' : 'size-4 text-(--el-text-faint)'} />
        </span>
        <div className="min-w-0 flex-1">
          {/* The title wraps in full (no truncation) — step names must read whole. */}
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="text-sm leading-snug font-semibold text-(--el-text)">{title}</span>
            {station.optional && station.state === 'upcoming' && (
              <span className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-secondary)">
                {t('canSkip')}
              </span>
            )}
          </div>
          <span className="mt-0.5 block text-xs text-(--el-text-muted)">{subtitle}</span>
        </div>
        <StatePill state={station.state} />
      </div>

      {showCaptured && (
        <CapturedFindings
          kind={tierKind!}
          doc={doc}
          session={session}
          deciding={station.state === 'deciding'}
        />
      )}
    </div>
  );
}

function StatePill({ state }: { state: StationView['state'] }) {
  const t = useTranslations('onboarding.chat.canvas');
  if (state === 'done') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        <Check className="size-3.5" aria-hidden="true" />
        {t('pills.reviewed')}
      </span>
    );
  }
  if (state === 'deciding') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        <Sparkles className="size-3.5" aria-hidden="true" />
        {t('pills.deciding')}
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        <MapPin className="size-3.5" aria-hidden="true" />
        {t('pills.here')}
      </span>
    );
  }
  return null;
}

function CapturedFindings({
  kind,
  doc,
  session,
  deciding,
}: {
  kind: DirectionDocKind;
  doc: DirectionDocView | undefined;
  session: DiscoverySession;
  deciding: boolean;
}) {
  const t = useTranslations('onboarding.chat.canvas');
  const facts: string[] = [];
  if (kind === 'discovery') {
    if (session.classification) facts.push(`${t('facts.type')} — ${session.classification}`);
    if (session.platform) facts.push(`${t('facts.platform')} — ${session.platform}`);
  }
  const lines = [...facts, ...captureLines(doc?.contentMd)];
  if (lines.length === 0 && !deciding) return null;

  return (
    <div className="mt-2.5 flex flex-col gap-1.5 border-t border-(--el-border-soft) pt-2.5">
      {lines.map((line, i) => (
        <div key={i} className="flex items-start gap-1.5 text-xs text-(--el-text-secondary)">
          <Check className="mt-0.5 size-3.5 shrink-0 text-(--el-success)" aria-hidden="true" />
          <span className="min-w-0">{line}</span>
        </div>
      ))}
      {deciding && (
        <div className="flex items-start gap-1.5 text-xs text-(--el-text-strong)">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-(--el-warning)"
            aria-hidden="true"
          />
          <span className="min-w-0">{t('validateFirstHint')}</span>
        </div>
      )}
    </div>
  );
}
