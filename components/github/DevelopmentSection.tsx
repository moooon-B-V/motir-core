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
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// The work-item "Development" section (Story 7.10 · MOTIR-1579), per
// design/github Panels 3 + 4a: linked-PR rows — PR glyph + title +
// `owner/repo · #n` meta + a PR-state Pill + a CI-state Pill + an external
// link-out — or the EmptyState when the item has no linked PR. Purely
// presentational: the DTO arrives display-ready (title fallback, merged
// collapse, per-PR CI, URL all resolved server-side). Two hosts, one body
// (`DevelopmentSectionBody`): the quick-view peek (SectionLabel header, this
// file's `DevelopmentSection`) and the detail page's ContentSectionCard
// (design Panel 5a — mounted in `app/(authed)/items/[key]/page.tsx`).
// Read-only on both; MOTIR-1596 adds the explicit-link affordance (design
// Panel 5) into the detail card's header.
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
  LinkedPullRequestDto['state'],
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  open: { icon: GitPullRequestArrow, pill: { status: 'in-progress' } },
  merged: { icon: GitMerge, pill: { status: 'done' } },
  closed: { icon: GitPullRequestClosed, pill: { severity: 'danger' } },
};

const CI_STATE_META: Record<
  NonNullable<LinkedPullRequestDto['ci']>,
  { icon: ComponentType<{ className?: string }>; pill: PillTone }
> = {
  passing: { icon: CircleCheck, pill: { severity: 'success' } },
  failing: { icon: CircleX, pill: { severity: 'danger' } },
  running: { icon: CircleEllipsis, pill: { severity: 'warning' } },
};

function PullRequestRow({ pr }: { pr: LinkedPullRequestDto }) {
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
      {/* aria-label, NOT an sr-only span (the shipped icon-only convention —
          RemoveLinkButton / QuickViewCloseButton): an sr-only span is
          position:absolute, and with no positioned ancestor it escapes the
          shell's overflow container and stretches the ROOT scroller — the
          "empty space past the bottom of the page" bug. */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('development.openOnGithub')}
        className="shrink-0 rounded-(--radius-control) p-1 text-(--el-icon-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
      </a>
    </li>
  );
}

/** The section's BODY — rows or EmptyState + the auto-link caption. Shared by
 *  both hosts; the host supplies its own header (SectionLabel on the peek, the
 *  ContentSectionCard title on the detail page). */
export function DevelopmentSectionBody({
  pullRequests,
  itemIdentifier,
}: {
  pullRequests: LinkedPullRequestDto[];
  /** The item's `MOTIR-<n>` key — the empty-state / caption copy names it. */
  itemIdentifier: string;
}) {
  const t = useTranslations('github');
  const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  if (pullRequests.length === 0) {
    return (
      <EmptyState
        className="mt-2"
        icon={<GitPullRequestArrow className="h-12 w-12" aria-hidden />}
        title={t('development.emptyTitle')}
        description={t.rich('development.emptyDescription', { key: itemIdentifier, mono })}
      />
    );
  }
  return (
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
  );
}

/** The PEEK host — SectionLabel header over the shared body (design Panel 3). */
export function DevelopmentSection({
  pullRequests,
  itemIdentifier,
  className,
}: {
  pullRequests: LinkedPullRequestDto[];
  itemIdentifier: string;
  className?: string;
}) {
  const t = useTranslations('github');
  return (
    <section className={className} data-testid="development-section">
      <SectionLabel label={t('development.title')} />
      <DevelopmentSectionBody pullRequests={pullRequests} itemIdentifier={itemIdentifier} />
    </section>
  );
}
