import { CircleCheck, CircleDashed, CircleQuestionMark, FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import { Pill } from '@/components/ui/Pill';
import type { RepoDelivery, RepoDeliveryState } from '@/lib/workItems/repoDelivery';
import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import { deliverySetShortfall } from '@/lib/workItems/deliverySet';

// EVERY repository a work item ships in, with each one's DELIVERY state (Story
// MOTIR-2725 · MOTIR-2415), per design/work-items/repository-set.mock.html and
// its quick-view compression, repository-set-quick-view.mock.html.
//
// ONE component, TWO surfaces. The detail rail and the peek rail show the same
// field with the same words, and the story exists because a ledger that says
// different things in different places is a ledger nobody can correct — so the
// compression is a PROP (`compact`), never a second component. What `compact`
// changes is the READ only: a row cap, a shorter caption, and no explanatory
// line. It never changes a word.
//
// The host supplies its own chrome — the detail page's `FieldCard`, the peek's
// `RailField` — exactly as `DevelopmentSectionBody` is shared under two headers.
//
// ⚠️ AND BECAUSE THE HOST SUPPLIES THE CHROME, THIS COMPONENT CANNOT KNOW WHICH
// SURFACE IT LANDS ON — so every ink here is one that is legal on ALL of them
// (MOTIR-4196). `--el-text-muted` is 4.54:1 on the white page/card and
// 4.12–4.34:1 on `--el-surface` / `--el-surface-soft` / `--el-muted`; the peek's
// `QuickViewRail` paints `--el-surface-soft`, so every caption and empty value
// below shipped at 4.34:1, under AA. `--el-text-secondary` is 6.18–6.80:1 on all
// four in both themes, which is why the fix does not need to know the host.
// `tests/theme/inkContrastLint.test.ts`'s muted arm cannot rule on this by
// construction — the tint is painted in another module and it ABSTAINS — so the
// binding guard is `tests/components/quick-view-rail-ink.test.tsx`, which
// resolves each site's real surface from the rendered DOM.

/** State → glyph. The three states carry their own SHAPE as well as their own
 *  hue, so the field never rides colour alone (the AA rule), and each row's
 *  `title` names its state for a pointer user. */
const DELIVERY_META: Record<
  RepoDeliveryState,
  { icon: ComponentType<{ className?: string }>; className: string }
> = {
  delivered: { icon: CircleCheck, className: 'text-(--el-success)' },
  awaiting: { icon: CircleDashed, className: 'text-(--el-icon-muted)' },
  unknown: { icon: CircleQuestionMark, className: 'text-(--el-warning)' },
  // The repository does not EXIST yet — a different glyph, not a different shade
  // of the awaiting one, because the reader's next action is somewhere else
  // entirely (design MOTIR-3038 panel 2c).
  unestablished: { icon: FolderGit2, className: 'text-(--el-icon-muted)' },
  // Declined. Drawn QUIET on purpose: it is the one state that does not hold the
  // card, so it must not read as something outstanding.
  excluded: { icon: CircleDashed, className: 'text-(--el-icon-muted)' },
};

/** Where following a repository GOES (design MOTIR-3038 panel 2d) — the row on
 *  the project's own settings page, anchored, NOT the host. The card points at a
 *  ROW, and a `proposed` row has no host repository at all, so a link out to
 *  GitHub would be dead for exactly the state this redraw exists to express. */
function repositoryHref(name: string): string {
  return `/settings/project/repositories#${encodeURIComponent(name)}`;
}

/** The quick view's row cap (design MOTIR-2414): three rows, then `+N more`.
 *  A BOUND, not a space saving — at three rows the field still clears the peek's
 *  fold with room to spare; the cap stops a nine-repository card from pushing
 *  Type, Priority and Assignee off the visible rail. */
const COMPACT_ROW_CAP = 3;

export interface RepositorySetFieldProps {
  /** The item's repositories, in order, each with its delivery state — resolved
   *  SERVER-side by `workItemsService.listRepoDelivery`, which calls the same
   *  classifier the completion gate calls. */
  delivery: RepoDelivery[];
  /**
   * The card's DELIVERY SET (Story MOTIR-3655 · MOTIR-3660) — every pull request
   * that delivers it, which the caption's SUBJECT is drawn from when what is
   * outstanding is a pull request rather than a repository.
   *
   * The GLYPH's amended predicate is applied by `amendRepoDeliveryWithSet` before
   * `delivery` ever reaches this component, server-side, so the peek and the
   * detail page cannot arrive at different glyphs for one card. Only the caption
   * needs the set itself, because only the caption NAMES the member.
   *
   * Defaulted to `[]`, which is the state of nearly every card: with no
   * deliveries the field renders exactly what it shipped.
   */
  deliveries?: WorkItemDeliveryDto[];
  /** The peek's compression (MOTIR-2414). Read-mode only. */
  compact?: boolean;
}

export function RepositorySetField({
  delivery,
  deliveries = [],
  compact = false,
}: RepositorySetFieldProps) {
  const t = useTranslations('issueViews');

  // The EMPTY set — a deliberate state, not a hole. The value is the shipped
  // word every unset rail field uses, so the product never learns a second word
  // for nothing; the detail page adds one muted line saying the absence was
  // ALLOWED. That line is dropped in the peek on purpose (design MOTIR-2414):
  // Due date, Labels, Components and Sprint all already read "None" there with
  // no explanation, so a caption under this one field would make it look MORE
  // required than its neighbours, which is the opposite of its job.
  if (delivery.length === 0) {
    return (
      <div>
        <span className="text-(--el-text-secondary)">{t('none')}</span>
        {compact ? null : (
          <p className="mt-2 font-sans text-xs text-(--el-text-secondary)">
            {t('repositoriesOptional')}
          </p>
        )}
      </div>
    );
  }

  const shown = compact ? delivery.slice(0, COMPACT_ROW_CAP) : delivery;
  const overflow = delivery.length - shown.length;
  // The `primary` chip is drawn ONLY above one repository: with nothing to
  // distinguish it from, it is noise (design MOTIR-2413 Q1).
  const showPrimary = delivery.length > 1;

  return (
    <div className="min-w-0">
      <ul className="list-none">
        {shown.map((d) => {
          const meta = DELIVERY_META[d.state];
          const Glyph = meta.icon;
          return (
            <li key={d.repo} className="flex items-center gap-2 py-1">
              <span
                title={t(`repositoryDelivery.${d.state}`)}
                className={`${meta.className} shrink-0`}
              >
                <Glyph className="h-[15px] w-[15px]" aria-hidden />
              </span>
              {/* The repository as a LINK (design MOTIR-3038). The name is what
                  the reference RESOLVES to, which is why a rename changes what
                  this shows and nothing about what the card points at. */}
              <Link
                href={repositoryHref(d.repo)}
                className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-link) underline underline-offset-2"
              >
                {d.repo}
              </Link>
              {/* The ROLE — a category, not an identity, so it wears the neutral
                  chip. DETAIL ONLY: the design drops it from the compact row
                  because the peek's rail is measured, and the role is the one
                  thing there that the reader can get by following the link. */}
              {!compact && d.role ? (
                <Pill tone="neutral" className="shrink-0">
                  {d.role}
                </Pill>
              ) : null}
              {/* The establish STATE, shown only when the row is not established
                  — an ordinary repository needs no chip saying it exists. The
                  two do not share a severity: `unestablished` HOLDS the card and
                  is drawn as a warning; `excluded` is a settled decision that
                  holds nothing, and is drawn quiet. */}
              {d.state === 'unestablished' ? (
                <Pill severity="warning" className="shrink-0">
                  {t(`repositoryDelivery.${d.state}`)}
                </Pill>
              ) : d.state === 'excluded' ? (
                <Pill tone="neutral" className="shrink-0">
                  {t(`repositoryDelivery.${d.state}`)}
                </Pill>
              ) : null}
              {/* The state word rides the row for a screen reader, so the list
                  reads "motir-core, delivered, primary" rather than a bare name
                  beside a coloured dot. */}
              <span className="sr-only">{t(`repositoryDelivery.${d.state}`)}</span>
              {showPrimary && d.primary ? (
                <Pill tone="neutral" className="shrink-0">
                  {t('repositoryPrimary')}
                </Pill>
              ) : null}
            </li>
          );
        })}
        {overflow > 0 ? (
          <li className="py-1 font-sans text-xs text-(--el-text-secondary)">
            {t('repositoriesMore', { count: overflow })}
          </li>
        ) : null}
      </ul>
      <RepositoryCountCaption delivery={delivery} deliveries={deliveries} compact={compact} />
    </div>
  );
}

