import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Clock, Download } from 'lucide-react';
import type { Locale } from '@/lib/i18n/locales';
import { organizationDeletionService } from '@/lib/services/organizationDeletionService';
import { formatDate } from '@/lib/utils/datetime';
import { CancelOrganizationDeletionControl } from '../settings/organization/_components/CancelOrganizationDeletionControl';

// THE APP-WIDE CLOSING BAR (Story MOTIR-6306 · MOTIR-6403, design MOTIR-6390
// panels 5 and 8) — every member of a closing organization sees, above every
// page of every workspace of it, that it is closing, when, and who decided it.
//
// It IS the shipped account bar's grammar (`AccountDeletionBannerBar`): a
// `role="status"` strip in `--el-tint-rose`, a `Clock` in `--el-danger`, the
// sentence. Two variants, by the one thing that differs:
//   - the OWNER — Cancel deletion, opening the same confirm the Danger zone's
//     scheduled row opens (`CancelOrganizationDeletionControl`);
//   - an Admin or a Member — who scheduled it, and Download your data. No
//     Cancel: they cannot use it (MOTIR-2462, hide what a role can never use).
//
// ── MOUNTED ONCE, IN THE SHELL, AND SERVER-RENDERED ──────────────────────────
// Beside `AccountDeletionBanner` in `app/(authed)/layout.tsx` (account bar
// first, then this one — two lines, never merged). A SERVER component, so a
// cancel from EITHER door (this bar, or the Danger zone) clears it on the
// `router.refresh()` that door makes — CLAUDE.md's page-state contract, case 2.
// It renders `null` for an organization that is not closing: no element, so no
// layout shift.
//
// ⚠️ THE DATE AND THE NAME COME FROM THE STORED ROW, via
// `getOrganizationDeletion` — never recomputed.

export interface OrganizationClosingBannerProps {
  userId: string;
  organizationId: string;
  orgName: string;
  /** The viewer holds `deleteOrganization` — the Owner. */
  isOwner: boolean;
}

export async function OrganizationClosingBanner({
  userId,
  organizationId,
  orgName,
  isOwner,
}: OrganizationClosingBannerProps) {
  const { request, scheduledByName } = await organizationDeletionService.getOrganizationDeletion(
    organizationId,
    userId,
  );
  if (!request) return null;

  const [t, locale] = await Promise.all([
    getTranslations('orgClosing'),
    getLocale() as Promise<Locale>,
  ]);
  const date = formatDate(request.erasureDueAt, locale);

  return (
    <div
      role="status"
      data-testid="organization-closing-banner"
      className="flex flex-wrap items-center justify-center gap-3 border-b border-(--el-border) bg-(--el-tint-rose) px-4 py-2 text-center font-sans text-sm text-(--el-text-strong)"
    >
      <Clock aria-hidden className="h-4 w-4 shrink-0 text-(--el-danger)" />
      <span className="min-w-0">
        {isOwner
          ? t('banner.owner', { org: orgName, date })
          : t('banner.member', {
              org: orgName,
              date,
              name: scheduledByName ?? t('banner.someone'),
            })}
      </span>
      {isOwner ? (
        <CancelOrganizationDeletionControl
          orgId={organizationId}
          orgName={orgName}
          variant="ghost"
          size="sm"
        />
      ) : (
        <Link
          href="/settings/account/data"
          className="inline-flex shrink-0 items-center gap-1 font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          <Download aria-hidden className="h-4 w-4" />
          {t('banner.export')}
        </Link>
      )}
    </div>
  );
}
