'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Info, Plus, Sparkles } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { AI_PLANNING_SETTINGS_HREF } from './aiSprintPlanShared';

// THE DOOR (Subtask MOTIR-1750) — the shipped create-sprint strip, now a
// TWO-ACTION strip (design/ai-planning/sprint-planning panel 0).
//
// Left: the shipped `＋ Create sprint`, unchanged, taking the free space. A 1px
// `--el-border-strong` divider. Right: **Plan sprints with Motir** — lavender
// fill + accent ink + the `Sparkles` glyph, the treatment every other AI
// affordance in this app carries. The strip keeps its single dashed
// `--el-border-strong` / `--radius-card` silhouette, so the page's rhythm is
// unchanged.
//
// WHY HERE (and not a route of its own): `/backlog` IS the sprint-planning
// surface, and approving performs exactly the two gestures this strip already
// owns — `createSprint` and `bulkAssignToSprint`. AI sprint planning is the
// automated form of the host's own two actions, so the door belongs beside the
// manual one. It earns no left-nav entry: a nav entry is this app's convention
// for a first-class project VIEW, and this is an action on the backlog's own
// objects, the same class as Start sprint and Complete sprint.
//
// OFF STATE: the door is PRESENT AND DISABLED, never hidden — a hidden control
// cannot teach that the capability exists, and the settings page already
// promises it. The hint below carries the fix and links to the switch.

export function CreateSprintStrip({
  onCreated,
  aiEnabled,
  aiAvailable,
  onPlanSprints,
  planning,
}: {
  /** Refresh the sprint list after the manual create. */
  onCreated: () => Promise<void>;
  /** `aiSprintPlanningEnabled` — off ⇒ the AI door renders disabled + the hint.
   *  The submit throws `SprintPlanningDisabledError` when off, so the UI must not
   *  offer the action then. */
  aiEnabled: boolean;
  /** Whether Motir AI is wired at all (self-host / unconfigured). Not wired ⇒ no
   *  AI door and no hint: there is nothing for the user to switch on. */
  aiAvailable: boolean;
  /** Start a run. */
  onPlanSprints: () => void;
  /** A run is already in flight — the door is held disabled meanwhile. */
  planning: boolean;
}) {
  const t = useTranslations('backlog');

  return (
    <div className="flex flex-col">
      <div className="flex w-full items-stretch overflow-hidden rounded-(--radius-card) border border-dashed border-(--el-border-strong)">
        <CreateSprintButton onCreated={onCreated} />
        {aiAvailable ? (
          <>
            <span aria-hidden className="w-px shrink-0 bg-(--el-border-strong) opacity-70" />
            <button
              type="button"
              onClick={onPlanSprints}
              disabled={!aiEnabled || planning}
              title={aiEnabled ? undefined : t('aiPlan.offTitle')}
              data-testid="plan-sprints-with-motir"
              className={`inline-flex shrink-0 items-center justify-center gap-2 px-6 py-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
                aiEnabled
                  ? 'bg-(--el-tint-lavender) text-(--el-accent-on-surface)'
                  : 'cursor-not-allowed bg-(--el-muted) text-(--el-text-faint)'
              } disabled:cursor-not-allowed`}
            >
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
              {t('aiPlan.cta')}
            </button>
          </>
        ) : null}
      </div>

      {aiAvailable && !aiEnabled ? (
        <div className="mt-2 flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2.5 text-xs leading-relaxed text-(--el-warning-text)">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <b className="font-semibold">{t('aiPlan.offTitle')}</b> {t('aiPlan.offBody')}{' '}
            <Link
              href={AI_PLANNING_SETTINGS_HREF}
              className="font-semibold text-(--el-link) hover:underline"
            >
              {t('aiPlan.offLink')}
            </Link>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// Create-sprint — adds an empty PLANNED sprint via the shipped POST /api/sprints
// (4.1.3 `createSprint`), then refetches the sprint list. Unchanged from its
// Story-4.2 form beyond becoming the strip's flexible left half.
function CreateSprintButton({ onCreated }: { onCreated: () => Promise<void> }) {
  const t = useTranslations('backlog');
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sprints', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`create sprint ${res.status}`);
      await onCreated();
    } catch {
      toast({
        variant: 'error',
        title: t('createSprintErrorTitle'),
        description: t('createSprintErrorDescription'),
      });
    } finally {
      setBusy(false);
    }
  }, [onCreated, t, toast]);

  return (
    <button
      type="button"
      onClick={create}
      disabled={busy}
      data-testid="create-sprint"
      className="flex flex-1 items-center justify-center gap-2 px-(--spacing-control-x) py-3 text-sm font-medium text-(--el-text-secondary) hover:text-(--el-accent-on-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden />
      {busy ? t('creatingSprint') : t('createSprint')}
    </button>
  );
}
