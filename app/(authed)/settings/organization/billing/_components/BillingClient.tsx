'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Coins,
  CreditCard,
  Crown,
  ExternalLink,
  Eye,
  Layers,
  Lock,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { AiPlanCatalogEntry, BillingCadence } from '@/lib/billing/catalog';

// The §4 free-tier scale caps the Motir (free) line draws — mirrors
// `lib/billing/entitlements.ts` PM_ENTITLEMENTS.free (the locked ADR §4 numbers).
// The DTO carries the org's PLAN, not its live usage counts (those live in the
// sibling Usage & cost dashboard), so the line shows the CAP ceiling, not a
// used/limit ratio — honest to the contract, not a faked meter.
const FREE_CAPS = { workItems: 250, projects: 3, storageGb: 2 } as const;

export interface BillingClientProps {
  orgId: string;
  orgName: string;
  /** The org's member count (resolved server-side) — the seat count for the
   *  seat preview + the panel-6 seat calc (one seat per member, ADR §3). */
  memberCount: number;
}

type View = 'home' | 'plans' | 'seats';
type LoadState = 'loading' | 'idle' | 'error' | 'forbidden';

// The billing settings surface (Story 8.1.7 · design/billing panels 1–6, 8). A
// client island: it fetches the org's plan from /api/organizations/[orgId]/billing
// over the 8.1.6 boundary (so the loading skeleton + the error/retry state are
// genuine, never a misleading zero), then renders the two billed lines, the
// lifecycle states, the role gate, and the AI-plan / seat-plan screens. Stripe
// Checkout / Portal sessions are started over the same boundary and the browser
// redirects to the returned hosted URL. The PAYWALL (panel 7) is the sibling
// 8.1.8; this card never renders it.
export function BillingClient({ orgId, orgName, memberCount }: BillingClientProps) {
  const t = useTranslations('billing');
  const { toast } = useToast();
  const [data, setData] = useState<BillingStatusDTO | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [view, setView] = useState<View>('home');
  const [redirecting, setRedirecting] = useState(false);
  // The post-Checkout return banner (the webhook is the source of truth, so the
  // tier may still be settling — show a pending note until the refetch confirms).
  const [returnBanner, setReturnBanner] = useState<'success' | 'cancel' | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    setState('loading');
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing`);
      if (mySeq !== seq.current) return;
      if (res.status === 403) {
        setState('forbidden');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const body = (await res.json()) as BillingStatusDTO;
      if (mySeq !== seq.current) return;
      setData(body);
      setState('idle');
    } catch {
      if (mySeq === seq.current) setState('error');
    }
  }, [orgId]);

  useEffect(() => {
    // Read the Stripe return marker (?checkout=success|cancel) the billingService
    // redirect appends, show the matching banner, then strip it so a reload is clean.
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout === 'success' || checkout === 'cancel') {
      // A one-time read of the Stripe return marker from the URL (an external
      // system) — the sanctioned set-state-in-effect case, not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReturnBanner(checkout);
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState(null, '', url.toString());
    }
    // Initial fetch on mount — an external-system sync (the billing API). The
    // synchronous setState lives inside load(), not this effect body.
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start a Stripe session over the boundary, then redirect the browser to the
  // hosted URL. A failure surfaces a toast (the session/credits are untouched).
  const startSession = useCallback(
    async (path: 'checkout' | 'portal', body?: Record<string, string>) => {
      setRedirecting(true);
      try {
        const res = await fetch(`/api/organizations/${orgId}/billing/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) {
          setRedirecting(false);
          toast({ variant: 'error', title: t('states.errorTitle') });
          return;
        }
        const { url } = (await res.json()) as { url: string };
        window.location.href = url;
      } catch {
        setRedirecting(false);
        toast({ variant: 'error', title: t('states.errorTitle') });
      }
    },
    [orgId, t, toast],
  );

  const checkout = useCallback(
    (priceLookupKey: string) => startSession('checkout', { priceLookupKey }),
    [startSession],
  );
  const portal = useCallback(() => startSession('portal'), [startSession]);

  const live = (
    <div aria-live="polite" className="sr-only">
      {state === 'loading' ? t('states.loading') : ''}
    </div>
  );

  if (state === 'loading' && !data) {
    return (
      <>
        {live}
        <BillingSkeleton />
      </>
    );
  }

  if (state === 'forbidden') {
    return (
      <>
        {live}
        <EmptyState
          icon={<Lock className="h-12 w-12 text-(--el-accent-on-surface)" aria-hidden />}
          title={t('member.gateTitle')}
          description={t('member.gateDescription', { org: orgName })}
          action={
            <Link
              href="/settings/organization/members"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('member.contactOwner')}
            </Link>
          }
        />
      </>
    );
  }

  if (state === 'error' || !data) {
    return (
      <>
        {live}
        <ErrorState
          title={t('states.errorTitle')}
          description={t('states.errorDescription')}
          retry={() => load()}
        />
      </>
    );
  }

  // The META org (moooon B.V.) is internal + unlimited + never billed — there is
  // no plan to upgrade and no seat/AI checkout to start, so the storefront (and
  // every CTA) is replaced by a single read-only "Internal plan" card.
  if (data.isMeta) {
    return (
      <div className="flex flex-col gap-5">
        {live}
        <InternalPlanCard t={t} orgName={orgName} />
        <CloudNote t={t} />
      </div>
    );
  }

  const canManage = data.access.canManageBilling;
  const shared = {
    data,
    t,
    canManage,
    orgName,
    memberCount,
    checkout,
    portal,
    redirecting,
  } as const;

  return (
    <div className="flex flex-col gap-5" aria-busy={state === 'loading'}>
      {live}

      {returnBanner ? (
        <ReturnBanner kind={returnBanner} onClose={() => setReturnBanner(null)} t={t} />
      ) : null}

      {view === 'home' ? (
        <HomeView {...shared} goPlans={() => setView('plans')} goSeats={() => setView('seats')} />
      ) : null}
      {view === 'plans' ? <PlansView {...shared} back={() => setView('home')} /> : null}
      {view === 'seats' ? <SeatsView {...shared} back={() => setView('home')} /> : null}

      <CloudNote t={t} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared props + helpers
type T = ReturnType<typeof useTranslations>;

interface SharedViewProps {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  orgName: string;
  memberCount: number;
  checkout: (priceLookupKey: string) => void;
  portal: () => void;
  redirecting: boolean;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtDate(value: string | number | null): string | null {
  if (value == null) return null;
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function cadenceFromPriceId(priceId: string | null): BillingCadence {
  return priceId?.endsWith('_monthly') ? 'monthly' : 'annual';
}

type AiStatus = BillingStatusDTO['motirAi']['subscription']['status'];

function statusKey(status: AiStatus): 'active' | 'trialing' | 'past_due' | 'canceled' | 'none' {
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'none';
}

const STATUS_TINT: Record<string, string> = {
  active: 'bg-(--el-tint-mint)',
  trialing: 'bg-(--el-tint-sky)',
  past_due: 'bg-(--el-tint-yellow)',
  canceled: 'bg-(--el-tint-rose)',
  none: 'bg-(--el-surface)',
};

function StatusPill({ status, t }: { status: AiStatus; t: T }) {
  const key = statusKey(status);
  const icon =
    key === 'active' ? (
      <Check className="h-3 w-3" aria-hidden />
    ) : key === 'trialing' ? (
      <Sparkles className="h-3 w-3" aria-hidden />
    ) : key === 'past_due' ? (
      <AlertTriangle className="h-3 w-3" aria-hidden />
    ) : key === 'canceled' ? (
      <X className="h-3 w-3" aria-hidden />
    ) : null;
  return (
    <Pill
      className={`${STATUS_TINT[key]} text-(--el-text-strong) border-transparent`}
      title={t(`status.${key}`)}
    >
      {icon}
      {t(`status.${key}`)}
    </Pill>
  );
}

function TierPill({ name }: { name: string }) {
  return (
    <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
      {name}
    </Pill>
  );
}

// A token-only allotment meter (the `.meter` pattern shared with ai-usage).
function Meter({ pct, low }: { pct: number; low?: boolean }) {
  return (
    <div
      className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)"
      role="presentation"
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          backgroundColor: low ? 'var(--el-warning)' : 'var(--el-accent)',
        }}
      />
    </div>
  );
}

