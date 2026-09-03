import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import type { WorkItemPendingProposalDto } from '@/lib/dto/plans';

// The PENDING-PLAN indicator on the work-item detail page (bug MOTIR-4197),
// per design/work-items/pending-plan-indicator.mock.html + design-notes
// "The PENDING-PLAN indicator on the item page" (MOTIR-4256).
//
// WHAT IT SAYS: that one or more UNDECIDED plans — `planned` or `stale` — carry
// a `modify` / `remove` proposal naming THIS card, and where to read them. It
// POINTS; it never renders the proposed values. The peek and `/plans/<id>` are
// where a proposal is read, and a third surface rendering proposed values is
// the defect this card exists to remove (the reviewer's two tabs disagreeing),
// not the fix.
//
// SLOT: the first element of `<main>`, above Description — the slot
// `ArchivedBanner` holds, for the same reason: a whole-item state announcement
// belongs at the top of the page body. On an archived item carrying a `remove`
// proposal BOTH render, archived first (what this card IS, then what a plan
// proposes it BECOME). The page owns that ordering.
//
// TONE: the AI-proposal mold — `--el-tint-lavender` fill · `--el-border-soft`
// hairline · `Sparkles` in `--el-accent-on-surface` — over the archived
// notice's GEOMETRY (same `flex items-start gap-3 … px-3.5 py-3` frame, same
// `--radius-card`), so the two can stack without reading as two designs. The
// archived mold was rejected on the record: it says "a settled, factual state
// of this card", and a pending plan is an undecided proposal. Its glyph ink
// (`--el-text-muted`) measures 3.53:1 on lavender and is the one token NOT
// carried over. State is carried by text + glyph, never by hue alone; the
// `modify` / `remove` distinction is entirely lexical.
//
// TWO FACES. ONE plan: the op's own headline, the meta line, and a "Review plan"
// control on the right (the archived banner's action slot — a real link styled
// with the shipped secondary `buttonVariants`, the `/ready` precedent). SEVERAL
// plans: the headline becomes a count and the body a LIST — one row per plan,
// the plan's NAME as the link, its own op sentence beside it — and the control
// goes away, because one control cannot name three plans. That is what lets a
// card carry both ops across plans with no string that has to say "changes and
// also an archive".
//
// PRESENTATIONAL and pure: no router, no fetch, no state. The page decides
// whether to mount it (it reads nothing for an actor without `ai:view_plan`,
// and renders nothing — no reserved box — when there is no undecided
// proposal), so an empty `proposals` here renders null as a belt-and-braces.

export interface PendingPlanNoticeProps {
  /** The `PROD-N` key — the control's accessible name ("Review the plan that names {key}"). */
  identifier: string;
  /** One row per undecided plan naming this card, in plan-creation order. */
  proposals: readonly WorkItemPendingProposalDto[];
  /** Test hook — mirrors `ArchivedNotice`'s. */
  testId?: string;
}

const FRAME =
  'flex items-start gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-tint-lavender) px-3.5 py-3';

const ROW_LINK =
  'min-w-0 truncate font-sans text-[13px] font-medium text-(--el-text-strong) underline decoration-(--el-border-strong) underline-offset-2 hover:decoration-(--el-text-strong)';

export function PendingPlanNotice({
  identifier,
  proposals,
  testId = 'pending-plan-notice',
}: PendingPlanNoticeProps) {
  const t = useTranslations('issueViews');
  // `Plan.title` is nullable; the item page and the review surface say ONE
  // thing about an unnamed plan, so the shipped string is reused, not added.
  const tPlan = useTranslations('planReview');

  if (proposals.length === 0) return null;

  const planName = (title: string | null) => title?.trim() || tPlan('untitledPlan');

  if (proposals.length === 1) {
    const [only] = proposals as [WorkItemPendingProposalDto];
    return (
      <div role="status" data-testid={testId} className={FRAME}>
        <Sparkles
          className="mt-0.5 h-[18px] w-[18px] shrink-0 text-(--el-accent-on-surface)"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-sans text-sm font-semibold text-(--el-text-strong)">
            {only.op === 'remove' ? t('pendingPlanRemoveHeadline') : t('pendingPlanModifyHeadline')}
          </span>
          <span className="font-sans text-[13px] text-(--el-text-secondary)">
            {t('pendingPlanMeta')}
          </span>
        </div>
        <Link
          href={`/plans/${only.planId}`}
          className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} shrink-0`}
          aria-label={t('pendingPlanReviewAria', { key: identifier })}
        >
          <span>{t('pendingPlanReview')}</span>
          <span aria-hidden className="inline-flex">
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div role="status" data-testid={testId} className={FRAME}>
      <Sparkles
        className="mt-0.5 h-[18px] w-[18px] shrink-0 text-(--el-accent-on-surface)"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="font-sans text-sm font-semibold text-(--el-text-strong)">
          {t('pendingPlanCountHeadline', { count: proposals.length })}
        </span>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {proposals.map((proposal) => (
            <li key={proposal.planId} className="flex min-w-0 items-baseline gap-1.5">
              <Link href={`/plans/${proposal.planId}`} className={ROW_LINK}>
                {planName(proposal.planTitle)}
              </Link>
              <span className="shrink-0 font-sans text-[13px] text-(--el-text-secondary)">
                {proposal.op === 'remove' ? t('pendingPlanRowRemove') : t('pendingPlanRowModify')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
