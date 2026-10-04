'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import type { PlatformAuditEntryDTO } from '@/lib/dto/platform';
import { shortHash } from './auditLogUrl';

export type AuditRowChain = 'verified' | 'mismatch' | 'unverified';

export interface AuditLogRow {
  entry: PlatformAuditEntryDTO;
  /** This entry against the page's verification (`auditEntryChainStatus`). */
  chain: AuditRowChain;
}

/**
 * The audit log's ENTRIES TABLE — design Panels 6/7 (MOTIR-752): when (UTC) ·
 * operator with the role AT THE TIME · the action key · target · reason, one row
 * open at a time with the entry number, exact time, actor, action, target with
 * id, full reason, the metadata payload and its hash chained to the previous
 * entry's. A row the chain check could not vouch for carries **Hash mismatch**
 * (the first broken entry) or **Unverified** (everything after it). Nothing is
 * hidden or repaired: the entries are shown as stored.
 *
 * The open row is local state seeded from `?entry=` (the "Show #n" door); it is
 * a disclosure, not a query, so it writes no URL and asks the server nothing.
 */
export function AuditLogTable({
  rows,
  initialOpenSeq,
  clearHref,
}: {
  rows: AuditLogRow[];
  initialOpenSeq: number | null;
  /** Where "Clear filters" goes — rendered in the no-match state. */
  clearHref: string | null;
}) {
  const t = useTranslations('platformAdmin.audit');
  const format = useFormatter();
  const [openSeq, setOpenSeq] = useState<number | null>(initialOpenSeq);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="h-10 w-10" aria-hidden />}
        title={t('empty.title')}
        description={t('empty.body')}
        action={
          clearHref ? (
            <Link
              href={clearHref}
              className="font-sans text-sm text-(--el-accent-on-surface) hover:underline"
            >
              {t('clear')}
            </Link>
          ) : undefined
        }
        data-testid="audit-empty"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full font-sans text-sm"
        aria-label={t('tableLabel')}
        data-testid="audit-table"
      >
        <thead>
          <tr className="text-left text-xs text-(--el-text-secondary)">
            <th className="w-8 py-1" aria-hidden />
            <th className="py-1 pr-3 font-medium">{t('col.when')}</th>
            <th className="py-1 pr-3 font-medium">{t('col.operator')}</th>
            <th className="py-1 pr-3 font-medium">{t('col.action')}</th>
            <th className="py-1 pr-3 font-medium">{t('col.target')}</th>
            <th className="py-1 font-medium">{t('col.reason')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ entry, chain }) => {
            const open = openSeq === entry.seq;
            return (
              <Fragment key={entry.id}>
                <tr
                  className="border-t border-(--el-border) align-top"
                  data-testid={`audit-row-${entry.seq}`}
                  data-chain={chain}
                >
                  <td className="py-2">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={t('detail.toggle', { n: entry.seq })}
                      onClick={() => setOpenSeq(open ? null : entry.seq)}
                      className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                    >
                      {open ? (
                        <ChevronDown aria-hidden className="h-4 w-4" />
                      ) : (
                        <ChevronRight aria-hidden className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-(--el-text-secondary)">
                    <time dateTime={entry.createdAt}>
                      {format.dateTime(new Date(entry.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: 'UTC',
                      })}
                    </time>
                    {chain !== 'verified' ? (
                      <Pill severity="danger" className="ml-2">
                        {chain === 'mismatch' ? t('chain.mismatch') : t('chain.unverified')}
                      </Pill>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="block text-(--el-text)">{entry.actor.email}</span>
                    <span className="block text-xs text-(--el-text-secondary)">
                      {entry.actor.role}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <code className="font-mono text-xs text-(--el-text-identifier)">
                      {entry.action}
                    </code>
                  </td>
                  <td className="py-2 pr-3 text-(--el-text)">
                    {entry.targetLabel ?? entry.targetId ?? entry.targetKind}
                  </td>
                  <td className="py-2 text-(--el-text)">{entry.reason ?? t('detail.none')}</td>
                </tr>
                {open ? (
                  <tr className="bg-(--el-surface-soft)">
                    <td />
                    <td colSpan={5} className="py-3 pr-3">
                      <EntryDetail entry={entry} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EntryDetail({ entry }: { entry: PlatformAuditEntryDTO }) {
  const t = useTranslations('platformAdmin.audit.detail');
  const pairs: [string, React.ReactNode][] = [
    [t('entry'), `#${entry.seq} · ${entry.createdAt}`],
    [t('actor'), `${entry.actor.name} <${entry.actor.email}> · ${entry.actor.role}`],
    [
      t('action'),
      <code key="a" className="font-mono text-xs text-(--el-text-identifier)">
        {entry.action}
      </code>,
    ],
    [
      t('target'),
      `${entry.targetKind}${entry.targetLabel ? ` · ${entry.targetLabel}` : ''}${entry.targetId ? ` · ${entry.targetId}` : ''}`,
    ],
    [t('reason'), entry.reason ?? t('none')],
    [
      t('payload'),
      entry.metadata === null ? (
        t('none')
      ) : (
        <pre
          key="p"
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-(--radius-control) bg-(--el-card) p-(--spacing-tooltip-y) font-mono text-xs text-(--el-text)"
        >
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      ),
    ],
    [
      t('hash'),
      <span key="h" className="font-mono text-xs text-(--el-text-secondary)">
        {shortHash(entry.entryHash)} ·{' '}
        {entry.chainedToSeq !== null && entry.prevHash
          ? `${t('chainedTo', { prev: entry.chainedToSeq })} (${shortHash(entry.prevHash)})`
          : t('genesis')}
      </span>,
    ],
  ];
  return (
    <dl
      className="grid gap-x-4 gap-y-2 font-sans text-sm md:grid-cols-[8rem_1fr]"
      data-testid="audit-detail"
    >
      {pairs.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-xs font-medium text-(--el-text-secondary)">{label}</dt>
          <dd className="min-w-0 text-(--el-text)">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
