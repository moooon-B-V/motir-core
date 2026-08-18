import { CircleCheck, CircleDashed, CircleQuestionMark } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ComponentType } from 'react';
import { Pill } from '@/components/ui/Pill';
import type { RepoDelivery, RepoDeliveryState } from '@/lib/workItems/repoDelivery';

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
};

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
  /** The peek's compression (MOTIR-2414). Read-mode only. */
  compact?: boolean;
}

export function RepositorySetField({ delivery, compact = false }: RepositorySetFieldProps) {
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
        <span className="text-(--el-text-muted)">{t('none')}</span>
        {compact ? null : (
          <p className="mt-2 font-sans text-xs text-(--el-text-muted)">
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
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">
                {d.repo}
              </span>
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
          <li className="py-1 font-sans text-xs text-(--el-text-muted)">
            {t('repositoriesMore', { count: overflow })}
          </li>
        ) : null}
      </ul>
      <RepositoryCountCaption delivery={delivery} compact={compact} />
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
  compact,
}: {
  delivery: RepoDelivery[];
  compact: boolean;
}) {
  const t = useTranslations('issueViews');
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
  return <p className="mt-2 font-sans text-xs text-(--el-text-muted)">{text}</p>;
}
