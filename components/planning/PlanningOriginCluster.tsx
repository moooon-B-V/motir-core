'use client';

import {
  ArrowRight,
  Check,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Network,
  Search,
  Shapes,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DIRECTION_DOC_ORDER, type DirectionDocKind } from '@/lib/onboarding/directionDoc';

// The PLANNING-ORIGIN cluster (Subtask 7.20.6 / MOTIR-1013) — a COLLAPSED summary
// of the completed pre-plan journey, pinned at the ROAD'S START on the persistent
// project roadmap. By the time the roadmap exists, the 7.3 onboarding stages
// (Idea → Discover · Shape · Validate → Plan) are all DONE, so this is a compact
// "you came from here" milestone strip — NOT the live onboarding station board
// (`OnboardingCanvas`). It composes the same station language (the tier lucide
// icons + the done check) into one fixed node the canvas places left of the epics.
//
// THE BADGE FOLLOWS THE DOCUMENTS, NOT THE MARKER (MOTIR-2205 / design
// `design/roadmap/planning-origin-drill.*` panel D). `showPlanningOrigin` — the
// project's immutable `onboardingRanAt` marker (MOTIR-1264) — stays the gate on
// WHETHER this card renders, and this component does not touch it. But the marker
// records that the journey RAN, not what it produced, so an unconditional mint
// "Complete" + five checks asserts four documents a marker-stamped-but-empty
// project (the migrate population) does not have. What the card ASSERTS therefore
// follows the PRODUCED SET the consumer resolves and passes down:
//
//   4 produced  → the shipped mint `Complete` verdict (unchanged)
//   1–3         → the neutral `{n} of 4 docs` COUNT — the fact it can prove
//   0           → the neutral `No docs`
//   unresolved  → NO chip at all (the read is in flight, or motir-ai is down —
//                 the card can never claim anything before it knows)
//
// `Idea` and `Plan` keep their checks in every state: the marker is set on first
// plan approve/materialize, so it genuinely attests both. The three tier stages
// (Discover · Shape · Validate) check only when their tier produced a document —
// the strip stays provenance, never an error state.
//
// Presentational: the read itself belongs to the consumer (`WorkItemRoadmap`),
// which resolves it LATE so nothing here blocks the roadmap's first paint
// (the MOTIR-2069 streaming lesson). Tokens only (`--el-*` + shape).

// The fixed station/node size the canvas frames this at (a hint for the
// once-only fit-to-view). Wider than a work-item card — it holds the 5 stages.
export const ORIGIN_W = 360;
export const ORIGIN_H = 124;

interface Stage {
  /** Also the `roadmap.canvas.origin.<key>` i18n key for the stage label. */
  key: string;
  Icon: LucideIcon;
  /**
   * The direction tiers this stage collapses. A stage is CHECKED when any of them
   * produced a document. Empty = always checked: `idea` and `plan` are attested by
   * the onboarding-ran marker itself (it is stamped on first plan
   * approve/materialize), not by a tier doc, so they never go absent.
   */
  tiers: readonly DirectionDocKind[];
}

// The 7.3 planning stages, in journey order. Idea seeds the four direction tiers
// (collapsed here to Discover · Shape · Validate), which feed Plan — the same
// order the onboarding canvas model (`STATION_ORDER`) walks. The `key` doubles as
// the i18n key for the label (`roadmap.canvas.origin.<key>`).
const STAGES: readonly Stage[] = [
  { key: 'idea', Icon: Lightbulb, tiers: [] },
  { key: 'discover', Icon: Search, tiers: ['discovery'] },
  { key: 'shape', Icon: Shapes, tiers: ['vision'] },
  // The two late tiers collapse into ONE stage, so it checks when EITHER produced:
  // `feasibility` is optional and legitimately skipped, and requiring both would
  // report a skipped step as a missing one.
  { key: 'validate', Icon: ListChecks, tiers: ['feasibility', 'validation'] },
  { key: 'plan', Icon: Network, tiers: [] },
];

export interface PlanningOriginClusterProps {
  /**
   * The direction tiers this project's pre-plan journey actually PRODUCED, or
   * `null` while the read is still in flight / failed (motir-ai down). The
   * consumer owns that read and resolves it late; `null` is the honest
   * chip-less state, `[]` is a resolved-and-empty journey ("No docs").
   */
  produced?: readonly DirectionDocKind[] | null;
}

export function PlanningOriginCluster({ produced = null }: PlanningOriginClusterProps = {}) {
  const t = useTranslations('roadmap.canvas.origin');
  const producedSet = produced ? new Set(produced) : null;
  // Count only the FOUR direction tiers, so an unexpected extra kind can never
  // inflate the count past the "of 4" the copy promises.
  const count = producedSet
    ? DIRECTION_DOC_ORDER.filter((kind) => producedSet.has(kind)).length
    : null;
  return (
    <div
      style={{ width: ORIGIN_W, height: ORIGIN_H }}
      data-testid="planning-origin"
      // The same raised-tile language as the work-item card (crisp border +
      // card shadow on the recessed canvas board, MOTIR-1362) so the origin reads
      // as a node on the same surface.
      className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-3.5 shadow-(--shadow-card)"
    >
      {/* HEADER — labels the cluster + reports what the journey actually produced.
          The chip is omitted entirely until the produced set resolves, so the card
          never asserts a verdict it cannot yet prove (design panel D). */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-faint) uppercase">
          {t('planning')}
        </span>
        {count === DIRECTION_DOC_ORDER.length ? (
          <span
            data-testid="planning-origin-chip"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-transparent bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-medium text-(--el-text-strong)"
          >
            <Check className="size-3" aria-hidden="true" />
            {t('complete')}
          </span>
        ) : count !== null ? (
          // The neutral COUNT / no-docs chip — the `Pill` tone="neutral" recipe, so
          // it reports a fact without reading as a fault.
          <span
            data-testid="planning-origin-chip"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-medium text-(--el-text-secondary)"
          >
            {count === 0 ? t('noDocs') : t('docsCount', { count })}
          </span>
        ) : null}
      </div>

      {/* STAGES — the 7.3 milestones, with a faint arrow between them so the strip
          reads as the road leading in. A stage whose tier produced a document is
          DONE (a mint tile + a tiny check); one whose tier produced nothing keeps
          its plate but loses the hue and the check. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-center justify-between gap-1">
        {STAGES.map((stage, i) => (
          <div key={stage.key} className="flex min-w-0 items-center gap-1">
            <Milestone
              label={t(stage.key)}
              Icon={stage.Icon}
              done={
                stage.tiers.length === 0 ||
                (producedSet !== null && stage.tiers.some((kind) => producedSet.has(kind)))
              }
            />
            {i < STAGES.length - 1 ? (
              <ArrowRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One planning stage — a mint (done) icon tile with a corner check and a tiny
 *  label beneath, or, when its tier produced nothing, the same plate with no hue,
 *  no check and a muted glyph. */
function Milestone({ label, Icon, done }: { label: string; Icon: LucideIcon; done: boolean }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <span
        data-stage-done={done || undefined}
        className={`relative flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) border ${
          done
            ? 'border-transparent bg-(--el-tint-mint)'
            : 'border-(--el-chip-border) bg-(--el-chip-bg)'
        }`}
      >
        <Icon
          className={`size-4 ${done ? 'text-(--el-text-strong)' : 'text-(--el-icon-muted)'}`}
          aria-hidden="true"
        />
        {done && (
          <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-(--el-success)">
            <Check className="size-2.5 text-(--el-accent-text)" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-[10px] font-medium text-(--el-text-secondary)">
        {label}
      </span>
    </div>
  );
}
