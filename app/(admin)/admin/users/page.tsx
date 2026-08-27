import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Search, UserSearch } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { requirePlatformStaff } from '@/lib/platform/auth';
import {
  PLATFORM_USER_SEARCH_LIMIT,
  PLATFORM_USER_SEARCH_MIN_LENGTH,
  platformSupportService,
} from '@/lib/services/platformSupportService';

/**
 * The operator user LOOKUP — the door design
 * `platform-admin/design-notes.md` **Panel 9** draws and Panel 3 promises:
 * *"Panel 3's global search already groups results into Organizations /
 * Workspaces / Projects / Users, each row with a drill-in chevron — so the user
 * destination is a door Panel 3 promises and 10.1.1 never drew."*
 *
 * ⚠️ THIS IS THE USER GROUP, NOT THE WHOLE ESTATE SEARCH, and the top bar's ⌘K
 * box stays inert beside it rather than half-answering. Three of Panel 3's four
 * groups read tenant tables that have no `platform_staff` READ arm — the ADR's
 * own "deliberately does NOT decide" table allocates every one of those policies
 * to MOTIR-730 — so a palette that answered Users and silently returned nothing
 * for Organizations, Workspaces and Projects would be a search that lies about
 * the estate. `user` has no RLS at all, which is why this half is the half that
 * ships on launch day. `platformSupportService.searchUsers` carries the full
 * reasoning.
 *
 * ---------------------------------------------------------------------------
 * A GET FORM, NOT A CLIENT ISLAND
 * ---------------------------------------------------------------------------
 * The query lives in the URL, so a result set is linkable, survives a reload and
 * is in the operator's history when they need the same account an hour later.
 * Every search is an AUDITED cross-tenant read, which is also the argument
 * against a type-ahead: a keystroke-per-request lookup would write an audit row
 * per keystroke and bury the reads that mattered.
 */

export const metadata: Metadata = {
  // No description, and nothing naming what the surface does — the console's
  // standing rule (see the landing page).
  title: 'Users',
};

/** Never cached: a suspension applied a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin');
  const { q } = await searchParams;
  const query = (q ?? '').trim();
  const results = query ? await platformSupportService.searchUsers(principal, query) : [];
  const tooShort = query.length > 0 && query.length < PLATFORM_USER_SEARCH_MIN_LENGTH;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('users.breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('users.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('users.subtitle')}
        </p>
      </div>

      <form method="GET" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('users.searchLabel')}
          </span>
          <span className="flex h-(--height-input) min-w-0 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) focus-within:ring-2 focus-within:ring-(--focus-ring-color)">
            <Search aria-hidden className="h-4 w-4 shrink-0 text-(--el-text-secondary)" />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder={t('users.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent font-sans text-sm text-(--el-text) outline-none placeholder:text-(--el-text-secondary)"
            />
          </span>
        </label>
        <button
          type="submit"
          className="h-(--height-btn-md) rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) font-sans text-sm font-medium text-(--el-accent-text) hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {t('users.searchSubmit')}
        </button>
      </form>

      {tooShort ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">
          {t('users.tooShort', { n: PLATFORM_USER_SEARCH_MIN_LENGTH })}
        </p>
      ) : null}

      {!query || tooShort ? (
        <EmptyState
          icon={<UserSearch className="h-12 w-12" aria-hidden />}
          title={t('users.idleTitle')}
          description={t('users.idleDescription')}
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<UserSearch className="h-12 w-12" aria-hidden />}
          title={t('users.noneTitle')}
          description={t('users.noneDescription', { query })}
        />
      ) : (
        <Card
          header={
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('users.resultsTitle')}
              </h2>
              <Pill tone="neutral">{t('users.resultsCount', { n: results.length })}</Pill>
            </div>
          }
          footer={
            // The cap is a CAP, not a page — say so when it bites, rather than
            // letting a truncated answer read as the whole one.
            results.length === PLATFORM_USER_SEARCH_LIMIT ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('users.capped', { n: PLATFORM_USER_SEARCH_LIMIT })}
              </p>
            ) : undefined
          }
        >
          <ul className="flex flex-col">
            {results.map((user) => (
              <li key={user.id} className="border-b border-(--el-border-soft) last:border-b-0">
                <Link
                  href={`/admin/users/${user.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
                      {user.name}
                    </span>
                    <span className="block truncate font-sans text-xs text-(--el-text-secondary)">
                      {user.email}
                    </span>
                  </span>
                  {user.suspendedAt ? (
                    <Pill severity="danger">{t('users.suspended')}</Pill>
                  ) : (
                    <Pill tone="neutral">{t('users.active')}</Pill>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
