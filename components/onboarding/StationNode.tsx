'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Check,
  CornerUpLeft,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  MapPin,
  Network,
  Palette,
  RotateCw,
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
import { Spinner } from '@/components/ui/Spinner';

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

// The tier tile takes its OWN per-tier element token (Story 1266.6 / MOTIR-1277)
// rather than borrowing the generic `--el-tint-*` pool — so a palette can give
// each onboarding tier a distinct hue. Defaults map to today's exact tints
// (zero visual change). NB: NOT `--el-roadmap-*` — that family is the public
// roadmap, a different concept (see design/design-system/design-notes.md §H).
const TIER_TINT: Record<DirectionDocKind, string> = {
  discovery: 'bg-(--el-station-tier-discovery)',
  vision: 'bg-(--el-station-tier-vision)',
  feasibility: 'bg-(--el-station-tier-feasibility)',
  validation: 'bg-(--el-station-tier-validation)',
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
  onOpenDesign,
  revisiting = false,
  refreshing = false,
}: {
  station: StationView;
  doc: DirectionDocView | undefined;
  session: DiscoverySession;
  /** Present on the `design` station — opens the web-only design step (MOTIR-1040). */
  onOpenDesign?: () => void;
  /** This tier is the cascade-back target (G3, MOTIR-1179) — "Revisiting". */
  revisiting?: boolean;
  /** This tier re-derives downstream of the cascade — "Will refresh". */
  refreshing?: boolean;
}) {
  const t = useTranslations('onboarding.chat.canvas');
  const tr = useTranslations('onboarding.chat.revisions');
  const Icon = ICON[station.kind];
  const tierKind: DirectionDocKind | null = isTierKind(station.kind) ? station.kind : null;
  const active = station.state === 'active' || station.state === 'deciding';
  // A tier mid-draft is the live frontier too — ring it like "active" while it
  // loads (it just shows "Drafting now…" instead of a settled pill).
  const ringed = active || station.state === 'working';
  const title = tierKind ? TIER_META[tierKind].label : t(`stations.${station.kind}.title`);
  const subtitle = t(`stations.${station.kind}.subtitle`);
  const showCaptured = tierKind !== null && (station.state === 'done' || active);
  const isDesign = station.kind === 'design';

  return (
    <div
      className={[
        'w-[300px] rounded-(--radius-card) border p-(--spacing-card-padding)',
        revisiting
          ? 'border-(--el-border-strong) bg-(--el-tint-peach) shadow-(--shadow-card)'
          : ringed
            ? 'border-(--el-accent) bg-(--el-surface-soft) shadow-(--shadow-card)'
            : station.state === 'upcoming'
              ? 'border-(--el-border-soft) bg-(--el-surface) opacity-80'
              : 'border-(--el-border-soft) bg-(--el-surface) shadow-(--shadow-subtle)',
      ].join(' ')}
    >
      {(revisiting || refreshing) && (
        <div
          className={`mb-2 inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong) ${
            revisiting ? 'bg-(--el-surface)' : 'bg-(--el-tint-sky)'
          }`}
        >
          {revisiting ? (
            <CornerUpLeft className="size-3.5" aria-hidden="true" />
          ) : (
            <RotateCw className="size-3.5" aria-hidden="true" />
          )}
          {revisiting ? tr('revisitingLabel') : tr('willRefreshLabel')}
        </div>
      )}

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
      </div>

      {showCaptured && (
        <CapturedFindings
          kind={tierKind!}
          doc={doc}
          session={session}
          deciding={station.state === 'deciding'}
        />
      )}

      {isDesign && onOpenDesign && (
        // The in-block door to the design step (MOTIR-1040). `stopPropagation` on
        // pointer-down so the canvas drag/activate gesture doesn't also fire — the
        // button is the sole handler for its own hit area.
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenDesign();
          }}
          className="mt-2.5 inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) text-xs font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <Palette className="size-4" aria-hidden="true" />
          {t('stations.design.cta')}
        </button>
      )}

      {/* The state marker sits in the card's bottom-right corner (design `ai-chat`:
          a map-pin + "You are here", pairing the ringed border). Kept off the
          title's row so a longer step name keeps the full card width instead of a
          `shrink-0` pill squeezing it to several lines (MOTIR-1258). "upcoming" has
          no pill, so the footer is omitted entirely. */}
      {station.state !== 'upcoming' && (
        <div className="mt-2.5 flex justify-end">
          <StatePill state={station.state} />
        </div>
      )}
    </div>
  );
}

function StatePill({ state }: { state: StationView['state'] }) {
  const t = useTranslations('onboarding.chat.canvas');
  const tc = useTranslations('onboarding.chat');
  if (state === 'working') {
    // The conductor is mid-draft on this tier — a LOADING pill that mirrors the
    // chat rail's drafting indicator (same "Drafting now…" copy + spinner), not a
    // settled "you are here".
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
        <Spinner size="sm" aria-hidden="true" />
        {tc('drafting')}
      </span>
    );
  }
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
