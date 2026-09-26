import { getLocale, getTranslations } from 'next-intl/server';
import { Hourglass } from 'lucide-react';
import type { OrganizationDeletionRequestDTO } from '@/lib/dto/organizationDeletion';
import type { Locale } from '@/lib/i18n/locales';
import { daysUntil } from '@/lib/users/dataSubjectRequests';
import { formatDate } from '@/lib/utils/datetime';
import { CancelOrganizationDeletionControl } from './CancelOrganizationDeletionControl';

// The Owner's SCHEDULED row (Story MOTIR-6306 · MOTIR-6402, design MOTIR-6390
// panel 4) — it takes the Delete row's place inside the Danger zone once a
// deletion is scheduled. The `AccountDeletionScheduledCard` grammar: a rose round
// `Hourglass`, the date as the title, who and when with the countdown, and Cancel
// deletion at the right.
//
// A SERVER component, so `router.refresh()` after a cancel from EITHER door (this
// row, or the closing bar) repaints it (CLAUDE.md's page-state contract, case 2).
//
// ⚠️ THE DATE COMES FROM THE STORED ROW (`erasureDueAt`), never recomputed.

export async function OrganizationDeletionScheduledCard({
  orgId,
  orgName,
  request,
  scheduledByName,
  now = new Date(),
}: {
  orgId: string;
  orgName: string;
  request: OrganizationDeletionRequestDTO;
  scheduledByName: string | null;
  /** Injectable clock, so the countdown is assertable. */
  now?: Date;
}) {
  const t = await getTranslations('orgAdmin');
  const locale = (await getLocale()) as Locale;
  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4"
      data-testid="org-deletion-scheduled"
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose) text-(--el-danger-on-surface)">
        <Hourglass aria-hidden className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-sans text-sm font-semibold text-(--el-danger-on-surface)">
          {t('scheduled.title', { date: formatDate(request.erasureDueAt, locale) })}
        </p>
        <p className="mt-1 max-w-[54ch] font-sans text-xs text-(--el-text-secondary)">
          {t.rich('scheduled.body', {
            name: scheduledByName ?? t('scheduled.someone'),
            scheduledAt: formatDate(request.requestedAt, locale),
            daysLeft: daysUntil(request.erasureDueAt, now),
            org: orgName,
            b: (chunks) => <b>{chunks}</b>,
          })}
        </p>
      </div>
      <CancelOrganizationDeletionControl orgId={orgId} orgName={orgName} />
    </div>
  );
}
