'use client';

import { Fragment, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { CircleEllipsis, CircleX, CornerLeftUp, TriangleAlert, UserRound } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import type { RepairPullRequestRefDto, WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { formatRunInstant } from '@/lib/runs/runClock';

// THE FIX PART of the Development block (Story MOTIR-5460 · MOTIR-5466), built to
// `design/github/design-notes.md` § 21 · Panels F1–F4, and § 26 · Panels X1–X5 for an
// EJECTED card (Story MOTIR-5628 · MOTIR-5721): a member failing only because the
// merge queue threw it out is named on the left-the-queue line, and the offer
// state adds the sentence that says whether *Queue again* or `motir fix` applies.
//
// ⚠️ A FLUSH PART, NOT A BOX. It is the card's own region under a soft rule with
// an `h4`, the grammar How to test uses directly below it — a container does not
// go inside the card that already names it (§ 20, *No card inside a card*).
//
// ⚠️ THE COMMAND BLOCK IS THE SHIPPED `CopyableCodeBlock`, composed exactly as How
// to test's *Locally* fact composes it. Nothing here draws a second code block.
//
// ⚠️ IN PROGRESS SHOWS NO COMMAND AT ALL — not a disabled one. A second person
// must not start a second repair; the claim would refuse it (`taken`) anyway.
//
// The state is decided on the SERVER by the repair claim's own evaluation
// (`workItemRepairService.getRepairView`), so this component never offers a
// command the claim would refuse. `hidden` renders nothing.

/** Relative time in the active locale — minutes, then hours, then days (§ 21). */
export function relativeLabel(iso: string, locale: string, now: number): string {
  const minutes = Math.max(Math.round((now - new Date(iso).getTime()) / 60_000), 0);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (minutes < 60) return fmt.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return fmt.format(-hours, 'hour');
  return fmt.format(-Math.round(hours / 24), 'day');
}

const bold = (chunks: ReactNode) => <b className="font-semibold whitespace-nowrap">{chunks}</b>;

/**
 * A member failing ONLY because the merge queue threw it out — its own checks are
 * not red, and it carries a standing exit (§ 26's show-when rule, MOTIR-5721). It
 * is named on the left-the-queue line, because *Checks are failing* would be false.
 */
function isEjectedOnly(pr: RepairPullRequestRefDto): boolean {
  return pr.queueExit !== null && pr.ci !== 'failing';
}

/** Which of § 26's three sentences applies. A conflict wins: *Queue again*
 *  cannot land that member, whatever the others need. */
function whichVariant(
  ejected: readonly RepairPullRequestRefDto[],
): 'conflict' | 'checks' | 'other' {
  const reasons = ejected.map((pr) => pr.queueExit!.rawReason);
  if (reasons.includes('MERGE_CONFLICT')) return 'conflict';
  if (reasons.some((r) => r === 'CI_FAILURE' || r === 'CI_TIMEOUT')) return 'checks';
  return 'other';
}

function PrLine({
  failing,
  message,
}: {
  failing: RepairPullRequestRefDto[];
  message: 'failingOn' | 'leftQueueOn';
}) {
  const t = useTranslations('github.development.fix');
  const locale = useLocale();
  // Each pull request is named as its row's meta line names it, bold and never
  // broken; the SET is joined by the locale's own list format.
  const names = failing.map((pr) => `${pr.repo} · #${pr.number}`);
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(names);
  const list = parts.map((part, i) =>
    part.type === 'element' ? (
      <b key={i} className="font-semibold whitespace-nowrap">
        {part.value}
      </b>
    ) : (
      <Fragment key={i}>{part.value}</Fragment>
    ),
  );
  return (
    <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text)">
      <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <span>{t.rich(message, { prs: () => list })}</span>
    </p>
  );
}

/** A member failing ONLY because the host reports it conflicted with its base (MOTIR-5916;
 *  design § 30's fix part): its checks are not red and no queue removed it, so *Checks
 *  are failing* would be false — it is named on the conflict line instead. */
function isConflictedOnly(pr: RepairPullRequestRefDto): boolean {
  return pr.conflict !== null && pr.ci !== 'failing' && pr.queueExit === null;
}

/** The conflict line (MOTIR-5916) — `{base}` when every conflicted member names the same
 *  one, *its base branch* otherwise. */
function ConflictLine({ conflicted }: { conflicted: RepairPullRequestRefDto[] }) {
  const t = useTranslations('github.development.fix');
  const locale = useLocale();
  const names = conflicted.map((pr) => `${pr.repo} · #${pr.number}`);
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(names);
  const list = parts.map((part, i) =>
    part.type === 'element' ? (
      <b key={i} className="font-semibold whitespace-nowrap">
        {part.value}
      </b>
    ) : (
      <Fragment key={i}>{part.value}</Fragment>
    ),
  );
  const bases = new Set(conflicted.map((pr) => pr.conflict!.baseRef ?? null));
  const base = bases.size === 1 ? [...bases][0]! : null;
  return (
    <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text)">
      <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <span data-testid="repair-conflict-line">
        {base !== null
          ? t.rich('conflictOn', { prs: () => list, base })
          : t.rich('conflictOnNoBase', { prs: () => list })}
      </span>
    </p>
  );
}

/** The own-checks line, the left-the-queue line and the conflict line — each when the set
 *  holds that kind, own-failing first (§ 26; § 30 for the conflict line). */
