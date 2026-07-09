'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import { Footer } from './ConnectStep';
import type { ImportPlan, PlanRow, PreviewResult } from './importClient';

const PAGE_SIZE = 25;

const PLAN_SEVERITY: Record<ImportPlan, 'success' | 'info' | undefined> = {
  create: 'success',
  update: 'info',
  skip: undefined,
};

export function PreviewStep({
  result,
  busy,
  onBack,
  onConfirm,
}: {
  result: PreviewResult;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('import');
  const [page, setPage] = useState(0);

  const { rows, counts } = result;
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp the page so a shrink can never index past the end (defensive slice).
  const safePage = Math.min(page, pageCount - 1);
  const from = safePage * PAGE_SIZE;
  const visible = rows.slice(from, from + PAGE_SIZE);
  const warningCount = rows.reduce((n, r) => n + (r.warnings.length > 0 ? 1 : 0), 0);
  const confirmCount = counts.create + counts.update;
  const isRerun = counts.create === 0 && counts.update > 0;

  if (total === 0) {
    return (
      <section className="flex flex-col gap-6">
        <EmptyState title={t('preview.empty')} description={t('preview.emptyBody')} />
        <Footer>
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            {t('preview.back')}
          </Button>
          <span />
        </Footer>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-(--el-text-strong)">{t('preview.heading')}</h2>
        <p className="text-sm text-(--el-text-muted)">{t('preview.body')}</p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryTile
          tint="bg-(--el-tint-mint)"
          value={counts.create}
          label={t('preview.toCreate')}
          meta={t('preview.toCreateMeta')}
        />
        <SummaryTile
          tint="bg-(--el-tint-sky)"
          value={counts.update}
          label={t('preview.toUpdate')}
          meta={t('preview.toUpdateMeta')}
        />
        <SummaryTile
          tint="bg-(--el-surface)"
          value={counts.skip}
          label={t('preview.toSkip')}
          meta={t('preview.toSkipMeta')}
          muted
        />
      </div>

      {isRerun ? (
        <div className="rounded-(--radius-card) bg-(--el-tint-sky) p-3 text-sm text-(--el-text-strong)">
          <p className="font-medium">{t('preview.rerunTitle')}</p>
          <p>{t('preview.rerunBody')}</p>
        </div>
      ) : null}

      {warningCount > 0 ? (
        <div className="rounded-(--radius-card) bg-(--el-tint-peach) p-3 text-sm text-(--el-text-strong)">
          <span className="font-medium">{t('preview.warnings', { count: warningCount })}</span>{' '}
          {t('preview.warningsHint')}
        </div>
      ) : null}

      {/* Per-issue plan (paginated — never an all-rows dump) */}
      <div className="overflow-x-auto rounded-(--radius-card) border border-(--el-border)">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left text-xs uppercase tracking-wide text-(--el-text-tertiary)">
              <th scope="col" className="px-3 py-2 font-medium">
                {t('preview.colId')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('preview.colTitle')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('preview.colAction')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <PreviewRow key={row.externalId} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div className="flex items-center justify-between text-sm text-(--el-text-muted)">
        <span>
          {t('preview.showing', { from: from + 1, to: Math.min(from + PAGE_SIZE, total), total })}
        </span>
        {pageCount > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label={t('preview.pagePrev')}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 tabular-nums">
              {safePage + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              aria-label={t('preview.pageNext')}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {/* The gate — nothing written yet */}
      <div className="flex items-start gap-3 rounded-(--radius-card) bg-(--el-tint-lavender) p-3 text-sm text-(--el-text-strong)">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--el-accent)" aria-hidden />
        <div>
          <p className="font-medium">{t('preview.gateTitle')}</p>
          <p>{t('preview.gateBody')}</p>
        </div>
      </div>

      <Footer>
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {t('preview.back')}
        </Button>
        <Button onClick={onConfirm} disabled={busy || confirmCount === 0}>
          {t('preview.confirm', { count: confirmCount })}
        </Button>
      </Footer>
    </section>
  );
}

function SummaryTile({
  tint,
  value,
  label,
  meta,
  muted,
}: {
  tint: string;
  value: number;
  label: string;
  meta: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-(--radius-card) p-4',
        tint,
        muted && 'border border-(--el-border)',
      )}
    >
      <span className="font-serif text-2xl font-semibold text-(--el-text-strong) tabular-nums">
        {value}
      </span>
      <span className="text-sm font-medium text-(--el-text-strong)">{label}</span>
      <span className={cn('text-xs', muted ? 'text-(--el-text-faint)' : 'text-(--el-text-strong)')}>
        {meta}
      </span>
    </div>
  );
}

function PreviewRow({ row }: { row: PlanRow }) {
  const t = useTranslations('import');
  const actionLabel =
    row.plan === 'create'
      ? t('preview.actionCreate')
      : row.plan === 'update'
        ? t('preview.actionUpdate')
        : t('preview.actionSkip');
  return (
    <tr className="border-b border-(--el-border-soft) last:border-0">
      <td className="px-3 py-2 align-top font-mono text-xs text-(--el-text-muted)">
        {row.externalId}
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={row.kind} className="size-4 shrink-0" />
          <span className="text-(--el-text)">{row.title}</span>
        </div>
        {row.warnings.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.warnings.map((w, i) => (
              <Pill key={i} severity="warning">
                {w}
              </Pill>
            ))}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        <Pill
          severity={PLAN_SEVERITY[row.plan]}
          tone={PLAN_SEVERITY[row.plan] ? undefined : 'neutral'}
        >
          {actionLabel}
        </Pill>
      </td>
    </tr>
  );
}
