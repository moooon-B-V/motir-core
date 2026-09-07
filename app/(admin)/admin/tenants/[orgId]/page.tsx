import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Activity, ChevronRight, Coins, Info, ShieldCheck, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { platformBillingClassificationService } from '@/lib/services/platformBillingClassificationService';
import { ClassificationBar } from './_components/ClassificationBar';

/**
 * The operator ORGANIZATION page — design
 * `platform-admin/design-notes.md` **Panel 11** (MOTIR-4566).
 *
 * Drawn in the ACCOUNT drill-down's exact grammar, because it is the same
 * console one entity over: the breadcrumb chips *"Platform › Tenants › {org}"*,
 * the `--el-info` audit banner recording the cross-tenant read, then the
 * identity header.
 *
 * ⚠️ THE BANNER IS TRUE BECAUSE THE READ THAT RENDERED THIS PAGE WROTE THE ROW.
 * `getOrganization` opens a platform transaction whose FIRST statement is the
 * audit INSERT, so the sentence on screen and the row in `platform_audit_log`
 * come from one call and cannot drift apart.
 *
 * ⚠️ AND IT RENDERS ONLY WHAT THIS STORY OWNS. The design's own ALLOCATION table
 * gives the usage rollup, the recent-jobs list and the members list to
 * MOTIR-733, and the workspace and project drill-down LEVELS to that card
 * entirely. They are drawn here as `EmptyState`s naming the card that brings
 * them — the move `admin/page.tsx` already makes for the estate counts, and for
 * the same reason: **a placeholder NUMBER is worse than an absent one**, because
 * a zero looks like an answer.
 *
 * ⚠️ AND IT WRITES NOTHING. The set/unset control is MOTIR-4568's; this page
 * renders the classification and cannot change it. That is why there is no
 * `'use client'` island here at all.
 *
 * ⚠️ NO `loading.tsx` ANYWHERE ABOVE THIS ROUTE. It calls `notFound()` for an
 * unknown org id, and a boundary above a status-deciding segment flushes the
 * response head at 200 — `CLAUDE.md`'s loading-boundary rule. The page is one
 * service call, so there is nothing to stream.
 */

export const metadata: Metadata = {
  // Deliberately generic: a title carrying the tenant's name would put a
  // customer's identity in the browser-tab history of an operator's machine.
  title: 'Organization',
};