// A small decorative member-avatar cluster for the seat calc (avatars are
// decorative per the design — the seat COUNT is the load-bearing figure).
function AvatarCluster({ count }: { count: number }) {
  const shown = Math.min(count, 5);
  return (
    <span className="flex items-center" aria-hidden>
      {Array.from({ length: shown }).map((_, i) => (
        <span
          key={i}
          className="-ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--el-tint-lavender) ring-2 ring-(--el-page-bg) first:ml-0"
        />
      ))}
      {count > shown ? (
        <span className="ml-1 font-sans text-xs text-(--el-text-muted)">+{count - shown}</span>
      ) : null}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The META org (moooon B.V.) state — internal, unlimited, never billed. No CTAs:
// there is no plan to change and no checkout to start.
function InternalPlanCard({ t, orgName }: { t: T; orgName: string }) {
  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('internal.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('internal.tagline')}</p>
            </div>
          </div>
          <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
            {t('internal.badge')}
          </Pill>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="font-sans text-sm text-(--el-text)">
          {t('internal.subtitle', { org: orgName })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="neutral">{t('internal.motirLine')}</Pill>
          <Pill tone="neutral">{t('internal.aiLine')}</Pill>
        </div>
        <p className="font-sans text-xs text-(--el-text-muted)">{t('internal.usageNote')}</p>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 2 — the billing home (the two billed lines + payment)
function HomeView({
  data,
  t,
  canManage,
  orgName,
  memberCount,
  portal,
  redirecting,
  goPlans,
  goSeats,
}: SharedViewProps & { goPlans: () => void; goSeats: () => void }) {
  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      {!canManage ? <AdminViewOnlyNote t={t} /> : null}

      <MotirLine
        data={data}
        t={t}
        canManage={canManage}
        memberCount={memberCount}
        goSeats={goSeats}
      />
      <MotirAiLine
        data={data}
        t={t}
        canManage={canManage}
        goPlans={goPlans}
        portal={portal}
        redirecting={redirecting}
      />
      <PaymentCard t={t} canManage={canManage} portal={portal} redirecting={redirecting} />
    </>
  );
}

function AdminViewOnlyNote({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)">
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      <div className="flex flex-col gap-1">
        <Pill tone="neutral" className="w-fit">
          {t('admin.viewOnly')}
        </Pill>
        <p className="font-sans text-xs text-(--el-text-muted)">{t('admin.lockNote')}</p>
      </div>
    </div>
  );
}

// ① Motir (seats) line — free caps + seat preview, or the scaled summary.
function MotirLine({
  data,
  t,
  canManage,
  memberCount,
  goSeats,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  memberCount: number;
  goSeats: () => void;
}) {
  const sub = data.motir.scaledTrackerSubscription;
  const scaled = sub?.status === 'active';
  const seat = data.catalog.seatPlan.prices;
  const annualSeat = seat.annual.amountUsd;
  const renews = fmtDate(sub?.currentPeriodEnd ?? null);

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint) text-(--el-text-strong)">
              <Layers className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('motir.name')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('motir.tagline')}</p>
            </div>
          </div>
          {scaled ? (
            <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
              {t('motir.scaled')}
            </Pill>
          ) : (
            <Pill tone="neutral">{t('motir.free')}</Pill>
          )}
        </div>
      }
    >
      {scaled ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-sans text-sm text-(--el-text)">
              {t('seats.seatsBilled', { n: memberCount })}
            </span>
            <span className="font-sans text-sm font-medium text-(--el-text-strong)">
              {t('seats.planFeeYr', { yr: fmt(memberCount * annualSeat) })}
            </span>
          </div>
          {renews ? (
            <p className="font-sans text-xs text-(--el-text-muted)">
              {t('ai.renews', { date: renews })}
            </p>
          ) : null}
          {canManage ? (
            <div>
              <Button variant="secondary" size="sm" onClick={goSeats}>
                {t('motir.manageSeats')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('motir.freeExplainer', { seat: seat.monthly.amountUsd })}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <CapCell
              label={t('motir.capWorkItems')}
              value={t('motir.capWorkItemsValue', { limit: fmt(FREE_CAPS.workItems) })}
            />
            <CapCell
              label={t('motir.capProjects')}
              value={t('motir.capProjectsValue', { limit: FREE_CAPS.projects })}
            />
            <CapCell
              label={t('motir.capStorage')}
              value={t('motir.capStorageValue', { limit: FREE_CAPS.storageGb })}
            />
          </div>
          <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <div className="flex items-center gap-2">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('motir.seatPreview', { n: memberCount })}
              </span>
            </div>
            <span className="font-serif text-lg text-(--el-text)">
              {t('motir.seatTotalMo', {
                n: memberCount,
                seat: seat.monthly.amountUsd,
                total: fmt(memberCount * seat.monthly.amountUsd),
              })}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="md" onClick={goSeats}>
                {t('motir.upgrade')}
              </Button>
              <span className="font-sans text-xs text-(--el-text-muted)">
                {t('motir.seatsFollow')}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function CapCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-(--radius-control) border border-(--el-border-soft) p-3">
      <span className="font-sans text-xs text-(--el-text-muted)">{label}</span>
      <span className="font-sans text-sm font-medium text-(--el-text)">{value}</span>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)"
        role="presentation"
      >
        <span
          className="block h-full rounded-full"
          style={{ width: '24%', backgroundColor: 'var(--el-accent)' }}
        />
      </div>
    </div>
  );
}

