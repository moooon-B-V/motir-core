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

// The PLANNING-ORIGIN cluster (Subtask 7.20.6 / MOTIR-1013) — a COLLAPSED summary
// of the completed pre-plan journey, pinned at the ROAD'S START on the persistent
// project roadmap. By the time the roadmap exists, the 7.3 onboarding stages
// (Idea → Discover · Shape · Validate → Plan) are all DONE, so this is a compact
// "you came from here" milestone strip — NOT the live onboarding station board
// (`OnboardingCanvas`). It composes the same station language (the tier lucide
// icons + the done check) into one fixed node the canvas places left of the epics.
//
// Presentational + static: the stages of the journey are fixed, so this needs no
// onboarding-state read — it marks the origin, the epics flow rightward from it.
// Tokens only (`--el-*` + shape).

// The fixed station/node size the canvas frames this at (a hint for the
// once-only fit-to-view). Wider than a work-item card — it holds the 5 stages.
export const ORIGIN_W = 360;
export const ORIGIN_H = 124;

interface Stage {
  /** Also the `roadmap.canvas.origin.<key>` i18n key for the stage label. */
  key: string;
  Icon: LucideIcon;
}

// The 7.3 planning stages, in journey order. Idea seeds the four direction tiers
// (collapsed here to Discover · Shape · Validate), which feed Plan — the same
// order the onboarding canvas model (`STATION_ORDER`) walks. The `key` doubles as
// the i18n key for the label (`roadmap.canvas.origin.<key>`).
const STAGES: readonly Stage[] = [
  { key: 'idea', Icon: Lightbulb },
  { key: 'discover', Icon: Search },
  { key: 'shape', Icon: Shapes },
  { key: 'validate', Icon: ListChecks },
  { key: 'plan', Icon: Network },
];

export function PlanningOriginCluster() {
  const t = useTranslations('roadmap.canvas.origin');
  return (
    <div
      style={{ width: ORIGIN_W, height: ORIGIN_H }}
      data-testid="planning-origin"
      // The same raised-tile language as the work-item card (crisp border +
      // card shadow on the recessed canvas board, MOTIR-1362) so the origin reads
      // as a node on the same surface.
      className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-3.5 shadow-(--shadow-card)"
    >
      {/* HEADER — labels the cluster + states the journey is complete. */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[10.5px] font-bold tracking-[0.05em] text-(--el-text-faint) uppercase">
          {t('planning')}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-medium text-(--el-text-strong)">
          <Check className="size-3" aria-hidden="true" />
          {t('complete')}
        </span>
      </div>

      {/* STAGES — the 7.3 milestones, each DONE (a mint tile + a tiny check), with
          a faint arrow between them so the strip reads as the road leading in. */}
      <div className="mt-1.5 flex min-h-0 flex-1 items-center justify-between gap-1">
        {STAGES.map((stage, i) => (
          <div key={stage.key} className="flex min-w-0 items-center gap-1">
            <Milestone label={t(stage.key)} Icon={stage.Icon} />
            {i < STAGES.length - 1 ? (
              <ArrowRight className="size-3 shrink-0 text-(--el-text-faint)" aria-hidden="true" />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One completed planning stage — a mint (done) icon tile with a corner check and
 *  a tiny label beneath. */
function Milestone({ label, Icon }: { label: string; Icon: LucideIcon }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1">
      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint)">
        <Icon className="size-4 text-(--el-text-strong)" aria-hidden="true" />
        <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-(--el-success)">
          <Check className="size-2.5 text-(--el-accent-text)" aria-hidden="true" />
        </span>
      </span>
      <span className="max-w-full truncate text-[10px] font-medium text-(--el-text-secondary)">
        {label}
      </span>
    </div>
  );
}
