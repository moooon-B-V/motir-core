import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { platformRoleAtLeast, requirePlatformStaff } from '@/lib/platform/auth';
import { PlatformUserNotFoundError } from '@/lib/platform/errors';
import { platformSupportService } from '@/lib/services/platformSupportService';
import { SupportActionsBar } from './_components/SupportActionsBar';

/**
 * The operator ACCOUNT drill-down — design
 * `platform-admin/design-notes.md` **Panel 9**, card MOTIR-1167.
 *
 * Drawn in Panel 6's exact grammar, per the asset: the `.scope` breadcrumb chips
 * *"Platform › Users › {user}"*, the `--el-info` audit banner recording the
 * cross-tenant read, then the identity header with the two writes in its right
 * slot, then the append-only "Support actions" log.
 *
 * ⚠️ THE BANNER IS TRUE BECAUSE THE READ THAT RENDERED THIS PAGE WROTE THE ROW.
 * `getUserPage` opens a platform transaction whose FIRST statement is the audit
 * INSERT, so the sentence on screen and the row in `platform_audit_log` come
 * from one call and cannot drift apart. A banner rendered beside a read that did
 * not write one would be the worst thing on this page: a promise of
 * accountability that is decoration.
 *
 * ⚠️ AND WHAT IT DELIBERATELY DOES NOT SHOW: the account's organizations,
 * workspaces and projects. Those are tenant tables, none of which has a
 * `platform_staff` READ arm — the ADR's own "deliberately does NOT decide" table
 * allocates every one of those policies to MOTIR-730 — so a read of them from
 * this tier answers with zero rows and raises nothing the day MOTIR-2435 cuts
 * over to the non-bypass role. Rendering "0 workspaces" for an account with four
 * is the silent-narrowing shape MOTIR-2880 recorded, and it is worse than an
 * absent section because it looks like an answer. The tenancy half arrives with
 * the read layer that can serve it.
 *
 * ⚠️ NO `loading.tsx` ANYWHERE ABOVE THIS ROUTE. It calls `notFound()` for an
 * unknown account id, and a boundary above a status-deciding segment flushes the
 * response head at 200 — `CLAUDE.md`'s loading-boundary rule, measured rather
 * than assumed. The page is one service call, so there is nothing to stream.
 */

export const metadata: Metadata = {
  // Deliberately generic: a title carrying the account's email would put a
  // customer's address in the browser-tab history of an operator's machine.
  title: 'Account',
};