// ② Motir AI line — tier, status, allotment, lifecycle states.
function MotirAiLine({
  data,
  t,
  canManage,
  goPlans,
  portal,
  redirecting,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  goPlans: () => void;
  portal: () => void;
  redirecting: boolean;
}) {
  const { tier, balance, subscription } = data.motirAi;
  const status = subscription.status;
  const key = statusKey(status);
  const allotment = tier?.monthlyCreditAllotment ?? 0;
  const pct = allotment > 0 ? Math.round((Math.min(balance, allotment) / allotment) * 100) : 0;
  const low = key === 'past_due' || (allotment > 0 && balance / allotment < 0.1);
  const cadence = cadenceFromPriceId(subscription.priceId);
  const catalogTier = data.catalog.aiPlans.find((p) => p.key === tier?.key);
  const fee = catalogTier?.prices?.[cadence]?.amountUsd ?? null;
  const renews = fmtDate(subscription.currentPeriodEnd);

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('ai.name')}</h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('ai.tagline')}</p>
            </div>
          </div>
          <StatusPill status={status} t={t} />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {key === 'past_due' ? <PastDueBanner t={t} /> : null}
        {key === 'canceled' ? <CanceledBanner t={t} /> : null}

        {tier && status !== 'canceled' ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <TierPill name={tier.name} />
                <span className="font-sans text-sm text-(--el-text)">
                  {t('ai.creditsPerMo', { n: fmt(allotment) })}
                </span>
              </div>
              {fee !== null ? (
                <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                  {t('ai.planFee')} {t('ai.feePerMo', { n: fee })}
                </span>
              ) : null}
            </div>
            <div>
              <p className="font-sans text-xs text-(--el-text-muted)">
                {t('ai.allotmentThisMonth')}
              </p>
              <Meter pct={pct} low={low} />
              <p className="mt-2 font-sans text-xs text-(--el-text-muted)">
                {t('ai.creditsLeft', { left: fmt(Math.max(0, balance)), total: fmt(allotment) })}
              </p>
            </div>
            {key === 'trialing' ? (
              <p className="font-sans text-xs text-(--el-text-muted)">
                <strong className="text-(--el-text-secondary)">{t('trial.label')}.</strong>{' '}
                {t('trial.note')}
              </p>
            ) : (
              <p className="font-sans text-xs text-(--el-text-muted)">{t('ai.creditsNote')}</p>
            )}
            {renews ? (
              <p className="font-sans text-xs text-(--el-text-muted)">
                {t('ai.renews', { date: renews })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('ai.noPlanYet')}</p>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={goPlans}>
              {key === 'canceled'
                ? t('canceled.cta')
                : status === null
                  ? t('ai.choosePlan')
                  : t('ai.changePlan')}
            </Button>
            {status !== null ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={portal}
                loading={redirecting}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                {t('ai.managePlan')}
              </Button>
            ) : null}
            <Link
              href="/settings/organization/usage"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-link) hover:underline"
            >
              <Coins className="h-4 w-4" aria-hidden />
              {t('ai.viewUsage')}
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function PastDueBanner({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--el-warning)' }}
        aria-hidden
      />
      <p className="font-sans text-xs text-(--el-text-strong)">{t('pastDue.banner')}</p>
    </div>
  );
}

