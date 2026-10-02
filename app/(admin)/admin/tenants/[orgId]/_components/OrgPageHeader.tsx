import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ArrowLeft, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformOrganizationDetailDTO } from '@/lib/dto/platform';
import { platformRoleAtLeast, type PlatformPrincipal } from '@/lib/platform/auth';
import { ClassificationBar } from './ClassificationBar';
import { ORG_TABS, orgTabHref, type OrgTab } from './orgNav';

/**
 * The org page's frame (MOTIR-733, design D5), drawn on every tab: the ← Tenants
 * button (NO breadcrumb — it returns to the list the operator came from), the
 * audited-read banner, the org header with its pills and classification control,
 * and the three tabs as links (the tab is URL state).
 */
export async function OrgPageHeader({
  org,
  principal,
  tab,
  backHref,
}: {
  org: PlatformOrganizationDetailDTO;
  principal: PlatformPrincipal;
  tab: OrgTab;
  backHref: string;
}) {
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();

  return (
    <>
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 self-start rounded-(--radius-input) px-2 py-1 font-sans text-sm text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {t('orgPage.back')}
      </Link>

      {/* `--el-tint-sky` ground with `--el-text-strong` ink: on a tint,
          `--el-text-muted` fails AA (CLAUDE.md's measured pair table). */}
      <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
        <span>{t('orgs.auditBanner', { name: org.name, operator: principal.email })}</span>
      </p>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--el-tint-lavender) font-sans text-sm font-semibold text-(--el-text-strong)"
          >
            {org.name.trim().slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0">
            <h1 className="truncate font-serif text-2xl text-(--el-text)">{org.name}</h1>
            <span className="block truncate font-sans text-sm text-(--el-text-secondary)">
              {org.slug}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <Pill tone="neutral">
                {t('orgs.createdAt', { at: format.dateTime(new Date(org.createdAt)) })}
              </Pill>
              {org.aiIncludedSeat ? <Pill severity="success">{t('orgs.paidAiPlan')}</Pill> : null}
              {org.hasScaledTrackerSubscription ? (
                <Pill severity="success">{t('orgs.scaledTracker')}</Pill>
              ) : null}
              {/* ⚠️ TWO CHIPS, TWO LABELS — `isMeta` and `internalBilling` are true
                  together on one org today, and that is a coincidence, not an
                  identity (`internal-billing-classification.md` §1). */}
              {org.isMeta ? <Pill severity="info">{t('orgs.chip.isMeta')}</Pill> : null}
              {org.internalBilling ? (
                <Pill severity="info">{t('orgs.chip.internalBilling')}</Pill>
              ) : null}
            </span>
          </span>
        </div>

        {/* ⚠️ HIDING THE BUTTON IS NOT THE GATE — `requirePlatformStaff('superadmin')`
            in the Server Action and the service is (`platform-staff-auth.md` §2, §7).
            This is presentation: a support- or operator-degree principal reads the
            org and cannot act on it. */}
        {platformRoleAtLeast(principal.role, 'superadmin') ? (
          <ClassificationBar orgId={org.id} name={org.name} internalBilling={org.internalBilling} />
        ) : (
          <p className="max-w-[20rem] font-sans text-xs text-(--el-text-secondary)">
            {t('orgs.action.readOnlyNotice')}
          </p>
        )}
      </div>

      {org.internalBilling ? (
        <Card tint="sky">
          <p className="font-sans text-sm text-(--el-text-strong)">
            {t('orgs.internalBillingNote')}
          </p>
        </Card>
      ) : null}

      <nav aria-label={t('orgPage.tabsLabel')} className="flex gap-1 border-b border-(--el-border)">
        {ORG_TABS.map((key) => (
          <Link
            key={key}
            href={orgTabHref(org.id, key, backHref)}
            aria-current={key === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 font-sans text-sm ${
              key === tab
                ? 'border-(--el-accent-on-surface) text-(--el-text)'
                : 'border-transparent text-(--el-text-secondary) hover:text-(--el-text)'
            }`}
          >
            {t(`orgPage.tabs.${key}`)}
          </Link>
        ))}
      </nav>
    </>
  );
}