/** Never cached — a suspension applied a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminUserPage({ params }: { params: Promise<{ userId: string }> }) {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin');
  // Dates cross the boundary as ISO strings and are rendered here, locale-aware
  // (`lib/dto/platform.ts`'s note on why the DTO carries ISO). A Server
  // Component, so the formatting is deterministic and there is no second render
  // to disagree with the first.
  const format = await getFormatter();
  const { userId } = await params;

  let page;
  try {
    page = await platformSupportService.getUserPage(principal, userId);
  } catch (err) {
    // The console's own 404, which is NOT the gate's. The gate answers 404 so a
    // non-staff visitor cannot confirm `/admin` exists; this one answers 404 to
    // somebody already inside it, and means what it says — no such account. The
    // two coincide on screen and are different types in `lib/platform/errors.ts`
    // for exactly that reason.
    if (err instanceof PlatformUserNotFoundError) notFound();
    throw err;
  }

  const { user, actions } = page;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <nav aria-label={t('users.breadcrumbAria')} className="flex flex-wrap items-center gap-1">
        <BreadcrumbChip href="/admin">{t('users.crumbPlatform')}</BreadcrumbChip>
        <ChevronRight aria-hidden className="h-3 w-3 text-(--el-text-secondary)" />
        <BreadcrumbChip href="/admin/users">{t('users.crumbUsers')}</BreadcrumbChip>
        <ChevronRight aria-hidden className="h-3 w-3 text-(--el-text-secondary)" />
        <span className="rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)">
          {user.name}
        </span>
      </nav>

      {/* The cross-tenant-read banner — Panel 6's, verbatim. `--el-tint-sky`
          ground with `--el-text-strong` ink: on a tint, `--el-text-muted` fails
          AA (CLAUDE.md's measured pair table), and this is the one line on the
          page that must be readable on every screen. */}
      <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
        <span>
          {t('users.auditBanner', {
            name: user.name,
            operator: principal.email,
          })}
        </span>
      </p>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--el-tint-lavender) font-sans text-sm font-semibold text-(--el-text-strong)"
          >
            {user.email.trim().slice(0, 2).toUpperCase()}
          </span>
          <span className="min-w-0">
            <h1 className="truncate font-serif text-2xl text-(--el-text)">{user.name}</h1>
            <span className="block truncate font-sans text-sm text-(--el-text-secondary)">
              {user.email}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              {user.suspendedAt ? (
                <Pill severity="danger">{t('users.suspended')}</Pill>
              ) : (
                <Pill tone="neutral">{t('users.active')}</Pill>
              )}
              {user.emailVerified ? null : (
                <Pill severity="warning">{t('users.emailUnverified')}</Pill>
              )}
              {user.twoFactorEnabled ? <Pill severity="info">{t('users.twoFactor')}</Pill> : null}
              {/* Platform standing, when there is any. It is here so an operator
                  about to suspend a COLLEAGUE finds out before they do it. */}
              {user.platformRole ? (
                <Pill severity="info">
                  {t('users.platformStanding', { role: user.platformRole })}
                </Pill>
              ) : null}
            </span>
          </span>
        </div>

        {/* ⚠️ THE BUTTONS ARE THE `operator` DEGREE'S, AND HIDING THEM IS NOT THE
            GATE. The ADR's §1 ladder puts the two day-1 writes at `operator`
            while this page reads at `support`, so a support-degree operator
            legitimately sees the account and cannot act on it. Drawing controls
            that always refuse would teach them to ignore a refusal. What
            actually ENFORCES it is `requirePlatformStaff('operator')`, asserted
            in the Server Action AND again in the service (§2's two-layer rule) —
            this is presentation, and it is stated here so nobody later reads the
            absence of a button as the whole of the check. */}
        {platformRoleAtLeast(principal.role, 'operator') ? (
          <SupportActionsBar
            userId={user.id}
            name={user.name}
            suspended={user.suspendedAt !== null}
          />
        ) : (
          <p className="max-w-[20rem] font-sans text-xs text-(--el-text-secondary)">
            {t('users.action.readOnlyNotice')}
          </p>
        )}
      </div>

      {user.suspendedAt ? (
        <Card tint="rose">
          <p className="font-sans text-sm text-(--el-text-strong)">
            {t('users.suspendedSince', { at: format.dateTime(new Date(user.suspendedAt)) })}
          </p>
          <p className="mt-1 font-sans text-xs text-(--el-text-strong)">
            {t('users.suspendedReason', {
              reason: user.suspendedReason ?? t('users.noReasonRecorded'),
            })}
          </p>
        </Card>
      ) : null}

      <Card
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {t('users.facts.title')}
          </h2>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          <Fact
            label={t('users.facts.created')}
            value={format.dateTime(new Date(user.createdAt))}
          />
          <Fact
            label={t('users.facts.sessions')}
            value={t('users.facts.sessionCount', { n: user.activeSessionCount })}
          />
          <Fact
            label={t('users.facts.emailVerified')}
            value={user.emailVerified ? t('users.facts.yes') : t('users.facts.no')}
          />
        </dl>
      </Card>

      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('users.log.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('users.log.subtitle')}
              </p>
            </div>
            <Pill tone="neutral">{t('users.log.scope')}</Pill>
          </div>
        }
        footer={
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('users.log.foot', { n: actions.length })}
          </p>
        }
      >
        {actions.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('users.log.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('users.log.colWhen')}</Th>
                  <Th>{t('users.log.colAction')}</Th>
                  <Th>{t('users.log.colOperator')}</Th>
                  <Th>{t('users.log.colReason')}</Th>
                </tr>
              </thead>
              <tbody>
                {actions.map((row) => (
                  <tr key={row.id} className="border-b border-(--el-border-soft)">
                    <Td className="whitespace-nowrap text-(--el-text-secondary)">
                      {format.dateTime(new Date(row.createdAt))}
                    </Td>
                    <Td>
                      <Pill
                        severity={row.action === 'user.suspend' ? 'danger' : 'info'}
                        className="whitespace-nowrap"
                      >
                        {t(`users.log.action.${row.action}`)}
                      </Pill>
                    </Td>
                    <Td className="text-(--el-text-secondary)">
                      {t('users.log.operatorRole', { role: row.actorRole })}
                    </Td>
                    {/* The reason is why this log is worth keeping — it gets the
                        room, and it wraps rather than truncating. */}
                    <Td className="text-(--el-text)">{row.reason ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {label}
      </dt>
      <dd className="mt-1 truncate font-sans text-sm text-(--el-text)">{value}</dd>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>;
}
