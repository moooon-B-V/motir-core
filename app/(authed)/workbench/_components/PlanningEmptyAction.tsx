'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/Button';
import { useProjectAccess } from '@/app/(authed)/_components/ProjectAccessProvider';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';

// THE PLANNING EMPTY STATE'S ACTION (Story MOTIR-7820 · Subtask MOTIR-7831; design
// `design/workbench/design-notes.md` § 36.9, mock Panel 8) — *Plan with AI*, which
// opens the planning surface on the active project OVER this tab.
//
// ⚠️ IT DRAWS NOTHING FOR A READER WHO CANNOT START A PLAN HERE (Panel 8, right).
// The gate is the shell's own *Plan with AI* gate, in its two halves: the BUILD
// (is a planner wired at all) is resolved by the server and handed down, and the
// ACTOR (`ai:plan` — the key every planning write asserts) is read from the shell's
// project-access context, the same way the ⌘K twin reads it. A button that is
// refused on press is worse than none, which is why the empty state loses it
// rather than disabling it: there is nothing to teach on a tab that is empty.
//
// ⚠️ IT IS A REAL LINK, not a button that calls a router. The address is the
// overlay's own (`withPlanningOverlay` through `useOpenPlanningWorkspace`), so a
// modified click opens this tab with the workspace over it — the cold deep link —
// and a plain click `shallowPush`es it, leaving this page mounted underneath.

export function PlanningEmptyAction({ aiConfigured }: { aiConfigured: boolean }) {
  const t = useTranslations('workbench');
  const { can } = useProjectAccess();
  const { href, open } = useOpenPlanningWorkspace({ kind: 'project' });

  // `ai:plan` is `AI_PLANNING_REQUIREMENT` (`lib/settings/projectNavAccess.ts`),
  // named as the key itself because `can` takes a permission and that constant is
  // the wider `NavRequirement` the nav registry needs.
  if (!aiConfigured || !can('ai:plan')) return null;

  return (
    <Link
      href={href}
      onClick={open}
      data-testid="planning-empty-action"
      className={buttonVariants({ variant: 'secondary' })}
    >
      <Sparkles className="h-4 w-4" aria-hidden />
      {t('empty.planning.action')}
    </Link>
  );
}
