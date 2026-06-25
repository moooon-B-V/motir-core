'use client';

import { ArrowRight, Layers } from 'lucide-react';
import type { RoadmapLevelItem } from '@/lib/planning/roadmapClient';

// The "Your plan" PREVIEW cluster (Subtask 7.20.2 / MOTIR-1194 + the 1333 design)
// — the partial work-item glimpse the onboarding canvas shows at the top level
// instead of fanning every epic out. It signals "there's a plan here, explore it":
// a summary (N epics · K done) + the first few epic mini-rows + a "+N more" tile +
// an Explore affordance. The whole node is drillable — activating it opens the
// full per-level roadmap (it reads only the epic ROOTS, so a huge plan still inits
// instantly). Tokens only.

const PREVIEW = 4; // epic mini-rows before the "+N more" tile

export function PlanPreview({ epics }: { epics: RoadmapLevelItem[] }) {
  const total = epics.length;
  const done = epics.filter((e) => e.status === 'done').length;
  const shown = epics.slice(0, PREVIEW);
  const more = total - shown.length;

  return (
    <div className="w-[44rem] max-w-[90vw] rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-card)">
      <div className="flex items-center gap-2.5">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-rose)"
          aria-hidden="true"
        >
          <Layers className="size-4.5 text-(--el-type-epic)" />
        </span>
        <div className="min-w-0">
          <span className="block text-sm font-semibold text-(--el-text)">Your plan</span>
          <span className="block text-xs text-(--el-text-muted)">
            {total} {total === 1 ? 'epic' : 'epics'} · {done} done
          </span>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) py-(--spacing-btn-y) text-xs font-semibold text-(--el-accent-text)">
          Explore the plan
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((e) => (
          <div
            key={e.id}
            className="rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full bg-(--el-type-epic)"
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] text-(--el-text-faint)">{e.identifier}</span>
            </div>
            <span className="mt-1 line-clamp-2 block text-xs font-semibold text-(--el-text)">
              {e.title}
            </span>
          </div>
        ))}
        {more > 0 && (
          <div className="flex items-center justify-center rounded-(--radius-control) border border-dashed border-(--el-border) bg-(--el-surface-soft) px-2.5 py-2 text-xs font-semibold text-(--el-accent-on-surface)">
            + {more} more {more === 1 ? 'epic' : 'epics'}
          </div>
        )}
      </div>
    </div>
  );
}
