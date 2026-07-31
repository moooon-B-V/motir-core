import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowRight, KeyRound } from 'lucide-react';
import { Card } from '@/components/ui/Card';

// DOOR 2 into the team code-access room (Story MOTIR-1775 · MOTIR-1945, design
// §15.3) — at the foot of the shipped Access & members pane, because the two
// panes answer the same question one level apart: who is ON this project, and
// who of them can reach its code.
//
// ⚠️ IT CARRIES THE COUNT, not just a label — and that is the whole point. The
// failure this Story exists to fix was INVISIBLE: five of six people could not
// clone their own project's code and nothing anywhere said so. A door labelled
// only "Code access" would reproduce exactly that; the number is what makes the
// gap legible from the surface people already visit.
//
// Server-rendered, which is also its page-state answer (design §15.13): an invite
// made in the OTHER room cannot reach across routes, and does not need to — this
// count re-reads on the next navigation.

export async function CodeAccessDoorCard({
  granted,
  eligible,
  hasCode,
}: {
  granted: number;
  eligible: number;
  /** Whether Motir has made this project any repository at all. With none, a
   *  "0 of 5 can clone" would report a gap that does not exist yet. */
  hasCode: boolean;
}) {
  const t = await getTranslations('settings.codeAccess');

  return (
    <Card>
      <Link
        href="/settings/project/code-access"
        className="flex flex-wrap items-center gap-3 focus-visible:outline-none"
      >
        <span
          aria-hidden
          className="bg-(--el-tint-lavender) inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-strong)"
        >
          <KeyRound className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-sans text-sm font-semibold text-(--el-text)">
            {t('doorCard.title')}
          </span>
          <span className="text-(--el-text-muted) font-sans text-xs">
            {hasCode ? t('doorCard.summary', { granted, eligible }) : t('doorCard.noCode')}
          </span>
        </span>
        <span className="text-(--el-link) inline-flex shrink-0 items-center gap-1 font-sans text-sm font-medium">
          {t('doorCard.action')}
          <ArrowRight className="size-4" aria-hidden />
        </span>
      </Link>
    </Card>
  );
}
