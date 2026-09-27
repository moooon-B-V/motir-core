'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  CircleEllipsis,
  CircleX,
  CornerLeftUp,
  GitBranch,
  GitPullRequestArrow,
  History,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { CopyableCodeBlock } from '@/components/markdown/CopyableCodeBlock';
import type { WorkItemContinueViewDto } from '@/lib/dto/workItemContinue';
import { formatRunInstant } from '@/lib/runs/runClock';
import { relativeLabel } from './RepairFixPart';

// THE CONTINUE PART of the Development block (Story MOTIR-6526 · MOTIR-6534), built
// to `design/runs/design-notes.md` § Run died · Panels D1–D8
// (`design/runs/run-section--run-died.mock.html`, approved on MOTIR-6529).
//
// ⚠️ A SIBLING OF § 21's FIX PART, AND BUILT FROM IT. The same flush part (a soft
// rule and an `h4`, never a box inside the card), the same lines, the same
// relative clock, the shipped `CopyableCodeBlock` for the command — so "a red build
// you can hand to an agent" and "a dead run you can hand to an agent" read as one
// family. Nothing here draws a second code block or a new pill variant.
//
// ⚠️ THE STATE IS DECIDED ON THE SERVER, by the continue claim's own evaluation
// (`workItemContinueService.getContinueView`), so this component never offers a
// command the claim would refuse. `alive` and `none` render NOTHING.
//
// ⚠️ IT NEVER SAYS THE WORK ITEM MOVED. The one sentence the marker must get right
// is that the work is safe and the status stands — it says so in words.

/** The part's view, or `error` when the read failed (Panel D8). */
export type ContinuePartView = WorkItemContinueViewDto | { state: 'error' };

const mono = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;
const bold = (chunks: ReactNode) => <b className="font-medium text-(--el-text)">{chunks}</b>;
const branchTag = (chunks: ReactNode) => (
  <span className="font-mono text-[12.5px] whitespace-nowrap text-(--el-text)">{chunks}</span>
);

function When({ iso, now }: { iso: string; now: number }) {
  const locale = useLocale();
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso)}>
      {relativeLabel(iso, locale, now)}
    </time>
  );
}