/**
 * The count line under the rows — and the reason a truncated set can never read
 * as a smaller one: it names the TOTAL, whatever the row cap showed.
 *
 * The peek drops the outstanding repository's NAME (it is on a row two lines
 * above, beside its own glyph) and keeps the count.
 */
function RepositoryCountCaption({
  delivery,
  deliveries,
  compact,
}: {
  delivery: RepoDelivery[];
  deliveries: WorkItemDeliveryDto[];
  compact: boolean;
}) {
  const t = useTranslations('issueViews');

  // ── The caption's SUBJECT is whatever is OUTSTANDING (MOTIR-3660) ────────
  // ONE line, never two: two counts answering different questions on one
  // surface is what a reader misreads. So a delivery-level shortfall is
  // answered FIRST and returns, because it is the more specific fact — the
  // repository count says `1 of 1 delivered` about the very card the gate is
  // holding, while the delivery line names the pull request that is holding it.
  //
  // ⚠️ This runs BEFORE the `< 2` guard below, and that ordering IS the fix.
  // The repository caption disappears on a one-element set — correctly, since
  // one row says everything a count could — but a card with TWO pull requests in
  // ONE repository has a one-element repository set and something outstanding,
  // and under the old ordering it rendered no caption at all while
  // `deferred_incomplete_delivery_set` held it.
  const members = deliveries.map((d) => ({
    repoLabel: d.pullRequest.repo,
    number: d.pullRequest.number,
    merged: d.pullRequest.state === 'merged',
    baseRef: d.baseRef,
    defaultBranch: d.defaultBranch,
  }));
  // The SAME function the gate derives its hold and its comment from, so the
  // words on the rail and the words in the comment cannot describe different
  // sets.
  const shortfall = deliverySetShortfall(members);
  const mergedCount = members.filter(
    (m) => m.merged && m.baseRef !== null && m.baseRef === m.defaultBranch,
  ).length;
  if (shortfall.outstanding.length > 0) {
    return (
      <CaptionLine
        text={t('deliveriesMergedOpen', {
          merged: mergedCount,
          total: members.length,
          pr: shortfall.outstanding.join(', '),
        })}
      />
    );
  }
  if (shortfall.strandedBase.length > 0) {
    const stranded = deliveries.find(
      (d) => `${d.pullRequest.repo}#${d.pullRequest.number}` === shortfall.strandedBase[0],
    );
    return (
      <CaptionLine
        text={t('deliveriesMergedStranded', {
          merged: mergedCount,
          total: members.length,
          pr: shortfall.strandedBase.join(', '),
          base: stranded?.baseRef ?? '',
        })}
      />
    );
  }

  // One repository has nothing to count — the row already says everything.
  if (delivery.length < 2) return null;

  const delivered = delivery.filter((d) => d.state === 'delivered');
  const unknown = delivery.filter((d) => d.state === 'unknown');
  const outstanding = delivery.filter((d) => d.state === 'awaiting');

  let text: string;
  if (unknown.length > 0 && !compact) {
    text = t('repositoriesUnknownBranch', { repo: unknown.map((d) => d.repo).join(', ') });
  } else if (outstanding.length === 0 && unknown.length === 0) {
    text = t('repositoriesAllDelivered');
  } else if (!compact && outstanding.length > 0) {
    text = t('repositoriesOutstanding', {
      delivered: delivered.length,
      total: delivery.length,
      repo: outstanding.map((d) => d.repo).join(', '),
    });
  } else {
    text = t('repositoriesDeliveredCount', {
      delivered: delivered.length,
      total: delivery.length,
    });
  }
  return <CaptionLine text={text} />;
}

/** The caption's one line, so every branch above renders the same element rather
 *  than four copies of one className that can drift apart. */
function CaptionLine({ text }: { text: string }) {
  return <p className="mt-2 font-sans text-xs text-(--el-text-secondary)">{text}</p>;
}