/** Never cached — a classification applied a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminOrganizationPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();
  const { orgId } = await params;

  let page;
  try {
    page = await platformBillingClassificationService.getOrganizationPage(principal, orgId);
  } catch (err) {
    // The console's own 404, which is NOT the gate's. The gate answers 404 so a
    // non-staff visitor cannot confirm `/admin` exists; this one answers 404 to
    // somebody already inside it, and means what it says — no such organization.
    if (err instanceof PlatformOrganizationNotFoundError) notFound();
    throw err;
  }

  const { organization: org, actions } = page;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <nav aria-label={t('orgs.breadcrumbAria')} className="flex flex-wrap items-center gap-1">
        <BreadcrumbChip href="/admin">{t('orgs.crumbPlatform')}</BreadcrumbChip>
        <ChevronRight aria-hidden className="h-3 w-3 text-(--el-text-secondary)" />
        <BreadcrumbChip href="/admin/tenants">{t('orgs.crumbTenants')}</BreadcrumbChip>
        <ChevronRight aria-hidden className="h-3 w-3 text-(--el-text-secondary)" />
        <span className="rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)">
          {org.name}
        </span>
      </nav>

      {/* `--el-tint-sky` ground with `--el-text-strong` ink: on a tint,
          `--el-text-muted` fails AA (CLAUDE.md's measured pair table), and this
          is the one line on the page that must be readable on every screen. */}
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
              {/* ⚠️ TWO CHIPS, TWO LABELS. A single "Internal" chip would draw the
                exact conflation `internal-billing-classification.md` §1 refuses:
                `isMeta` means "Motir's own COGS — caps lifted, AI paywall off,
                excluded from revenue"; `internalBilling` means "charged exactly
                like a customer, then made whole by a paired offset". They are
                true together on `moooon` today and that is a coincidence, not an
                identity. */}
              {org.isMeta ? <Pill severity="info">{t('orgs.chip.isMeta')}</Pill> : null}
              {org.internalBilling ? (
                <Pill severity="info">{t('orgs.chip.internalBilling')}</Pill>
              ) : null}
            </span>
          </span>
        </div>

        {/* ⚠️ THE BUTTON IS THE `superadmin` DEGREE'S, AND HIDING IT IS NOT THE
            GATE. This page READS at `support`, and the classification write is a
            billing change — `platform-staff-auth.md` §7 puts that class at
            `superadmin`. So a support- or operator-degree principal legitimately
            sees the organization and cannot act on it. What ENFORCES that is
            `requirePlatformStaff('superadmin')`, asserted in the Server Action
            AND again in the service (§2's two-layer rule); this is presentation,
            and it is said here so nobody later reads the absence of a button as
            the whole of the check. Drawing a control that always refuses would
            teach an operator to ignore a refusal. */}
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

      {/* ── MOTIR-733's regions, RESERVED rather than faked ─────────────────
          Each renders the console's own `EmptyState` naming the card that brings
          it. The alternative — a zero, a dash, a skeleton — asserts something:
          that the number is nought, that the read failed, that data is on its
          way. None of those is true, and the design draws these as reserved
          regions for precisely that reason. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card
          header={
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('orgs.pending.usageTitle')}
            </h2>
          }
        >
          <EmptyState
            icon={<Coins className="h-10 w-10" aria-hidden />}
            title={t('orgs.pending.usageEmptyTitle')}
            description={t('orgs.pending.broughtBy', { owner: 'MOTIR-733' })}
          />
        </Card>
        <Card
          header={
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('orgs.pending.membersTitle')}
            </h2>
          }
        >
          <EmptyState
            icon={<Users className="h-10 w-10" aria-hidden />}
            title={t('orgs.pending.membersEmptyTitle')}
            description={t('orgs.pending.broughtBy', { owner: 'MOTIR-733' })}
          />
        </Card>
      </div>

      <Card
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {t('orgs.pending.jobsTitle')}
          </h2>
        }
      >
        <EmptyState
          icon={<Activity className="h-10 w-10" aria-hidden />}
          title={t('orgs.pending.jobsEmptyTitle')}
          description={t('orgs.pending.broughtBy', { owner: 'MOTIR-733' })}
        />
      </Card>

      {/* ── THE RECORD, on the same surface as the action (MOTIR-4568) ───────
          The console's standing line is that an operator can never perform an
          action and wonder whether it was recorded — so the row the write just
          produced is rendered by the same page, re-read by the action's
          `revalidatePath`. Every row here is a WRITE: the service filters reads
          out by their reason policy, and a page view is not an action. */}
      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">
              {t('orgs.log.title')}
            </h2>
            <Pill tone="neutral">{t('orgs.log.scope')}</Pill>
          </div>
        }
      >
        {actions.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-10 w-10" aria-hidden />}
            title={t('orgs.log.emptyTitle')}
            description={t('orgs.log.emptyDescription')}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {actions.map((row) => (
              <li key={row.id} className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Pill severity="info">{t(`users.log.action.${row.action}`)}</Pill>
                  <span className="font-sans text-xs text-(--el-text-secondary)">
                    {format.dateTime(new Date(row.createdAt))}
                  </span>
                </span>
                <span className="font-sans text-sm text-(--el-text)">
                  {row.reason ?? t('orgs.log.noReason')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** One breadcrumb chip — the account drill-down's, verbatim. */
function BreadcrumbChip({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      {children}
    </Link>
  );
}
