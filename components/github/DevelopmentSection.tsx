import type { ComponentType, ReactNode } from 'react';
import {
  CircleCheck,
  CircleEllipsis,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill, type PillProps } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import type { QuickViewPullRequestDto } from '@/lib/dto/quickView';

// The work-item "Development" section (Story 7.10 · MOTIR-1579), per
// design/github Panels 3 + 4a: linked-PR rows — PR glyph + title +
// `owner/repo · #n` meta + a PR-state Pill + a CI-state Pill + an external
// link-out — or the EmptyState when the item has no linked PR. Purely
// presentational: the DTO arrives display-ready (title fallback, merged
// collapse, per-PR CI, URL all resolved server-side). Rendered read-only on
// the peek; MOTIR-1596 mounts the same section on the detail page and adds
// the explicit-link affordance (design Panel 5) beside it.
//
// Pill tones ride the SHIPPED axes only (the design's tone table — no new
// token / variant): Open → status="in-progress" (sky) · Merged →
// status="done" (mint) · Closed → severity="danger" (rose) · CI passing /
// failing / running → severity success / danger / warning. Each pill carries
// its leading glyph + label, so state never rides colour alone (AA), and the
// deliberate mint+mint of a merged+passing row stays distinguishable by
// glyph (the #108 two-green lesson).

type PillTone = Pick<PillProps, 'status' | 'severity'>;

const PR_STATE_META: Record<
  QuickViewPullRequestDto['state'],
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  open: { icon: GitPullRequestArrow, pill: { status: 'in-progress' } },
  merged: { icon: GitMerge, pill: { status: 'done' } },
  closed: { icon: GitPullRequestClosed, pill: { severity: 'danger' } },
};

const CI_STATE_META: Record<
  NonNullable<QuickViewPullRequestDto['ci']>,
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  passing: { icon: CircleCheck, pill: { severity: 'success' } },
  failing: { icon: CircleX, pill: { severity: 'danger' } },
  running: { icon: CircleEllipsis, pill: { severity: 'warning' } },
};

function PullRequestRow({ pr }: { pr: QuickViewPullRequestDto }) {
  const t = useTranslations('github');
  const state = PR_STATE_META[pr.state];
  const ci = pr.ci ? CI_STATE_META[pr.ci] : null;
  const StateGlyph = state.icon;
  const PrPillGlyph = state.icon;
  return (
    <li className="mt-2 flex items-center gap-2.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface) px-(--spacing-control-x) py-(--spacing-control-y)">
      <StateGlyph className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        <div className="truncate font-sans text-[13.5px] font-medium text-(--el-text)">
          {pr.title}
        </div>
        <div className="truncate font-sans text-xs text-(--el-text-identifier)">
          {pr.repo} · #{pr.number}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <Pill {...state.pill}>
          <PrPillGlyph className="h-3 w-3" aria-hidden />
          {t(`development.prState.${pr.state}`)}
        </Pill>
        {ci ? (
          <Pill {...ci.pill}>
            <ci.icon className="h-3 w-3" aria-hidden />
            {t(`development.ciState.${pr.ci!}`)}
          </Pill>
        ) : null}
      </span>
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 rounded-(--radius-control) p-1 text-(--el-icon-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        <span className="sr-only">{t('development.openOnGithub')}</span>
      </a>
    </li>
  );
}

export function DevelopmentSection({
  pullRequests,
  itemIdentifier,
  className,
}: {
  pullRequests: QuickViewPullRequestDto[];
  /** The item's `MOTIR-<n>` key — the empty-state / caption copy names it. */
  itemIdentifier: string;
  className?: string;
}) {
  const t = useTranslations('github');
  const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  return (
    <section className={className} data-testid="development-section">
      <SectionLabel label={t('development.title')} />
      {pullRequests.length === 0 ? (
        <EmptyState
          className="mt-2"
          icon={<GitPullRequestArrow className="h-12 w-12" aria-hidden />}
          title={t('development.emptyTitle')}
          description={t.rich('development.emptyDescription', { key: itemIdentifier, mono })}
        />
      ) : (
        <>
          <ul className="list-none">
            {pullRequests.map((pr) => (
              <PullRequestRow key={`${pr.repo}#${pr.number}`} pr={pr} />
            ))}
          </ul>
          <p className="mt-3 font-sans text-xs text-(--el-text-muted)">
            {t.rich('development.autoLinkCaption', { key: itemIdentifier, mono })}
          </p>
        </>
      )}
    </section>
  );
}
