import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import type { WorkItemPendingProposalDto } from '@/lib/dto/plans';

// The PENDING-PLAN indicator on the work-item detail page (bug MOTIR-4197),
// per design/work-items/pending-plan-indicator.mock.html + design-notes
// "The PENDING-PLAN indicator on the item page" (MOTIR-4256).
//
// WHAT IT SAYS: that one or more UNDECIDED plans — `planned` or `stale` — name
// THIS card, and where to read them. It POINTS; it never renders the proposed
// values. The peek and `/plans/<id>` are where a proposal is read, and a third
// surface rendering proposed values is the defect this card exists to remove
// (the reviewer's two tabs disagreeing), not the fix.
//
// ⚠️ A PLAN NAMES A CARD IN THREE WAYS, AND THE THIRD ARRIVED LAST (bug
// MOTIR-4365 · design MOTIR-4364 AMENDMENT A). A `modify` proposes CHANGES to
// it, a `remove` proposes to ARCHIVE it — and an `add` proposes a CHILD under
// it, which the reverse lookup could not return when this element shipped
// because an `add` has no `workItemId` at all. Expanding a story into subtasks
// is the commonest plan in this product, so the element was silent in the
// situation it is most useful in.
//
// FIVE CLAIMS, AND THE FORM IS TOTAL OVER THEM. `@@unique([planId, workItemId])`
// allows one `modify` OR one `remove` per plan per card, and Postgres treats
// NULLs as distinct, so N `add` rows coexist with it: `modify` · `remove` ·
// `add` · `modify`+`add` · `remove`+`add`. A sixth (`modify`+`remove`) is
// excluded by the constraint rather than by choice. The `remove`+`add` sentence
// is expressible and incoherent — a plan archiving a card while hanging work
// beneath it — and it is drawn anyway, because that is exactly the plan somebody
// should look at, and suppressing the clause to tidy the sentence hides the tell.
//
// THE COUNT IS IN THE SENTENCE for `add` and NOT for `modify`, and the asymmetry
// is earned: a `modify`'s magnitude is unknowable from the row (`patch` is a
// sparse blob, and one field and nine read identically), while an `add` count IS
// its magnitude — the whole difference between a tweak and a story about to gain
// a subtree. `pendingPlanCountHeadline` is UNCHANGED and still counts PLANS; what
// changed is that the array it counts is folded to one row per plan by
// `plansService.listPendingProposalsForWorkItem`, so it goes back to meaning what
// the string says.
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
// `modify` / `remove` / `add` distinction is entirely lexical. AMENDMENT A §A2
// re-opened that question for the children case and KEPT the answer, rejecting a
// `--el-tint-sky` "structural" mold on the record: it would make hue carry
// meaning for the first time on this element, on the axis a reader is least able
// to name, and it would break panel 9's stack.
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
  /** One row per undecided plan naming this card, in plan-creation order —
   *  ONE PER PLAN, folded by the service (§A3), never one per proposal. */
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

  // The FIVE reachable claims, as ONE total form per face. A `switch` on `op`
  // with the children clause inside each arm, rather than a lookup keyed on a
  // composed string: a sixth `PlanItemOp` then turns the `never` below red
  // instead of falling through to a wrong sentence. `childCount` is the ICU
  // `count` wherever a clause names it, so `# work item` / `# work items` is the
  // catalogue's decision and not a branch here (`zh` has one plural arm).
  const headline = (p: WorkItemPendingProposalDto): string => {
    const count = { count: p.childCount };
    switch (p.op) {
      case 'modify':
        return p.childCount > 0
          ? t('pendingPlanModifyAddHeadline', count)
          : t('pendingPlanModifyHeadline');
      case 'remove':
        return p.childCount > 0
          ? t('pendingPlanRemoveAddHeadline', count)
          : t('pendingPlanRemoveHeadline');
      // `op: null` is the CHILDREN-ONLY claim. The DTO's invariant is
      // `op !== null || childCount > 0` — a row claiming nothing is not a row —
      // so this arm always has a count to render.
      case null:
        return t('pendingPlanAddHeadline', count);
      default: {
        const unreachable: never = p.op;
        return unreachable;
      }
    }
  };

  const rowClaim = (p: WorkItemPendingProposalDto): string => {
    const count = { count: p.childCount };
    switch (p.op) {
      case 'modify':
        return p.childCount > 0 ? t('pendingPlanRowModifyAdd', count) : t('pendingPlanRowModify');
      case 'remove':
        return p.childCount > 0 ? t('pendingPlanRowRemoveAdd', count) : t('pendingPlanRowRemove');
      case null:
        return t('pendingPlanRowAdd', count);
      default: {
        const unreachable: never = p.op;
        return unreachable;
      }
    }
  };

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
            {headline(only)}
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
                {rowClaim(proposal)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