/** The part's frame — § 21's `Part`: a soft rule, an `h4`, and a pill beside it. */
function Frame({
  state,
  pill,
  children,
}: {
  /** What the part is showing — `data-state`, the signal a spec waits on (as § 21's part). */
  state: string;
  pill?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('github.development.continue');
  return (
    <div
      role="group"
      aria-label={t('aria.part')}
      data-testid="continue-part"
      data-state={state}
      className="mt-4 flex min-w-0 flex-col gap-2 border-t border-(--el-border-soft) pt-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[13px] font-semibold text-(--el-text)">{t('title')}</h4>
        {pill}
      </div>
      {children}
    </div>
  );
}

function Line({
  icon,
  quiet = false,
  children,
}: {
  icon: ReactNode;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      className={`flex items-start gap-2 text-[13px] leading-normal ${quiet ? 'text-(--el-text-secondary)' : 'text-(--el-text)'}`}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

const iconClass = 'mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)';

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-normal text-(--el-text-secondary)">{children}</p>;
}

function DiedPill() {
  const t = useTranslations('github.development.continue');
  return (
    <Pill severity="warning">
      <TriangleAlert className="h-3 w-3" aria-hidden />
      {t('died.pill')}
    </Pill>
  );
}

/** Panel D8 — the read is pending: two skeleton bars, labelled for a screen reader. */
export function ContinuePartSkeleton() {
  const t = useTranslations('github.development.continue');
  return (
    <Frame state="loading">
      <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">
        <div className="h-3 w-[70%] rounded-(--radius-pill) bg-(--el-muted)" />
        <div className="h-3 w-[45%] rounded-(--radius-pill) bg-(--el-muted)" />
      </div>
    </Frame>
  );
}

export function ContinuePart({
  view,
  itemIdentifier,
  statusLabel,
  now,
}: {
  view: ContinuePartView;
  /** The work item's own `MOTIR-<n>` — the command names it. */
  itemIdentifier: string;
  /** The work item's current status, in words — the *nothing moved* line names it. */
  statusLabel: string;
  /** The clock the relative times read. Injected by tests; `Date.now()` otherwise. */
  now?: number;
}) {
  const t = useTranslations('github.development.continue');
  const router = useRouter();
  // Read ONCE per mount, as the fix part does: a relative label that moved between
  // renders would be a hydration mismatch waiting to happen.
  const [clock] = useState(() => now ?? Date.now());
  const when = (iso: string) =>
    function ContinueWhen() {
      return <When iso={iso} now={clock} />;
    };

  if (view.state === 'none' || view.state === 'alive') return null;

  if (view.state === 'error') {
    return (
      <Frame state="error">
        <Line
          icon={<CircleX className={`${iconClass} text-(--el-danger-on-surface)`} aria-hidden />}
        >
          {t('error')}
        </Line>
        <div>
          <Button variant="ghost" size="sm" onClick={() => router.refresh()}>
            {t('retry')}
          </Button>
        </div>
      </Frame>
    );
  }

  if (view.state === 'continuing') {
    return (
      <Frame
        state="continuing"
        pill={
          <Pill status="in-progress">
            <CircleEllipsis className="h-3 w-3" aria-hidden />
            {t('continuing.pill')}
          </Pill>
        }
      >
        <Line quiet icon={<UserRound className={iconClass} aria-hidden />}>
          {t.rich(
            view.byViewer
              ? 'continuing.byYou'
              : view.holder
                ? 'continuing.by'
                : 'continuing.bySomeone',
            { name: view.holder?.name ?? '', b: bold, when: when(view.startedAt) },
          )}
        </Line>
        {view.tookOverFrom?.dispatcher ? (
          <Line quiet icon={<History className={iconClass} aria-hidden />}>
            {t.rich('continuing.tookOver', { name: view.tookOverFrom.dispatcher.name, b: bold })}
          </Line>
        ) : null}
        {view.branch ? (
          <Line quiet icon={<GitBranch className={iconClass} aria-hidden />}>
            {t.rich('continuing.on', { branch: view.branch, ref: branchTag })}
          </Line>
        ) : null}
        <Note>{t.rich('continuing.why', { mono })}</Note>
      </Frame>
    );
  }

  // ── died ──────────────────────────────────────────────────────────────────
  const { deadRun, refusal } = view;
  // A card whose status is not In Progress was deliberately set back (or never
  // run): there is nothing here to offer, and the claim would refuse it.
  if (refusal === 'not_in_progress') return null;

  if (refusal === 'use_fix') {
    return (
      <Frame state="use_fix" pill={<DiedPill />}>
        <Line icon={<TriangleAlert className={iconClass} aria-hidden />}>
          {t.rich('implemented.line', { when: when(deadRun.lastHeardAt) })}
        </Line>
        <Line quiet icon={<GitPullRequestArrow className={iconClass} aria-hidden />}>
          {t('implemented.pr')}
        </Line>
        <Note>{t.rich('implemented.fix', { key: itemIdentifier, mono })}</Note>
      </Frame>
    );
  }

  if (refusal === 'continue_the_parent' && view.parentKey) {
    const parentKey = view.parentKey;
    return (
      <Frame state="continue_the_parent" pill={<DiedPill />}>
        <Line icon={<TriangleAlert className={iconClass} aria-hidden />}>
          {t.rich('child.line', { when: when(deadRun.lastHeardAt) })}
        </Line>
        <Line quiet icon={<CornerLeftUp className={iconClass} aria-hidden />}>
          {t.rich('child.pointer', {
            key: parentKey,
            link: (chunks) => (
              <Link
                href={`/items/${encodeURIComponent(parentKey)}`}
                className="font-medium text-(--el-link) underline-offset-2 hover:underline"
              >
                {chunks}
              </Link>
            ),
          })}
        </Line>
        <CopyableCodeBlock language="shell" code={`motir continue ${parentKey}`} />
        <Note>{t.rich('startOver', { target: parentKey, b: bold })}</Note>
      </Frame>
    );
  }

  const ranBy = deadRun.dispatcher
    ? t.rich('ranBy', {
        name: deadRun.dispatcher.name,
        command: `motir ${deadRun.command === 'run_scope' ? 'run' : deadRun.command}`,
        b: bold,
        mono,
        when: when(deadRun.startedAt),
      })
    : t.rich('ranBySomeone', {
        command: `motir ${deadRun.command === 'run_scope' ? 'run' : deadRun.command}`,
        mono,
        when: when(deadRun.startedAt),
      });

  return (
    <Frame
      state={refusal === null && view.branch !== null ? 'died' : 'no_branch'}
      pill={<DiedPill />}
    >
      <Line icon={<TriangleAlert className={iconClass} aria-hidden />}>
        {t.rich(`reason.${view.reason}`, { when: when(deadRun.lastHeardAt) })}
      </Line>
      <Line quiet icon={<UserRound className={iconClass} aria-hidden />}>
        {ranBy}
      </Line>
      <Line quiet icon={<GitBranch className={iconClass} aria-hidden />}>
        {refusal === 'no_branch' || view.branch === null
          ? t('nothingPushed')
          : view.pullRequest
            ? t.rich('branchWithPr', {
                branch: view.branch,
                pr: `${view.pullRequest.repo} · #${view.pullRequest.number}`,
                ref: branchTag,
                b: bold,
              })
            : t.rich('branch', { branch: view.branch, ref: branchTag })}
      </Line>
      <Note>{t.rich('safe', { status: statusLabel, b: bold })}</Note>
      {refusal === null && view.branch !== null ? (
        <>
          <p className="text-[13px] leading-normal text-(--el-text)">{t('lead')}</p>
          <CopyableCodeBlock language="shell" code={`motir continue ${itemIdentifier}`} />
          <Note>{t('how')}</Note>
        </>
      ) : null}
      <Note>{t.rich('startOver', { target: itemIdentifier, b: bold })}</Note>
    </Frame>
  );
}
