import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformAuditChainVerificationDTO } from '@/lib/dto/platform';
import { PLATFORM_AUDIT_ACTION_KEYS } from '@/lib/platform/auditActions';
import { auditEntryChainStatus } from '@/lib/platform/auditChain';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError, PlatformAuditQueryInvalidError } from '@/lib/platform/errors';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { AuditLogFilters } from './_components/AuditLogFilters';
import { AuditLogTable, type AuditLogRow } from './_components/AuditLogTable';
import {
  auditLogHref,
  hasFilters,
  parseAuditLogQuery,
  toSearchFilters,
  type AuditLogQuery,
} from './_components/auditLogUrl';
import { VerifyAgainButton } from './_components/VerifyAgainButton';

/**
 * THE AUDIT LOG — design `platform-admin/design-notes.md` AMENDMENT 2026-10-03,
 * Panels 6, 7, 8e, 8f (MOTIR-752; the chain, verifier and search are MOTIR-751's
 * `platformAuditService`).
 *
 * ⚠️ `superadmin` ONLY, AND EVERYONE ELSE GETS THE 404 (design § Roles, Panel
 * 8f). The `(admin)` layout already 404s a non-staff request; this page 404s an
 * `operator` / `support` the same way, so the route does not exist for them —
 * the rail row is absent too. The services re-gate at `superadmin` regardless.
 *
 * ⚠️ NO `loading.tsx`. The gate decides existence, so the body streams behind an
 * in-page `<Suspense>` placed AFTER it (CLAUDE.md § loading.tsx).
 *
 * Keyset-paged 50 a page, never a total scan: `?c=` carries the stack of
 * cursors Newer pops and Older pushes. Each view is one audited `audit.read`
 * and one `audit.verify` — the search first, so the verification covers the
 * read row it just wrote.
 */

export const metadata: Metadata = {
  title: 'Audit log',
};

export const dynamic = 'force-dynamic';

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let principal: PlatformPrincipal;
  try {
    principal = await requirePlatformStaff('superadmin');
  } catch (err) {
    if (err instanceof NotPlatformStaffError) notFound();
    throw err;
  }
  const query = parseAuditLogQuery(await searchParams);
  const t = await getTranslations('platformAdmin.audit');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-[48rem] font-sans text-sm text-(--el-text-secondary)">
          {t('subtitle')}
        </p>
      </header>
      <Suspense
        key={auditLogHref(query)}
        fallback={
          <Card aria-busy="true">
            <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
              <div className="h-6 w-56 rounded-(--radius-control) bg-(--el-muted)" />
              <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
              <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
              <div className="h-4 w-2/3 rounded-(--radius-control) bg-(--el-muted)" />
            </div>
          </Card>
        }
      >
        <AuditLogBody principal={principal} query={query} />
      </Suspense>
    </div>
  );
}

async function AuditLogBody({
  principal,
  query,
}: {
  principal: PlatformPrincipal;
  query: AuditLogQuery;
}) {
  const t = await getTranslations('platformAdmin.audit');
  const clearHref = hasFilters(query) ? auditLogHref({ scope: query.scope }) : null;

  let page;
  try {
    page = await platformAuditService.searchEntries(
      principal,
      toSearchFilters(query),
      query.cursors.at(-1) ?? null,
    );
  } catch (err) {
    if (!(err instanceof PlatformAuditQueryInvalidError)) throw err;
    return (
      <Card>
        <p role="alert" className="font-sans text-sm text-(--el-text)">
          {t('filter.invalid')}{' '}
          <Link href={auditLogHref({})} className="text-(--el-accent-on-surface) hover:underline">
            {t('clear')}
          </Link>
        </p>
      </Card>
    );
  }
  const verdict = await platformAuditService.verifyChain(principal);

  const rows: AuditLogRow[] = page.entries.map((entry) => ({
    entry,
    chain: auditEntryChainStatus(entry.seq, verdict),
  }));

  return (
    <>
      <ChainIntegrity verdict={verdict} />
      <Card>
        <AuditLogFilters query={query} actions={PLATFORM_AUDIT_ACTION_KEYS} />
      </Card>
      <Card>
        <AuditLogTable rows={rows} initialOpenSeq={query.entry} clearHref={clearHref} />
        {query.cursors.length > 0 || page.nextCursor ? (
          <nav
            className="mt-3 flex justify-end gap-3 font-sans text-sm"
            aria-label={t('tableLabel')}
          >
            {query.cursors.length > 0 ? (
              <Link
                href={auditLogHref({ ...query, cursors: query.cursors.slice(0, -1), entry: null })}
                className="text-(--el-accent-on-surface) hover:underline"
              >
                {t('newer')}
              </Link>
            ) : null}
            {page.nextCursor ? (
              <Link
                href={auditLogHref({
                  ...query,
                  cursors: [...query.cursors, page.nextCursor],
                  entry: null,
                })}
                className="text-(--el-accent-on-surface) hover:underline"
              >
                {t('older')}
              </Link>
            ) : null}
          </nav>
        ) : null}
      </Card>
    </>
  );
}

/**
 * The integrity line (Panel 6) or, when the chain does not verify, the danger
 * callout naming the FIRST bad entry and how many follow it (Panel 7), with
 * **Show #n** opening that entry. The check changed nothing.
 */
async function ChainIntegrity({ verdict }: { verdict: PlatformAuditChainVerificationDTO }) {
  const t = await getTranslations('platformAdmin.audit.chain');
  const format = await getFormatter();
  const time = format.dateTime(new Date(verdict.checkedAt), { timeStyle: 'short' });

  if (verdict.status === 'broken') {
    const showHref = auditLogHref({
      scope: 'all',
      cursors: [String(verdict.brokenAtSeq + 1)],
      entry: verdict.brokenAtSeq,
    });
    return (
      <div
        role="alert"
        data-testid="audit-chain-broken"
        className="flex flex-wrap items-start justify-between gap-3 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)"
      >
        <p className="flex min-w-0 flex-1 items-start gap-2 font-sans text-sm text-(--el-text-strong)">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
          <span>
            <strong className="mr-1">{t('brokenTitle')}.</strong>
            {t('broken', {
              n: verdict.brokenAtSeq,
              at: format.dateTime(new Date(verdict.brokenAtTime), {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'UTC',
              }),
              after: verdict.entriesAfter,
            })}
          </span>
        </p>
        <div className="flex items-center gap-3">
          <Link
            href={showHref}
            className="font-sans text-sm font-medium text-(--el-text-strong) underline"
          >
            {t('show', { n: verdict.brokenAtSeq })}
          </Link>
          <VerifyAgainButton label={t('verify')} />
        </div>
      </div>
    );
  }

  return (
    <Card data-testid="audit-chain-ok" aria-label={t('label')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-2 font-sans text-sm text-(--el-text)">
          <Pill severity="success">
            <ShieldCheck aria-hidden className="h-3 w-3" />
            {t('ok')}
          </Pill>
          <span className="text-(--el-text-secondary)">
            {verdict.throughSeq === null
              ? t('okEmpty')
              : t('okDetail', {
                  count: format.number(verdict.checkedCount),
                  last: format.number(verdict.throughSeq),
                  time,
                })}
          </span>
        </p>
        <VerifyAgainButton label={t('verify')} />
      </div>
    </Card>
  );
}
