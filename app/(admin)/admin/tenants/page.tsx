import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Building2, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  PLATFORM_ORG_SEARCH_LIMIT,
  PLATFORM_ORG_SEARCH_MIN_LENGTH,
  platformBillingClassificationService,
} from '@/lib/services/platformBillingClassificationService';

/**
 * The operator ORGANIZATION LOOKUP — design
 * `platform-admin/design-notes.md` **Panel 10** (MOTIR-4566), the door the
 * classification control hangs behind.
 *
 * ---------------------------------------------------------------------------
 * WHY `/admin/tenants` AND NOT `/admin/orgs`
 * ---------------------------------------------------------------------------
 * The card said `/admin/orgs`. The merged design says `/admin/tenants`, and the
 * design is the spec that outranks it — decision-authority rung 2, and the
 * asset's own route table gives the reason: `AdminShell`'s reserved **Tenants**
 * row has pointed at `/admin/tenants` since MOTIR-2896, so building a sibling
 * `orgs` route would leave the reserved row pointing at nothing and put the org
 * level at an address the console's own nav does not name. It also leaves room
 * for the workspace and project LEVELS below an org, which are MOTIR-733's and
 * are not "orgs" at all. The card is amended on the record.
 *
 * ---------------------------------------------------------------------------
 * A GET FORM, NOT A CLIENT ISLAND — the users lookup's argument, unchanged
 * ---------------------------------------------------------------------------
 * The query lives in the URL, so a result set is linkable, survives a reload and
 * is in the operator's history when they need the same org an hour later. Every
 * search is an AUDITED cross-tenant read, which is also the argument against a
 * type-ahead: a keystroke-per-request lookup would write an audit row per
 * keystroke and bury the reads that mattered.
 *
 * ⚠️ AND THE TOP BAR'S ⌘K BOX STAYS INERT BESIDE IT, exactly as it does on the
 * users lookup. Panel 3's estate search groups Organizations / Workspaces /
 * Projects / Users, and MOTIR-4565 shipped the `platform_staff` policy arms for
 * `organization` and for NOTHING ELSE (MOTIR-730 keeps the rest) — so three of
 * that palette's four groups would still answer with zero rows. A search that
 * answered one group and silently returned nothing for the others would be a
 * search that lies about the estate.
 */

export const metadata: Metadata = {
  // No description and nothing naming what the surface does — the console's
  // standing rule, the same one `admin/users/page.tsx` follows.
  title: 'Organizations',
};

/** Never cached: a classification applied a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminTenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin');
  const { q } = await searchParams;
  const query = (q ?? '').trim();
  const results = query
    ? await platformBillingClassificationService.searchOrganizations(principal, query)
    : [];
  const tooShort = query.length > 0 && query.length < PLATFORM_ORG_SEARCH_MIN_LENGTH;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('orgs.breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('orgs.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('orgs.subtitle')}
        </p>
      </div>

      <form method="GET" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('orgs.searchLabel')}
          </span>
          <span className="flex h-(--height-input) min-w-0 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
            <Search aria-hidden className="h-4 w-4 shrink-0 text-(--el-text-secondary)" />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder={t('orgs.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none placeholder:text-(--el-text-secondary)"
            />
          </span>
        </label>
        <button
          type="submit"
          className="h-(--height-btn-md) rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {t('orgs.searchSubmit')}
        </button>
      </form>

      {tooShort ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t('orgs.tooShort', { n: PLATFORM_ORG_SEARCH_MIN_LENGTH })}
        </p>
      ) : null}

      {!query || tooShort ? (
        <EmptyState
          icon={<Building2 className="h-12 w-12" aria-hidden />}
          title={t('orgs.idleTitle')}
          description={t('orgs.idleDescription', { n: PLATFORM_ORG_SEARCH_LIMIT })}
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-12 w-12" aria-hidden />}
          title={t('orgs.noneTitle', { query })}
          description={t('orgs.noneDescription')}
        />
      ) : (
        <Card
          header={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('orgs.resultsTitle')}
              </h2>
              <Pill tone="neutral">{t('orgs.resultsCount', { n: results.length })}</Pill>
            </div>
          }
          footer={
            // The cap is a CAP, not a page — say so when it bites, rather than
            // letting a truncated answer read as the whole one.
            results.length === PLATFORM_ORG_SEARCH_LIMIT ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('orgs.capped', { n: PLATFORM_ORG_SEARCH_LIMIT })}
              </p>
            ) : undefined
          }
        >
          <ul className="flex flex-col">
            {results.map((org) => (
              <li key={org.id} className="border-b border-(--el-border-soft) last:border-b-0">
                <Link
                  href={`/admin/tenants/${org.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
                      {org.name}
                    </span>
                    <span className="block truncate font-sans text-xs text-(--el-text-secondary)">
                      {org.slug}
                    </span>
                  </span>
                  {/* TWO chips, TWO labels — never one collapsed "Internal".
                      `isMeta` means "Motir's own COGS: caps lifted, paywall off,
                      out of revenue"; `internalBilling` means "charged exactly
                      like a customer, then made whole". They are true together
                      on one org today and that coincidence is not identity
                      (`docs/decisions/internal-billing-classification.md` §1). */}
                  {org.isMeta ? <Pill severity="info">{t('orgs.chip.isMeta')}</Pill> : null}
                  {org.internalBilling ? (
                    <Pill severity="info">{t('orgs.chip.internalBilling')}</Pill>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
