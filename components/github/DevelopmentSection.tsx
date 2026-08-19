import type { ComponentType, ReactNode } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleEllipsis,
  CircleQuestionMark,
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
import { awaitingRepoRows, type RepoDelivery } from '@/lib/workItems/repoDelivery';

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

/** State → glyph + Pill tone (the design's tone table), shared by the linked-PR
 *  rows here AND the explicit-link picker's option pills (MOTIR-1596) so both
 *  read from ONE mapping — no new token/variant. */
export const PR_STATE_META: Record<
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
          {pr.linkedManually ? (
            // Provenance at a glance (design Panel 5a) — a manual link (set by
            // the explicit affordance, not the auto-resolver) carries the quiet
            // "linked manually" suffix.
            <>
              {' · '}
              <span className="font-mono">{t('development.linkedManually')}</span>
            </>
          ) : null}
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

/**
 * A repository the item CARRIES that has no pull request to show (Story
 * MOTIR-2725 · MOTIR-2415, design `repository-set.mock.html` panel 1) — the ONE
 * element that design adds, and the state the completion gate holds an item for.
 *
 * The shipped section has nothing to render for it today: it lists the pull
 * requests that exist, and the whole point of the repository SET is that a
 * repository whose PR was never opened is invisible to anything that counts
 * rows. So the row is drawn from the EXPECTED side instead.
 *
 * Deliberately the same row grammar as a real pull request — same height, same
 * columns, same pill slot — with a DASHED border and a soft fill, so it reads as
 * a placeholder in the list rather than as a different kind of thing. It carries
 * no link-out, because there is nothing to link to; the spacer keeps the pill
 * column aligned with the rows above it.
 */
function AwaitingRepoRow({ delivery }: { delivery: RepoDelivery }) {
  const t = useTranslations('github');
  const unknown = delivery.state === 'unknown';
  const Glyph = unknown ? CircleQuestionMark : CircleDashed;
  return (
    <li className="mt-2 flex items-center gap-2.5 rounded-(--radius-control) border border-dashed border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      <Glyph className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />
      <div className="min-w-0 flex-1 py-1">
        {/* `--el-text-secondary`, NOT `--el-text-muted`: this row's fill is
            `--el-surface-soft`, where muted measures 4.34:1 and fails AA — it
            clears only on the white page/card, by 0.04 (`CLAUDE.md`'s contrast
            table; `tests/theme/inkContrastLint.test.ts` enforces the pair).
            Secondary is 6.51:1 on the same fill and still reads as quieter than
            a real pull-request title beside it. */}
        <div className="truncate font-sans text-[13.5px] font-medium text-(--el-text-secondary)">
          {t(unknown ? 'development.mergedBranchUnknown' : 'development.noPullRequestYet')}
        </div>
        <div className="truncate font-sans text-xs text-(--el-text-identifier)">
          {delivery.repo}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <Pill {...(unknown ? { severity: 'warning' as const } : { tone: 'neutral' as const })}>
          <Glyph className="h-3 w-3" aria-hidden />
          {t(unknown ? 'development.repoState.unknown' : 'development.repoState.awaiting')}
        </Pill>
      </span>
      {/* Keeps the pill column aligned with the linked rows, which end in a
          link-out button. An awaiting repository has nothing to link to. */}
      <span className="w-6 shrink-0" aria-hidden />
    </li>
  );
}

/** The section's BODY — rows or EmptyState + the auto-link caption. Shared by
 *  both hosts; the host supplies its own header (SectionLabel on the peek, the
 *  ContentSectionCard title on the detail page). */
export function DevelopmentSectionBody({
  pullRequests,
  itemIdentifier,
  manualLinkable = false,
  repoDelivery = [],
}: {
  pullRequests: LinkedPullRequestDto[];
  /** The item's `MOTIR-<n>` key — the empty-state / caption copy names it. */
  itemIdentifier: string;
  /** True on the detail-page host, where the "+ Link pull request" affordance
   *  lives — the caption then adds "— or linked by hand from here" (design Panel
   *  5a). The read-only peek leaves it false (its caption names only auto-link). */
  manualLinkable?: boolean;
  /**
   * EVERY repository the item carries, with its delivery state (Story MOTIR-2725
   * · MOTIR-2415) — the item's own set, passed VERBATIM. The rows that get drawn
   * for it are derived here, by `awaitingRepoRows`.
   *
   * ⚠️ The host does NOT pre-filter this (MOTIR-3036). Both hosts used to hand
   * over `delivery.filter((d) => d.state !== 'delivered')`, and two copies of one
   * editorial decision is how the detail page and the quick view came to disagree
   * — and how they both came to say "No pull request yet" about a repository
   * whose pull request was on the row above. A host that supplies the set and
   * decides nothing cannot drift from the other host.
   *
   * Still defaulted to `[]`, which is the state most cards are in: an item that
   * carries no repositories renders exactly the shipped section.
   */
  repoDelivery?: RepoDelivery[];
}) {
  const t = useTranslations('github');
  const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
  // The repositories still owed a row of their own — never the raw set (see the
  // prop's note). Derived BEFORE the empty-state gate, because the gate asks
  // whether there is anything to draw, and the raw set can be non-empty while
  // every one of its repositories already has a pull-request row.
  const awaiting = awaitingRepoRows(repoDelivery, pullRequests);
  // The big EmptyState is for an item with NOTHING to show. An item that carries
  // repositories always has rows — the awaiting ones — so it never lands here.
  if (pullRequests.length === 0 && awaiting.length === 0) {
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
        {/* After the real rows: a placeholder per repository still owed one.
            Ordered by the item's own repository order, so the list reads in the
            same sequence the rail does. */}
        {awaiting.map((d) => (
          <AwaitingRepoRow key={d.repo} delivery={d} />
        ))}
      </ul>
      <p className="mt-3 font-sans text-xs text-(--el-text-muted)">
        {t.rich(
          manualLinkable ? 'development.autoLinkCaptionManual' : 'development.autoLinkCaption',
          {
            key: itemIdentifier,
            mono,
          },
        )}
      </p>
    </>
  );
}

/** The PEEK host — SectionLabel header over the shared body (design Panel 3). */
export function DevelopmentSection({
  pullRequests,
  itemIdentifier,
  className,
  repoDelivery = [],
}: {
  pullRequests: LinkedPullRequestDto[];
  itemIdentifier: string;
  className?: string;
  /** The item's repository set (MOTIR-2416) — passed straight through to the
   *  shared body, so the peek shows the same rows the detail page does rather
   *  than a reduced second form. Unfiltered, per the body's prop note. */
  repoDelivery?: RepoDelivery[];
}) {
  const t = useTranslations('github');
  return (
    <section className={className} data-testid="development-section">
      <SectionLabel label={t('development.title')} />
      <DevelopmentSectionBody
        pullRequests={pullRequests}
        itemIdentifier={itemIdentifier}
        repoDelivery={repoDelivery}
      />
    </section>
  );
}
