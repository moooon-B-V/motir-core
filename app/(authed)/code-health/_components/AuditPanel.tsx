'use client';

import { useTranslations } from 'next-intl';
import { Clock, FileSearch, FolderGit2, GitCompare, Loader2, Play, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { DeepenAuditCard, DeepenReopenLink } from './DeepenAuditCard';
import type {
  CodeAuditFindingDTO,
  CodeAuditSurfaceDTO,
  CodeHealthSummaryDTO,
  ExternalScannerStateDTO,
} from '@/lib/dto/codeHealth';

const ROW_ESTIMATE_PX = 84;
const ROW_GAP_PX = 8;

// Panel 1 (7.14.1): the code-health CONFORMANCE report — a health summary (grade +
// % conform + per-category breakdown, measured against the approved convention) and
// the grouped, VIRTUALIZED findings list (worst-first; each finding cites the
// convention rule it breaks or the clean-code baseline). Never an unbounded dump —
// more findings stream in by offset as the list scrolls (the scale rule).
export function AuditPanel({
  audit,
  repoRefs,
  findings,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
  scanner,
  reauditing,
  onReaudit,
  pollExhausted,
  onCheckAgain,
  deepenDismissed,
  onDeepenDismiss,
  onDeepenReopen,
}: {
  audit: CodeAuditSurfaceDTO['audit'];
  /** The connected repos this page would audit (`owner/name`). Selects WHICH
   * pre-audit empty state renders — see the `!audit` branch below. */
  repoRefs: string[];
  findings: CodeAuditFindingDTO[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  scanner: ExternalScannerStateDTO | null;
  reauditing: boolean;
  onReaudit: () => void;
  /** The page stopped waiting on a FIRST audit while the job kept running
   * (MOTIR-2080). Selects the pre-audit resting state, never an error. */
  pollExhausted: boolean;
  /** Re-READS the audit. Deliberately NOT a second `onReaudit`: the job is still
   * in flight, so re-POSTing would queue a duplicate pair (MOTIR-2080). */
  onCheckAgain: () => void;
  deepenDismissed: boolean;
  onDeepenDismiss: () => void;
  onDeepenReopen: () => void;
}) {
  if (!audit) {
    return (
      <PreAuditEmptyState
        repoRefs={repoRefs}
        reauditing={reauditing}
        pollExhausted={pollExhausted}
        onReaudit={onReaudit}
        onCheckAgain={onCheckAgain}
      />
    );
  }

  const summary = audit.healthSummary;
  // The "Deepen this audit" affordance is NON-BLOCKING: shown ONLY when the backend
  // reports no external scanner, sits BETWEEN the summary and the findings, and is
  // fully dismissible (a quiet re-open link remains). The report renders unchanged
  // whether it is shown, dismissed, or absent.
  const showDeepen = scanner?.noExternalScanner === true;
  return (
    <div className="flex flex-col gap-4">
      <HealthSummary summary={summary} findingCount={total} />
      {showDeepen && !deepenDismissed ? (
        <DeepenAuditCard
          scanner={scanner}
          reauditing={reauditing}
          onReaudit={onReaudit}
          onDismiss={onDeepenDismiss}
        />
      ) : null}
      {showDeepen && deepenDismissed ? <DeepenReopenLink onReopen={onDeepenReopen} /> : null}
      <FindingsList
        findings={findings}
        total={total}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

// Panel 4b (MOTIR-2087): "no audit" is not one state but FOUR, and the shipped
// start-fresh copy is right for only the first of them. The repo set tells A from
// the rest — a project with connected, indexed repos HAS a codebase, and its
// convention is derived from the code graph, so "no codebase" / "from your chosen
// stack" is false twice over there. Which of B / C / D shows is then the FIRST
// audit's own progress. All four compose the shipped `EmptyState` (icon · title ·
// description · action) — no new pattern, and the repo chips ride inside
// `description` rather than becoming a fifth slot.
function PreAuditEmptyState({
  repoRefs,
  reauditing,
  pollExhausted,
  onReaudit,
  onCheckAgain,
}: {
  repoRefs: string[];
  reauditing: boolean;
  pollExhausted: boolean;
  onReaudit: () => void;
  onCheckAgain: () => void;
}) {
  const t = useTranslations('codeHealth');

  // State A · start-fresh (no repos) — copy unchanged, and it short-circuits: with
  // no code there is nothing to audit, so none of B / C / D can be reached. The
  // design's secondary "View chosen stack" action stays unwired — no such surface
  // exists anywhere in the app, and inventing a destination is not this card's
  // work (recorded on MOTIR-2081).
  if (repoRefs.length === 0) {
    return (
      <EmptyState
        icon={<FileSearch aria-hidden />}
        title={t('audit.emptyTitle')}
        description={t('audit.emptyDescription')}
      />
    );
  }

  // The repo list is the CONSTANT across B / C / D — it is what says "this screen
  // is about your code"; only the headline, the icon and the action change beneath it.
  const repoChips = (
    <span className="mt-(--spacing-sm) flex flex-wrap justify-center gap-1">
      {repoRefs.map((repoRef) => (
        <code
          key={repoRef}
          className="bg-(--el-code-bg) px-1.5 py-0.5 text-xs text-(--el-text-identifier) rounded-(--radius-control)"
        >
          {repoRef}
        </code>
      ))}
    </span>
  );

  // State C · deriving. The action is REMOVED, not disabled and not left in a
  // `loading` state: the job runs for minutes, and a pending button implies a
  // request the page is blocked on and invites a second click. The spinner takes
  // the ICON slot and the duration line takes the action's place — the deriving
  // signal is the ring, never a border-style change.
  //
  // Sized `size-6` to match the SHIPPED siblings, not the mock's 40px ring:
  // EmptyState centres a passed icon inside an h-12 w-12 box at lucide's default
  // 24px, so States A / B / D all render 24px glyphs. A ring drawn to the mock's
  // px would be the only oversized thing on a screen the user watches change.
  if (reauditing) {
    return (
      <EmptyState
        icon={<Loader2 className="size-6 animate-spin text-(--el-accent-on-surface)" aria-hidden />}
        title={t('audit.derivingTitle')}
        description={
          <>
            {t('audit.derivingDescription')}
            {repoChips}
            <span className="mt-(--spacing-sm) block text-(--el-text-muted)">
              {t('audit.derivingDuration')}
            </span>
          </>
        }
      />
    );
  }

  // State D · the page stopped waiting; the job did not. This is a ROUTINE outcome,
  // not an edge case: the poll is 3s × 20 = exactly 60 seconds and a first audit
  // across several repos does not finish in one minute, so most first runs land
  // here. It renders as a resting state INSIDE the empty state — never in the rose
  // error strip where the deepen path's pending message goes, because a job that is
  // still running is not a failure and colouring it as one teaches the user their
  // audit broke.
  if (pollExhausted) {
    return (
      <EmptyState
        icon={<Clock aria-hidden />}
        title={t('audit.stillRunningTitle')}
        description={
          <>
            {t('audit.stillRunningDescription')}
            {repoChips}
          </>
        }
        action={
          <Button variant="secondary" size="sm" leftIcon={<RefreshCw />} onClick={onCheckAgain}>
            {t('audit.checkAgain')}
          </Button>
        }
      />
    );
  }

  // State B · repo-backed but never audited. The action is PRIMARY where State A's
  // is secondary, and the weight difference carries the semantic one: A's action is
  // navigational (there is nothing to run), B's is generative and is the only thing
  // to do on the screen. It fires the SAME trigger the "Re-audit now" button does.
  return (
    <EmptyState
      icon={<FolderGit2 aria-hidden />}
      title={t('audit.noAuditTitle')}
      description={
        <>
          {t('audit.noAuditDescription')}
          {repoChips}
        </>
      }
      action={
        <Button variant="primary" size="sm" leftIcon={<Play />} onClick={onReaudit}>
          {t('audit.runFirstAudit')}
        </Button>
      }
    />
  );
}

function HealthSummary({
  summary,
  findingCount,
}: {
  summary: CodeHealthSummaryDTO;
  findingCount: number;
}) {
  const t = useTranslations('codeHealth');
  const pct = summary.conformancePct;
  // Grade tile tone follows conformance: mint (good) → yellow (watch) → peach (poor).
  const tint = pct === undefined ? 'mint' : pct >= 70 ? 'mint' : pct >= 40 ? 'yellow' : 'peach';

  return (
    <Card tint={tint}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <GitCompare className="size-4 text-(--el-text-secondary)" aria-hidden />
          <span className="text-sm font-medium text-(--el-text-strong)">
            {t('audit.measuredAgainst')}
          </span>
          {summary.conventionVersion !== undefined ? (
            <Pill tone="neutral">
              {t('audit.conventionVersion', { version: summary.conventionVersion })}
            </Pill>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {summary.grade ? (
            <span className="font-serif text-4xl font-semibold text-(--el-text-strong)">
              {summary.grade}
            </span>
          ) : null}
          <div className="flex flex-col">
            {pct !== undefined ? (
              <span className="text-lg font-semibold text-(--el-text-strong)">
                {t('audit.percentConform', { pct })}
              </span>
            ) : null}
            <span className="text-sm text-(--el-text-secondary)">
              {t('audit.summaryExplainer')}
            </span>
          </div>
        </div>

        {summary.byCategory && summary.byCategory.length > 0 ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {summary.byCategory.map((c) => (
              <li key={c.category} className="flex items-center gap-2 text-sm text-(--el-text)">
                <span
                  aria-hidden
                  className={`inline-block size-2 rounded-full ${
                    c.status === 'gap'
                      ? 'bg-(--el-danger)'
                      : c.status === 'watch'
                        ? 'bg-(--el-warning)'
                        : 'bg-(--el-success)'
                  }`}
                />
                <span className="font-medium">{c.label}</span>
                {c.detail ? (
                  <span className="text-(--el-text-muted)">· {c.detail}</span>
                ) : (
                  <span className="text-(--el-text-muted)">
                    · {t(`audit.categoryStatus.${c.status}`)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-xs text-(--el-text-muted)">
          {t('audit.findingsTotal', { count: findingCount })}
        </p>
      </div>
    </Card>
  );
}

function severityPill(severity: string, label: string) {
  switch (severity) {
    case 'critical':
      return <Pill severity="danger">{label}</Pill>;
    case 'high':
      return <Pill severity="warning">{label}</Pill>;
    case 'medium':
      return <Pill severity="info">{label}</Pill>;
    default:
      return <Pill tone="neutral">{label}</Pill>;
  }
}

function FindingsList({
  findings,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  findings: CodeAuditFindingDTO[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const t = useTranslations('codeHealth');
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: findings.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
  });

  const indices: number[] = [];
  if (windowing) {
    for (let i = range.start; i < range.end; i++) indices.push(i);
  } else {
    for (let i = 0; i < findings.length; i++) indices.push(i);
  }

  if (findings.length === 0) {
    return (
      <Card>
        <p className="text-sm text-(--el-text-secondary)">{t('audit.noFindings')}</p>
      </Card>
    );
  }

  return (
    <Card
      header={
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-(--el-text-strong)">
            {t('audit.findingsHeader')}
          </span>
          <Pill tone="neutral">{t('audit.findingsCount', { count: total })}</Pill>
        </div>
      }
    >
      <div
        ref={containerRef}
        role="list"
        aria-label={t('audit.findingsHeader')}
        className={windowing ? 'relative' : 'flex flex-col gap-2'}
        style={windowing ? { height: totalSize } : undefined}
      >
        {indices.map((index) => {
          const f = findings[index]!;
          return (
            <div
              key={`${f.ruleId}-${index}`}
              role="listitem"
              ref={measureElement(index)}
              style={
                windowing
                  ? { position: 'absolute', top: getOffset(index), left: 0, right: 0 }
                  : undefined
              }
            >
              <FindingRow finding={f} />
            </div>
          );
        })}
      </div>

      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" loading={loadingMore} onClick={onLoadMore}>
            {t('audit.loadMore')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FindingRow({ finding }: { finding: CodeAuditFindingDTO }) {
  const t = useTranslations('codeHealth');
  const severityLabel = t(
    `audit.severity.${['critical', 'high', 'medium'].includes(finding.severity) ? finding.severity : 'low'}`,
  );
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex flex-wrap items-center gap-2">
        {severityPill(finding.severity, severityLabel)}
        <span className="text-sm font-semibold text-(--el-text-strong)">{finding.ruleId}</span>
      </div>
      {finding.why ? <p className="text-sm text-(--el-text-secondary)">{finding.why}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {finding.fileRef ? (
          <code className="bg-(--el-code-bg) px-1.5 py-0.5 text-xs text-(--el-text-identifier) rounded-(--radius-control)">
            {finding.fileRef}
            {finding.symbolRef ? ` · ${finding.symbolRef}` : ''}
          </code>
        ) : null}
        {finding.conventionRuleRef ? (
          <span className="bg-(--el-callout-bg) px-1.5 py-0.5 text-xs text-(--el-callout-text) rounded-(--radius-control)">
            {t('audit.conventionRuleRef', { rule: finding.conventionRuleRef })}
          </span>
        ) : (
          <span className="bg-(--el-chip-bg) px-1.5 py-0.5 text-xs text-(--el-text-secondary) rounded-(--radius-control)">
            {t('audit.cleanCodeBaseline')}
          </span>
        )}
      </div>
    </div>
  );
}
