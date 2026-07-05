'use client';

import { useTranslations } from 'next-intl';
import { FileSearch, GitCompare } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useRowWindow } from '@/components/ui/useRowWindow';
import type {
  CodeAuditFindingDTO,
  CodeAuditSurfaceDTO,
  CodeHealthSummaryDTO,
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
  findings,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  audit: CodeAuditSurfaceDTO['audit'];
  findings: CodeAuditFindingDTO[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const t = useTranslations('codeHealth');

  if (!audit) {
    return (
      <EmptyState
        icon={<FileSearch aria-hidden />}
        title={t('audit.emptyTitle')}
        description={t('audit.emptyDescription')}
      />
    );
  }

  const summary = audit.healthSummary;
  return (
    <div className="flex flex-col gap-4">
      <HealthSummary summary={summary} findingCount={total} />
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
