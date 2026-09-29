'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Flag } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// NoActiveSprintState (Subtask 4.5.3) — the board area for a SCRUM board whose
// 4.5.2 projection returned `sprint: null` (the common pre-start / post-complete
// state). Per `design/boards/scrum.mock.html` panel 2: an `EmptyState` REPLACING
// the board (not an empty six-column board, and never the unscoped backlog
// masquerading as a sprint), with a **flag** icon — DISTINCT from the 3.2.6 "No
// issues yet" inbox empty-board state — and a CTA linking to the **Backlog**
// (Story 4.2) to plan/start a sprint. 4.5 does NOT start a sprint (that is 4.2 /
// 4.4); it only links there. Reuses the shipped `EmptyState` + `buttonVariants`
// (a `Link` styled as the primary button), so there is no hand-rolled surface.
export function NoActiveSprintState() {
  const backlogHref = useReaderRoutes().path('/backlog');
  const t = useTranslations('boards');
  return (
    <EmptyState
      icon={<Flag className="h-6 w-6" aria-hidden />}
      title={t('noActiveSprintTitle')}
      description={t('noActiveSprintDescription')}
      // A Visitor has no backlog to plan a sprint in (MOTIR-6888): no door.
      action={
        backlogHref === null ? undefined : (
          <Link href={backlogHref} className={buttonVariants({ variant: 'primary' })}>
            {t('noActiveSprintCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        )
      }
    />
  );
}
