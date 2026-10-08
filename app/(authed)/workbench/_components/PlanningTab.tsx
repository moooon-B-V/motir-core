import { getTranslations } from 'next-intl/server';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { PenLine } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { HomeActorContext } from '@/lib/services/homeService';
import {
  PLANNING_TAB_CEILING,
  workbenchPlanningService,
} from '@/lib/services/workbenchPlanningService';
import { PlanningList } from './PlanningList';
import { PlanningEmptyAction } from './PlanningEmptyAction';

// THE PLANNING TAB'S CONTENT (Story MOTIR-7820 · Subtask MOTIR-7831; design
// `design/workbench/design-notes.md` § 36, mock `workbench--planning.mock.html`).
//
// ⚠️ IT DOES ITS OWN READ, which is what puts a boundary around it — the same
// shape as `<ApprovalsTab>`: the page's four work tabs are read in its own
// `Promise.all`, so nothing can suspend around them; this one awaits HERE, so the
// page can mount a `<Suspense>` between its GATE and this content (window 2 of
// `design/shell/design-notes.md`'s navigation-pending grammar). A `loading.tsx` is
// the WRONG instrument and not merely a different one: a route boundary can flush
// the response head before the page's gate has run, which is why this repo has none.
//
// ⚠️ PAGE 1 ONLY, AT THE CEILING (§ 36.10). The tab has no pager, so there is no
// `page` to honour: it reads the newest {@link PLANNING_TAB_CEILING} rows and lets
// `total` say when the set is larger. The read stays offset-paged underneath, so
// nothing about the service is special-cased for this surface.

export async function PlanningTab({
  ctx,
  projectName,
}: {
  ctx: HomeActorContext;
  /** The active project's NAME, for the scope line — the page already has it, and
   *  `HomeActorContext` carries only its id. */
  projectName: string;
}) {
  const t = await getTranslations('workbench');
  const page = await workbenchPlanningService.listMyPlansBeingWritten(ctx, {
    page: 1,
    limit: PLANNING_TAB_CEILING,
  });

  return (
    <PlanningList
      seed={page}
      projectName={projectName}
      label={t('tabs.planning')}
      empty={<NoPlansBeingWritten />}
    />
  );
}

/**
 * THE EMPTY STATE (§ 36.9) — drawn ALONE: no list box, no scope line, no pager.
 *
 * ⚠️ IT CARRIES AN ACTION, against § *Empty states*' default, and for that rule's
 * own reason. The rule is that only a tab whose emptiness the reader can DO
 * something about offers a button — nothing a reader presses conjures an approval
 * or makes somebody watch an item. Here something does: starting a plan is exactly
 * what puts a row on this tab, and it is the reader's own act. So this is the To do
 * case, not the Watching case.
 *
 * The action renders only for a reader who can actually start a plan in the active
 * project — the shell's own *Plan with AI* gate — because a button that is refused
 * on press is worse than none.
 */
async function NoPlansBeingWritten() {
  const t = await getTranslations('workbench');
  return (
    <EmptyState
      icon={<PenLine className="h-12 w-12" aria-hidden />}
      title={t('empty.planning.title')}
      description={t('empty.planning.body')}
      // The BUILD half of the shell's *Plan with AI* gate — a server probe, so it
      // is resolved here and handed to the client half, which reads `ai:plan`.
      action={<PlanningEmptyAction aiConfigured={isMotirAiConfigured()} />}
      data-testid="planning-empty"
    />
  );
}
