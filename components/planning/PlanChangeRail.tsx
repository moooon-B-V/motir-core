'use client';

import { useTranslations } from 'next-intl';
import { MessageSquareDashed } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { PlanningLaunch, PlanningMode } from '@/lib/planning/launcher';

// The planning workspace's CHAT PANE on an established project (Subtask
// MOTIR-1729). It renders the rail's shipped language — the `--el-success`
// status dot + the mono uppercase "Motir AI" header, plus the per-mode chip
// (design `plan-change-conversation.mock.html` panel 2 / the rail header) — and
// states, HONESTLY, that the conversation itself is not available on this
// surface yet.
//
// This card owns the HOST and the mode/context wiring only; the multi-turn
// conversation (composer, streamed delta, in-canvas diff, approve/discard) is
// MOTIR-1730, which replaces this component. Until then the rail must not
// pretend to accept a message it cannot send — so there is no composer, and the
// copy says what the surface can and cannot do.

export interface PlanChangeRailProps {
  launch: PlanningLaunch;
  projectName: string;
}

// The mode chip's label key, per resolved mode. A lookup (not a template) so the
// key set stays greppable and the i18n catalog can't silently lose an arm.
const MODE_LABEL_KEY: Record<PlanningMode, string> = {
  project: 'mode.project',
  generation: 'mode.generation',
  replan: 'mode.replan',
  contextual: 'mode.contextual',
  roadmap: 'mode.roadmap',
};

// The opening line, per mode — this is what makes the launcher's context VISIBLE
// on the surface: the mode the door resolved, and the item it was scoped to.
const MODE_LEAD_KEY: Record<PlanningMode, string> = {
  project: 'lead.project',
  generation: 'lead.generation',
  replan: 'lead.replan',
  contextual: 'lead.contextual',
  roadmap: 'lead.roadmap',
};

/** The originating DETAIL wins over the mode's generic line when one was carried
 *  (a work item, a repo) — both resolve to the `contextual` mode, so the mode
 *  alone can't say which. */
function leadKey(launch: PlanningLaunch): string {
  if (launch.itemKey) return 'lead.contextualItem';
  if (launch.repoKey) return 'lead.conventionRefine';
  return MODE_LEAD_KEY[launch.mode];
}

export function PlanChangeRail({ launch, projectName }: PlanChangeRailProps) {
  const t = useTranslations('planningWorkspace');
  const modeLabel = t(MODE_LABEL_KEY[launch.mode]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-(--el-border) bg-(--el-surface)"
      aria-label={t('railLabel')}
    >
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="size-2 rounded-full bg-(--el-success)" aria-hidden="true" />
        <span className="font-mono text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
          {t('railLabel')}
        </span>
        <Pill tone="neutral" className="ml-auto" data-testid="planning-mode-chip">
          {modeLabel}
        </Pill>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <p className="text-sm text-(--el-text-secondary)">
          {t(leadKey(launch), {
            project: projectName,
            item: launch.itemKey ?? '',
            repo: launch.repoKey ?? '',
          })}
        </p>

        <div className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-3 py-3">
          <div className="flex items-center gap-2 text-(--el-text)">
            <MessageSquareDashed className="h-4 w-4 shrink-0" aria-hidden />
            <span className="text-sm font-semibold">{t('railEmptyTitle')}</span>
          </div>
          <p className="text-sm text-(--el-text-muted)">{t('railEmptyDescription')}</p>
        </div>
      </div>
    </aside>
  );
}