function CanceledBanner({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)">
      <X
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--el-danger-text)' }}
        aria-hidden
      />
      <p className="font-sans text-xs text-(--el-text-strong)">{t('canceled.banner')}</p>
    </div>
  );
}

function PaymentCard({
  t,
  canManage,
  portal,
  redirecting,
}: {
  t: T;
  canManage: boolean;
  portal: () => void;
  redirecting: boolean;
}) {
  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          <h2 className="font-sans text-base font-semibold text-(--el-text)">
            {t('payment.title')}
          </h2>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {canManage ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={portal}
              loading={redirecting}
              leftIcon={<ExternalLink className="h-4 w-4" />}
            >
              {t('payment.portal')}
            </Button>
          </div>
        ) : null}
        <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-muted)">{t('payment.note')}</p>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 5 — Motir AI plans & subscription (AI-only)
function PlansView({
  data,
  t,
  canManage,
  orgName,
  checkout,
  portal,
  redirecting,
  back,
}: SharedViewProps & { back: () => void }) {
  const [cadence, setCadence] = useState<BillingCadence>('annual');
  const { tier, balance, subscription } = data.motirAi;
  const allotment = tier?.monthlyCreditAllotment ?? 0;
  const renews = fmtDate(subscription.currentPeriodEnd);
  const aiPlans = data.catalog.aiPlans;
  const paidActive =
    !!tier &&
    tier.key !== 'free' &&
    (subscription.status === 'active' || subscription.status === 'past_due');

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('plans.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('plans.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">
          {t('plans.subtitle')}
        </p>
      </header>

      {tier && subscription.status ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <TierPill name={tier.name} />
              <StatusPill status={subscription.status} t={t} />
              <span className="font-sans text-sm text-(--el-text-muted)">
                {t('plans.currentStrip', {
                  n: fmt(allotment),
                  left: fmt(Math.max(0, balance)),
                  date: renews ?? '—',
                })}
              </span>
            </div>
            {canManage ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={portal}
                loading={redirecting}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                {t('plans.managePlan')}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="font-sans text-lg font-semibold text-(--el-text)">
          {t('plans.chooseTitle')}
        </h2>
        <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">
          {t('plans.chooseSub')}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Segmented<BillingCadence>
          label={t('plans.cadenceLabel')}
          value={cadence}
          onChange={setCadence}
          options={[
            { value: 'monthly', label: t('plans.monthly') },
            { value: 'annual', label: t('plans.annual') },
          ]}
        />
        {cadence === 'annual' ? (
          <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
            {t('plans.saveBadge')}
          </Pill>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {aiPlans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            cadence={cadence}
            currentKey={tier?.key ?? null}
            status={subscription.status}
            canManage={canManage}
            redirecting={redirecting}
            checkout={checkout}
            t={t}
          />
        ))}
      </div>

      <TopupCard
        data={data}
        t={t}
        canManage={canManage}
        paidActive={paidActive}
        checkout={checkout}
        redirecting={redirecting}
      />

      <p className="max-w-prose font-sans text-xs text-(--el-text-muted)">
        {t('plans.footer', { org: orgName })}
      </p>
    </>
  );
}

function PlanCard({
  plan,
  cadence,
  currentKey,
  status,
  canManage,
  redirecting,
  checkout,
  t,
}: {
  plan: AiPlanCatalogEntry;
  cadence: BillingCadence;
  currentKey: string | null;
  status: AiStatus;
  canManage: boolean;
  redirecting: boolean;
  checkout: (priceLookupKey: string) => void;
  t: T;
}) {
  const isCurrent = currentKey === plan.key && status !== null && status !== 'canceled';
  const isRecommended = plan.recommended;
  const accent = isCurrent || isRecommended;
  const accentIcon =
    plan.key === 'pro' ? (
      <Zap className="h-4 w-4 text-(--el-accent-on-surface)" aria-hidden />
    ) : plan.key === 'max' ? (
      <Crown className="h-4 w-4 text-(--el-accent-on-surface)" aria-hidden />
    ) : null;

  // Price block by cadence (per-month-equivalent for annual, dollar savings).
  let priceBlock: React.ReactNode;
  if (plan.key === 'free') {
    priceBlock = (
      <div>
        <span className="font-serif text-2xl text-(--el-text)">{t('plans.freePrice')}</span>{' '}
        <span className="font-sans text-xs text-(--el-text-muted)">{t('plans.once')}</span>
      </div>
    );
  } else if (!plan.prices) {
    priceBlock = (
      <span className="font-serif text-2xl text-(--el-text)">{t('plans.customPrice')}</span>
    );
  } else if (cadence === 'annual') {
    const annual = plan.prices.annual.amountUsd;
    const monthly = plan.prices.monthly.amountUsd;
    const perMo = Math.round(annual / 12);
    const save = monthly * 12 - annual;
    priceBlock = (
      <div>
        <div>
          <span className="font-serif text-2xl text-(--el-text)">
            {t('plans.perMoEquiv', { n: perMo })}
          </span>
        </div>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.annualSub', { yr: fmt(annual) })}
        </p>
        {save > 0 ? (
          <Pill className="mt-1 bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
            {t('plans.annualSave', { n: fmt(save) })}
          </Pill>
        ) : null}
      </div>
    );
  } else {
    const monthly = plan.prices.monthly.amountUsd;
    const annual = plan.prices.annual.amountUsd;
    const save = monthly * 12 - annual;
    priceBlock = (
      <div>
        <span className="font-serif text-2xl text-(--el-text)">
          {t('plans.perMoEquiv', { n: monthly })}
        </span>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.monthlySub', { yr: fmt(monthly * 12), n: fmt(save) })}
        </p>
      </div>
    );
  }

  // CTA
  let cta: React.ReactNode;
  if (isCurrent) {
    cta = (
      <Button variant="secondary" size="sm" disabled className="w-full">
        {t('plans.ctaCurrent')}
      </Button>
    );
  } else if (plan.key === 'free') {
    cta = (
      <Button variant="secondary" size="sm" disabled className="w-full">
        {t('plans.ctaTrialUsed')}
      </Button>
    );
  } else if (!plan.prices) {
    cta = (
      <a
        href="mailto:sales@motir.co"
        className={`${buttonVariants({ variant: 'secondary', size: 'sm' })} w-full`}
      >
        {t('plans.ctaContactSales')}
      </a>
    );
  } else {
    const priceKey = plan.prices[cadence].priceLookupKey;
    cta = (
      <Button
        variant={isRecommended ? 'primary' : 'secondary'}
        size="sm"
        className="w-full"
        disabled={!canManage}
        loading={redirecting}
        onClick={() => checkout(priceKey)}
      >
        {isRecommended
          ? t('plans.ctaUpgrade', { plan: plan.name })
          : t('plans.ctaChoose', { plan: plan.name })}
      </Button>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-(--radius-card) border bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-card)"
      style={{ borderColor: accent ? 'var(--el-accent)' : 'var(--el-border-soft)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-sans text-base font-semibold text-(--el-text)">
          {accentIcon}
          {plan.name}
        </span>
        {isCurrent ? (
          <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
            {t('plans.current')}
          </Pill>
        ) : isRecommended ? (
          <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
            {t('plans.recommended')}
          </Pill>
        ) : null}
      </div>
      {priceBlock}
      {plan.monthlyCredits != null ? (
        <p className="flex items-center gap-1.5 font-sans text-sm text-(--el-text-secondary)">
          <Check className="h-4 w-4 text-(--el-success)" aria-hidden />
          {t('plans.creditsAllotment', { n: fmt(plan.monthlyCredits) })}
        </p>
      ) : null}
      <div className="mt-auto">{cta}</div>
    </div>
  );
}

// Credit top-up (one-time overage purchase). The checkout route forwards only the
// price lookup key; Stripe collects the quantity on its hosted page, so the bundle
// selector below sets the user's INTENT (and the CTA total) while the boundary
// starts a `credit_topup` Checkout. Owner-only and gated to a paid AI plan (ADR §2).
function TopupCard({
  data,
  t,
  canManage,
  paidActive,
  checkout,
  redirecting,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  paidActive: boolean;
  checkout: (priceLookupKey: string) => void;
  redirecting: boolean;
}) {
  const { unitCredits, unitAmountUsd, priceLookupKey } = data.catalog.creditTopup;
  const bundles = [1, 5, 10];
  const [units, setUnits] = useState(1);
  const credits = units * unitCredits;
  const total = units * unitAmountUsd;
  const enabled = canManage && paidActive;

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          <div>
            <h3 className="font-sans text-base font-semibold text-(--el-text)">
              {t('topup.title')}
            </h3>
            <p className="font-sans text-xs text-(--el-text-muted)">{t('topup.subtitle')}</p>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="font-sans text-sm text-(--el-text)">
          {t('topup.balance', { n: fmt(Math.max(0, data.motirAi.balance)) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('topup.title')}>
          {bundles.map((u) => {
            const selected = u === units;
            return (
              <button
                key={u}
                type="button"
                disabled={!enabled}
                onClick={() => setUnits(u)}
                aria-pressed={selected}
                className="flex flex-col items-start gap-0.5 rounded-(--radius-control) border px-3 py-2 text-left disabled:opacity-50"
                style={{
                  borderColor: selected ? 'var(--el-accent)' : 'var(--el-border)',
                  backgroundColor: selected ? 'var(--el-surface)' : 'transparent',
                }}
              >
                <span className="font-sans text-sm font-medium text-(--el-text)">
                  {t('topup.bundleCredits', { n: fmt(u * unitCredits) })}
                </span>
                <span className="font-sans text-xs text-(--el-text-muted)">
                  {t('topup.bundlePrice', { n: u * unitAmountUsd })}
                </span>
              </button>
            );
          })}
        </div>
        {enabled ? (
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={redirecting}
              onClick={() => checkout(priceLookupKey)}
            >
              {t('topup.buy', { n: fmt(credits), total: fmt(total) })}
            </Button>
          </div>
        ) : null}
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('topup.rate', { unit: unitAmountUsd, credits: fmt(unitCredits) })}
        </p>
        {!paidActive ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-muted)">{t('topup.gate')}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 6 — Motir (seats) plan & upgrade screen
function SeatsView({
  data,
  t,
  canManage,
  orgName,
  memberCount,
  checkout,
  portal,
  redirecting,
  back,
}: SharedViewProps & { back: () => void }) {
  const sub = data.motir.scaledTrackerSubscription;
  const scaled = sub?.status === 'active';
  const seat = data.catalog.seatPlan.prices;
  const annualSeat = seat.annual.amountUsd;
  const monthlySeat = seat.monthly.amountUsd;
  const annualTotal = memberCount * annualSeat;
  const monthlyTotal = memberCount * monthlySeat;
  const annualMoEquiv = Math.round(annualTotal / 12);
  const annualSave = monthlyTotal * 12 - annualTotal;
  const renews = fmtDate(sub?.currentPeriodEnd ?? null);

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('seats.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('seats.breadcrumb', { org: orgName })}
        </p>
      </header>

      {scaled ? (
        <Card
          header={
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint) text-(--el-text-strong)">
                  <Layers className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <h2 className="font-sans text-base font-semibold text-(--el-text)">
                    {t('motir.name')}
                  </h2>
                  <p className="font-sans text-xs text-(--el-text-muted)">{t('seats.scaledSub')}</p>
                </div>
              </div>
              <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                <Check className="h-3 w-3" aria-hidden />
                {t('status.active')}
              </Pill>
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                  {t('motir.scaled')}
                </Pill>
                <span className="font-sans text-sm text-(--el-text)">
                  {t('seats.seatsCount', { n: memberCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                  {t('seats.planFeeYr', { yr: fmt(annualTotal) })}
                </span>
                {annualSave > 0 ? (
                  <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                    {t('seats.annualSaves', { n: fmt(annualSave) })}
                  </Pill>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('seats.seatsBilled', { n: memberCount })}
              </span>
              <span className="ml-auto font-serif text-base text-(--el-text)">
                {t('seats.annualTotal', {
                  n: memberCount,
                  seat: annualSeat,
                  total: fmt(annualTotal),
                })}
              </span>
            </div>
            <p className="font-sans text-xs text-(--el-text-muted)">
              {t('seats.scaledDesc', { mo: annualMoEquiv, date: renews ?? '—' })}
            </p>
            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/settings/organization/members"
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <Users className="h-4 w-4" aria-hidden />
                  {t('seats.manageSeats')}
                </Link>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={portal}
                  loading={redirecting}
                  leftIcon={<ExternalLink className="h-4 w-4" />}
                >
                  {t('plans.managePlan')}
                </Button>
                <button
                  type="button"
                  onClick={portal}
                  className="font-sans text-sm text-(--el-link) hover:underline"
                >
                  {t('seats.switchMonthly')}
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : (
        <Card
          header={
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('seats.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('seats.subtitle')}</p>
            </div>
          }
        >
          <div className="mx-auto flex max-w-[34rem] flex-col gap-4">
            <div className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('seats.membersToSeats', { n: memberCount })}
              </span>
              <span className="ml-auto font-serif text-lg text-(--el-text)">
                {t('seats.annualTotal', {
                  n: memberCount,
                  seat: annualSeat,
                  total: fmt(annualTotal),
                })}
              </span>
            </div>

            <dl className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)">
              <p className="font-sans text-sm font-semibold text-(--el-text)">
                {t('seats.termsTitle')}
              </p>
              <TermRow
                k={t('seats.termBilling')}
                v={t('seats.termBillingValue', { yr: fmt(annualTotal), mo: annualMoEquiv })}
              />
              <TermRow
                k={t('seats.termDueToday')}
                v={t('seats.termDueTodayValue', { yr: fmt(annualTotal) })}
              />
              <TermRow k={t('seats.termAddMember')} v={t('seats.termAddMemberValue')} />
              <TermRow k={t('seats.termRemoveMember')} v={t('seats.termRemoveMemberValue')} />
            </dl>

            <p className="font-sans text-xs text-(--el-text-muted)">
              {t('seats.prorationNote', { mTotal: fmt(monthlyTotal) })}
            </p>

            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  loading={redirecting}
                  onClick={() => checkout(seat.annual.priceLookupKey)}
                >
                  {t('seats.continueCheckout', { yr: fmt(annualTotal) })}
                </Button>
                <Button variant="ghost" size="md" onClick={back}>
                  {t('seats.cancel')}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      )}
    </>
  );
}

function TermRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-(--el-border-soft) pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:gap-3">
      <dt className="font-sans text-xs font-medium text-(--el-text-secondary) sm:w-40 sm:shrink-0">
        {k}
      </dt>
      <dd className="font-sans text-xs text-(--el-text-muted)">{v}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared chrome
function ReturnBanner({
  kind,
  onClose,
  t,
}: {
  kind: 'success' | 'cancel';
  onClose: () => void;
  t: T;
}) {
  const isSuccess = kind === 'success';
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-(--radius-card) p-(--spacing-card-padding) ${isSuccess ? 'bg-(--el-tint-sky)' : 'bg-(--el-surface-soft)'}`}
    >
      {isSuccess ? (
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-strong)" aria-hidden />
      ) : (
        <X className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      )}
      <p className="flex-1 font-sans text-xs text-(--el-text-strong)">
        {isSuccess ? t('states.checkoutPending') : t('states.checkoutCanceled')}
      </p>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('states.retry')}
        className="text-(--el-text-muted) hover:text-(--el-text)"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function CloudNote({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      <p className="font-sans text-xs text-(--el-text-muted)">{t('cloudNote')}</p>
    </div>
  );
}

// Panel 8b — loading skeleton.
function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="block h-7 w-1/3 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <span className="block h-4 w-1/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="mt-3 block h-3 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="mt-3 block h-2 w-full animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </Card>
      ))}
    </div>
  );
}