function FailingLines({ failing }: { failing: RepairPullRequestRefDto[] }) {
  const own = failing.filter((pr) => !isEjectedOnly(pr) && !isConflictedOnly(pr));
  const ejected = failing.filter(isEjectedOnly);
  const conflicted = failing.filter((pr) => pr.conflict !== null);
  return (
    <>
      {own.length > 0 ? <PrLine failing={own} message="failingOn" /> : null}
      {ejected.length > 0 ? <PrLine failing={ejected} message="leftQueueOn" /> : null}
      {conflicted.length > 0 ? <ConflictLine conflicted={conflicted} /> : null}
    </>
  );
}

/** The WHICH-TO-USE sentence (§ 26): under the command, in the offer state only,
 *  when a member is failing because the queue threw it out. */
function WhichToUse({ ejected }: { ejected: RepairPullRequestRefDto[] }) {
  const t = useTranslations('github.development.fix');
  return (
    <p className="text-xs leading-normal text-(--el-text-secondary)" data-testid="repair-which">
      {t.rich(`which.${whichVariant(ejected)}`, {
        b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
        code: (chunks) => <span className="font-mono">{chunks}</span>,
      })}
    </p>
  );
}

function Command({
  itemIdentifier,
  many,
  conflict,
}: {
  itemIdentifier: string;
  many: boolean;
  /** A member conflicts (MOTIR-5916): the agent rebases or resolves, and there is nothing
   *  to approve until a push re-arms the question (§ 28's fix-part strings). */
  conflict: boolean;
}) {
  const t = useTranslations('github.development.fix');
  return (
    <>
      <p className="text-[13px] leading-normal text-(--el-text)">{t('lead')}</p>
      <CopyableCodeBlock language="shell" code={`motir fix ${itemIdentifier}`} />
      <p className="text-xs leading-normal text-(--el-text-secondary)">
        {t(conflict ? 'howConflict' : many ? 'howMany' : 'how')}
      </p>
      {conflict ? (
        <p className="text-xs leading-normal text-(--el-text-secondary)">{t('rearm')}</p>
      ) : null}
    </>
  );
}

function When({ iso, now }: { iso: string; now: number }) {
  const locale = useLocale();
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso)}>
      {relativeLabel(iso, locale, now)}
    </time>
  );
}

export function RepairFixPart({
  repair,
  itemIdentifier,
  now,
}: {
  repair: WorkItemRepairViewDto;
  /** The card's own `MOTIR-<n>` — the command names it. */
  itemIdentifier: string;
  /** The clock the relative times read. Injected by tests; `Date.now()` otherwise. */
  now?: number;
}) {
  const t = useTranslations('github.development.fix');
  // Read ONCE per mount: a clock read during render is impure, and a relative
  // label that moved between renders would be a hydration mismatch waiting to happen.
  const [clock] = useState(() => now ?? Date.now());
  if (repair.state === 'hidden') return null;

  const pill =
    repair.state === 'in_progress' ? (
      <Pill status="in-progress">
        <CircleEllipsis className="h-3 w-3" aria-hidden />
        {t('fixing.pill')}
      </Pill>
    ) : repair.state === 'offer' && repair.lastGaveUp ? (
      <Pill severity="danger">
        <TriangleAlert className="h-3 w-3" aria-hidden />
        {t('gaveUp.pill')}
      </Pill>
    ) : null;

  return (
    <div
      role="group"
      aria-label={t('aria.part')}
      data-testid="repair-fix-part"
      data-state={repair.state}
      className="mt-4 flex min-w-0 flex-col gap-2 border-t border-(--el-border-soft) pt-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[13px] font-semibold text-(--el-text)">{t('title')}</h4>
        {pill}
      </div>
      <FailingLines failing={repair.failing} />

      {repair.state === 'in_progress' ? (
        <>
          <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)">
            <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
            <span>
              {t.rich(
                repair.byViewer ? 'fixing.byYou' : repair.holder ? 'fixing.by' : 'fixing.bySomeone',
                {
                  name: repair.holder?.name ?? '',
                  b: (chunks) => <b className="font-medium text-(--el-text)">{chunks}</b>,
                  when: () => <When iso={repair.startedAt} now={clock} />,
                },
              )}
            </span>
          </p>
          <p className="text-xs leading-normal text-(--el-text-secondary)">{t('fixing.why')}</p>
        </>
      ) : null}

      {repair.state === 'offer' ? (
        <>
          {repair.lastGaveUp ? (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-danger-surface) px-3 py-2.5 text-[13px] leading-normal text-(--el-danger-surface-text)"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p>
                  {repair.lastGaveUp.attempts === null
                    ? t.rich('gaveUp.titleNoCount', {
                        b: bold,
                        when: () => <When iso={repair.lastGaveUp!.endedAt} now={clock} />,
                      })
                    : t.rich('gaveUp.title', {
                        attempts: repair.lastGaveUp.attempts,
                        b: bold,
                        when: () => <When iso={repair.lastGaveUp!.endedAt} now={clock} />,
                      })}
                </p>
                <p>{t('gaveUp.body')}</p>
              </div>
            </div>
          ) : null}
          <Command
            itemIdentifier={itemIdentifier}
            many={repair.failing.length > 1}
            conflict={repair.failing.some((pr) => pr.conflict !== null)}
          />
          {repair.failing.some(isEjectedOnly) ? (
            <WhichToUse ejected={repair.failing.filter(isEjectedOnly)} />
          ) : null}
        </>
      ) : null}

      {repair.state === 'pointer' ? (
        <p className="flex items-start gap-2 text-[13px] leading-normal text-(--el-text-secondary)">
          <CornerLeftUp className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <span>
            {t.rich('child.pointer', {
              key: repair.runTargetKey,
              link: (chunks) => (
                <Link
                  href={`/items/${encodeURIComponent(repair.runTargetKey)}`}
                  className="font-medium text-(--el-link) underline-offset-2 hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </p>
      ) : null}
    </div>
  );
}
