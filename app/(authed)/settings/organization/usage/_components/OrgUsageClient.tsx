'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Coins,
  Eye,
  Lock,
  Pause,
  Sparkles,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import type { OrgUsageDTO, UsageScope } from '@/lib/dto/aiUsage';

const RUN_LOG_PAGE_SIZE = 10;
const LOW_BALANCE_FRACTION = 0.1; // a balance under 10% of the allotment is "low"

interface FetchReq {
  scope?: UsageScope;
  workspaceId?: string | null;
  projectId?: string | null;
  page: number;
}

export interface OrgUsageClientProps {
  orgId: string;
  orgName: string;
}

// The org cost dashboard (design ai-usage). A client island: it fetches the
// figures from /api/organizations/[orgId]/usage over the 7.1 boundary (so the
// loading skeleton + the error/retry state are genuine, never a misleading
// zero), and re-fetches on a drill or page change. The server decides the
// effective scope (a member is narrowed to their own project), so the UI renders
// from the RESPONSE's scope/active path (access.isAdmin), never a client hint.
export function OrgUsageClient({ orgId, orgName }: OrgUsageClientProps) {
  const t = useTranslations('aiUsage');
  const [data, setData] = useState<OrgUsageDTO | null>(null);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [req, setReq] = useState<FetchReq>({ page: 1 });
  const seq = useRef(0);

  const load = useCallback(
    async (next: FetchReq) => {
      const mySeq = ++seq.current;
      setStatus('loading');
      try {
        const params = new URLSearchParams({ pageSize: String(RUN_LOG_PAGE_SIZE) });
        if (next.scope) params.set('scope', next.scope);
        if (next.workspaceId) params.set('workspaceId', next.workspaceId);
        if (next.projectId) params.set('projectId', next.projectId);
        params.set('page', String(next.page));
        const res = await fetch(`/api/organizations/${orgId}/usage?${params.toString()}`);
        if (mySeq !== seq.current) return; // a newer request superseded this one
        if (!res.ok) {
          setStatus('error');
          return;
        }
        const body = (await res.json()) as OrgUsageDTO;
        if (mySeq !== seq.current) return;
        setData(body);
        setStatus('idle');
      } catch {
        if (mySeq === seq.current) setStatus('error');
      }
    },
    [orgId],
  );

  useEffect(() => {
    // Fetch the initial figures on mount — an external-system sync (the usage
    // API). load() flips status to 'loading' synchronously, which the
    // set-state-in-effect rule flags even though the component mounts already in
    // 'loading' (a harmless no-op on the first run).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(next: FetchReq) {
    setReq(next);
    void load(next);
  }

  // ── Loading / error are always available (the live-region transition) ──────
  const live = (
    <div aria-live="polite" className="sr-only">
      {status === 'loading' ? t('states.loading') : ''}
    </div>
  );

  if (status === 'loading' && !data) {
    return (
      <>
        {live}
        <DashboardSkeleton />
      </>
    );
  }

  if (status === 'error' || !data) {
    return (
      <>
        {live}
        <ErrorState
          title={t('states.errorTitle')}
          description={t('states.errorDescription')}
          retry={() => load(req)}
        />
      </>
    );
  }

  // ── Member with no accessible project — the limited empty state ────────────
  if (!data.access.isAdmin && data.drill.projects.length === 0 && !data.activeProject) {
    return (
      <>
        {live}
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={t('member.noProjectTitle')}
          description={t('member.noProjectDescription')}
        />
      </>
    );
  }

  // ── First-run empty (no usage in scope) ───────────────────────────────────
  if (!data.hasUsage) {
    return (
      <>
        {live}
        <ScopeControl data={data} isAdmin={data.access.isAdmin} go={go} t={t} />
        <div className="mt-6">
          <EmptyState
            icon={<Coins className="h-12 w-12" aria-hidden />}
            title={t('states.emptyTitle')}
            description={t('states.emptyDescription')}
            action={
              <Link href="/" className={buttonVariants({ variant: 'primary', size: 'md' })}>
                <Sparkles className="h-4 w-4" aria-hidden />
                {t('states.openPlanner')}
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const outOfCredits = data.balance <= 0;
  const allotment = data.tier?.monthlyCreditAllotment ?? 0;
  const lowBalance =
    !outOfCredits && allotment > 0 && data.balance / allotment < LOW_BALANCE_FRACTION;
  const remainingPct =
    allotment > 0 ? Math.max(0, Math.min(100, Math.round((data.balance / allotment) * 100))) : null;

  return (
    <div className="flex flex-col gap-5" aria-busy={status === 'loading'}>
      {live}

      {outOfCredits ? <OutOfCreditsCard orgName={orgName} t={t} /> : null}
      {lowBalance ? (
        <LowBalanceBanner balance={data.balance} pct={remainingPct ?? 0} t={t} />
      ) : null}

      <SummaryPanel data={data} remainingPct={remainingPct} allotment={allotment} t={t} />

      <ScopeControl data={data} isAdmin={data.access.isAdmin} go={go} t={t} />

      {!data.access.isAdmin ? <MemberLockNote t={t} /> : null}

      <PerModelPanel data={data} t={t} />

      <RunLogPanel
        data={data}
        loading={status === 'loading'}
        onPage={(page) => go({ ...req, page })}
        t={t}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
type T = ReturnType<typeof useTranslations>;

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function monthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return yearMonth;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  });
}

// Per-model hue → an --el-* element token (palette, not grey-only · finding #54).
// DeepSeek reuses the subtask teal token rather than reaching Tier-0 (design note).
function modelColorVar(model: string | null): string {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return 'var(--el-accent)';
  if (m.includes('sonnet')) return 'var(--el-info)';
  if (m.includes('haiku')) return 'var(--el-success)';
  if (m.includes('deepseek')) return 'var(--el-type-subtask)';
  return 'var(--el-text-muted)';
}

function jobKindLabel(kind: string, t: T): string {
  switch (kind) {
    case 'generate_tree':
      return t('activity.kindGenerate');
    case 'expand_item':
      return t('activity.kindExpand');
    case 'augment':
      return t('activity.kindAugment');
    case 'replan':
      return t('activity.kindReplan');
    default:
      return t('activity.kindOther');
  }
}

function jobKindTint(kind: string): string {
  switch (kind) {
    case 'generate_tree':
      return 'bg-(--el-tint-lavender)';
    case 'expand_item':
      return 'bg-(--el-tint-sky)';
    case 'augment':
      return 'bg-(--el-tint-mint)';
    default:
      return 'bg-(--el-surface)';
  }
}

function ModelChip({ model, label }: { model: string | null; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: modelColorVar(model) }}
      />
      <span className="font-sans text-sm text-(--el-text)">{label}</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 2 — org cost summary
function SummaryPanel({
  data,
  remainingPct,
  allotment,
  t,
}: {
  data: OrgUsageDTO;
  remainingPct: number | null;
  allotment: number;
  t: T;
}) {
  const history = data.monthlyHistory;
  const maxCredits = Math.max(1, ...history.map((h) => h.credits));
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];
  const delta =
    cur && prev && prev.credits > 0
      ? Math.round(((cur.credits - prev.credits) / prev.credits) * 100)
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
        {/* Balance hero */}
        <Card>
          <span className="flex items-center gap-1.5 font-sans text-xs font-medium text-(--el-text-muted)">
            <Coins className="h-4 w-4" aria-hidden />
            {t('summary.balance')}
          </span>
          <div className="mt-2 font-serif text-[2.125rem] leading-none text-(--el-text)">
            {fmt(data.balance)}
            <span className="ml-1 font-sans text-sm text-(--el-text-muted)">
              {t('summary.creditsUnit')}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 font-sans text-xs text-(--el-text-muted)">
            <span>{data.org.name}</span>
            {data.tier ? (
              <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
                {t('summary.tier', { tier: data.tier.name })}
              </Pill>
            ) : null}
          </div>
          {remainingPct !== null ? (
            <>
              <div
                className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)"
                role="presentation"
              >
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${remainingPct}%`, backgroundColor: 'var(--el-accent)' }}
                />
              </div>
              <p className="mt-2 font-sans text-xs text-(--el-text-muted)">
                {t('summary.allotmentRemaining', { pct: remainingPct, allotment: fmt(allotment) })}
              </p>
            </>
          ) : null}
        </Card>

        {/* Spent all time */}
        <Card>
          <span className="font-sans text-xs font-medium text-(--el-text-muted)">
            {t('summary.spentAllTime')}
          </span>
          <div className="mt-2 font-sans text-lg font-semibold text-(--el-text)">
            {t('summary.credits', { n: fmt(data.totalSpend) })}
          </div>
          <p className="mt-1 font-sans text-xs text-(--el-text-muted)">{t('summary.since')}</p>
        </Card>

        {/* Spent this month + delta */}
        <Card>
          <span className="font-sans text-xs font-medium text-(--el-text-muted)">
            {t('summary.spentThisMonth')}
          </span>
          <div className="mt-2 font-sans text-lg font-semibold text-(--el-text)">
            {t('summary.credits', { n: fmt(data.monthSpend) })}
          </div>
          {delta !== null ? (
            <p
              className="mt-1 font-sans text-xs font-medium"
              style={{ color: delta >= 0 ? 'var(--el-warning)' : 'var(--el-success)' }}
            >
              {delta >= 0
                ? t('summary.deltaUp', { pct: delta })
                : t('summary.deltaDown', { pct: Math.abs(delta) })}
            </p>
          ) : null}
        </Card>
      </div>

      {/* Monthly trend */}
      {history.length > 0 ? (
        <Card
          header={
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-sans text-base font-semibold text-(--el-text)">
                  {t('summary.monthlySpend')}
                </h3>
                <p className="font-sans text-xs text-(--el-text-muted)">
                  {t('summary.monthlySpendSub')}
                </p>
              </div>
              <Pill tone="neutral">{t('summary.creditsChip')}</Pill>
            </div>
          }
        >
          <div className="flex h-28 items-end gap-3">
            {history.map((h, i) => {
              const isCurrent = i === history.length - 1;
              return (
                <div key={h.yearMonth} className="flex flex-1 flex-col items-center gap-1">
                  <span className="font-sans text-[0.625rem] text-(--el-text-muted)">
                    {fmtTokens(h.credits)}
                  </span>
                  <span
                    className="w-full rounded-(--radius-control)"
                    style={{
                      height: `${Math.max(4, Math.round((h.credits / maxCredits) * 80))}px`,
                      backgroundColor: isCurrent ? 'var(--el-accent)' : 'var(--el-tint-lavender)',
                    }}
                  />
                  <span className="font-sans text-[0.625rem] text-(--el-text-muted)">
                    {monthLabel(h.yearMonth)}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* "credits, not a bill" affordance */}
      <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
        <Coins className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-strong)" aria-hidden />
        <p className="font-sans text-xs text-(--el-text-strong)">{t('affordance')}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 3 — drill-down scope control
function ScopeControl({
  data,
  isAdmin,
  go,
  t,
}: {
  data: OrgUsageDTO;
  isAdmin: boolean;
  go: (req: FetchReq) => void;
  t: T;
}) {
  const { scope, activeWorkspace, activeProject, drill } = data;

  // The next-level switcher options, by the active scope.
  let switcher: {
    label: string;
    options: ComboboxOption<string>[];
    onPick: (id: string) => void;
  } | null = null;
  if (isAdmin && scope === 'org' && drill.workspaces.length > 0) {
    switcher = {
      label: t('drill.pickWorkspace'),
      options: drill.workspaces.map((w) => ({ value: w.id, label: w.name })),
      onPick: (id) => go({ scope: 'workspace', workspaceId: id, page: 1 }),
    };
  } else if (
    isAdmin &&
    (scope === 'workspace' || scope === 'project') &&
    drill.projects.length > 0
  ) {
    switcher = {
      label: t('drill.pickProject'),
      options: drill.projects.map((p) => ({ value: p.id, label: p.name })),
      onPick: (id) =>
        go({ scope: 'project', workspaceId: activeWorkspace?.id ?? null, projectId: id, page: 1 }),
    };
  } else if (!isAdmin && drill.projects.length > 1) {
    switcher = {
      label: t('drill.pickProject'),
      options: drill.projects.map((p) => ({ value: p.id, label: p.name })),
      onPick: (id) => go({ scope: 'project', projectId: id, page: 1 }),
    };
  }

  const levelPill =
    scope === 'org'
      ? t('drill.orgLevel')
      : scope === 'workspace'
        ? t('drill.workspaceLevel')
        : t('drill.projectLevel');

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 font-sans text-sm">
            <span className="text-(--el-text-muted)">{t('drill.scope')}:</span>
            {/* Breadcrumb — crossed segments stay clickable (go back up). */}
            {isAdmin ? (
              <SegButton
                active={scope === 'org'}
                onClick={() => go({ scope: 'org', page: 1 })}
                label={t('drill.orgSegment', { org: data.org.name })}
              />
            ) : null}
            {activeWorkspace ? (
              <>
                <Sep />
                <SegButton
                  active={scope === 'workspace'}
                  onClick={() =>
                    go({ scope: 'workspace', workspaceId: activeWorkspace.id, page: 1 })
                  }
                  label={activeWorkspace.name}
                />
              </>
            ) : null}
            {activeProject ? (
              <>
                {isAdmin ? <Sep /> : null}
                <SegButton active label={activeProject.name} />
              </>
            ) : null}
          </div>
          <Pill tone="neutral">{levelPill}</Pill>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        {switcher ? (
          <div className="w-56">
            <Combobox<string>
              label={switcher.label}
              options={switcher.options}
              value={
                scope === 'org'
                  ? (activeWorkspace?.id ?? '')
                  : (activeProject?.id ?? activeWorkspace?.id ?? '')
              }
              onChange={switcher.onPick}
              placeholder={switcher.label}
            />
          </div>
        ) : null}
        <p className="min-w-0 flex-1 font-sans text-xs text-(--el-text-muted)">{t('drill.note')}</p>
      </div>
    </Card>
  );
}

function SegButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick?: () => void;
  label: string;
}) {
  if (active || !onClick) {
    return (
      <span className="rounded-(--radius-control) bg-(--el-tint-lavender) px-2 py-0.5 font-medium text-(--el-text-strong)">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-(--radius-control) px-2 py-0.5 text-(--el-link) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      {label}
    </button>
  );
}

function Sep() {
  return <span className="text-(--el-text-muted)">›</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 4 — per-model breakdown
function PerModelPanel({ data, t }: { data: OrgUsageDTO; t: T }) {
  const rows = data.perModel;
  const maxCredits = Math.max(1, ...rows.map((r) => r.credits));
  const totalIn = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.outputTokens, 0);
  const totalCredits = rows.reduce((s, r) => s + r.credits, 0);

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <h3 className="font-sans text-base font-semibold text-(--el-text)">
            {t('byModel.title')}
          </h3>
          <Pill tone="neutral">{t('byModel.count', { n: rows.length })}</Pill>
        </div>
      }
      footer={
        <div className="flex items-center justify-between font-sans text-xs">
          <span className="text-(--el-text-muted)">
            {t('byModel.foot', { in: fmtTokens(totalIn), out: fmtTokens(totalOut) })}
          </span>
          <span className="font-semibold text-(--el-text-strong)">
            {t('byModel.footCredits', { n: fmt(totalCredits) })}
          </span>
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-muted)">{t('states.emptyTitle')}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-(--el-border-soft) border-b text-left font-sans text-xs text-(--el-text-muted)">
              <th className="py-2 font-medium">{t('byModel.model')}</th>
              <th className="py-2 text-right font-medium tabular-nums">{t('byModel.tokensIn')}</th>
              <th className="py-2 text-right font-medium tabular-nums">{t('byModel.tokensOut')}</th>
              <th className="hidden py-2 font-medium sm:table-cell">{t('byModel.share')}</th>
              <th className="py-2 text-right font-medium tabular-nums">{t('byModel.credits')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-(--el-border-soft) border-b last:border-b-0">
                <td className="py-2">
                  <ModelChip model={r.model} label={r.model} />
                </td>
                <td className="py-2 text-right tabular-nums text-(--el-text-muted)">
                  {fmtTokens(r.inputTokens)}
                </td>
                <td className="py-2 text-right tabular-nums text-(--el-text-muted)">
                  {fmtTokens(r.outputTokens)}
                </td>
                <td className="hidden py-2 sm:table-cell">
                  <span className="block h-1.5 w-full max-w-32 overflow-hidden rounded-full bg-(--el-muted)">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.round((r.credits / maxCredits) * 100)}%`,
                        backgroundColor: modelColorVar(r.model),
                      }}
                    />
                  </span>
                </td>
                <td className="py-2 text-right font-medium tabular-nums text-(--el-text-strong)">
                  {fmt(r.credits)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 5 — recent activity / per-run log (PAGINATED)
function RunLogPanel({
  data,
  loading,
  onPage,
  t,
}: {
  data: OrgUsageDTO;
  loading: boolean;
  onPage: (page: number) => void;
  t: T;
}) {
  const { runs, page, pageSize, total } = data.recentRuns;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = (page - 1) * pageSize + runs.length;
  const scopeLabel =
    data.activeProject?.name ??
    data.activeWorkspace?.name ??
    t('drill.orgSegment', { org: data.org.name });

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-sans text-base font-semibold text-(--el-text)">
              {t('activity.runs')}
            </h3>
            <Pill tone="neutral">{t('activity.total', { n: fmt(total) })}</Pill>
          </div>
          <span className="font-sans text-xs text-(--el-text-muted)">
            {t('activity.scopeNote', { scope: scopeLabel })}
          </span>
        </div>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-xs text-(--el-text-muted)" aria-live="polite">
            {t('activity.pagerShowing', { from, to, total: fmt(total) })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<ChevronLeft className="h-4 w-4" />}
              onClick={() => onPage(page - 1)}
              disabled={page <= 1 || loading}
            >
              {t('activity.prev')}
            </Button>
            <span className="font-sans text-xs text-(--el-text-muted)">
              {t('activity.pagerPage', { n: page, m: pageCount })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              rightIcon={<ChevronRight className="h-4 w-4" />}
              onClick={() => onPage(page + 1)}
              disabled={page >= pageCount || loading}
            >
              {t('activity.next')}
            </Button>
          </div>
        </div>
      }
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-(--el-border-soft) border-b text-left font-sans text-xs text-(--el-text-muted)">
            <th className="py-2 font-medium">{t('activity.when')}</th>
            <th className="py-2 font-medium">{t('activity.run')}</th>
            <th className="hidden py-2 font-medium sm:table-cell">{t('activity.model')}</th>
            <th className="py-2 text-right font-medium tabular-nums">{t('activity.tokens')}</th>
            <th className="py-2 text-right font-medium tabular-nums">{t('activity.credits')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.jobId} className="border-(--el-border-soft) border-b last:border-b-0">
              <td className="py-2 font-sans text-xs text-(--el-text-muted)">
                {new Date(r.startedAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </td>
              <td className="py-2">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Pill
                    className={`${jobKindTint(r.jobKind)} text-(--el-text-strong) border-transparent`}
                  >
                    {jobKindLabel(r.jobKind, t)}
                  </Pill>
                  <span className="font-sans text-xs text-(--el-text-muted)">
                    {r.projectName || t('activity.unknownProject')}
                  </span>
                </span>
              </td>
              <td className="hidden py-2 sm:table-cell">
                <ModelChip model={r.model} label={r.model ?? '—'} />
              </td>
              <td className="py-2 text-right tabular-nums text-(--el-text-muted)">
                {fmtTokens(r.inputTokens + r.outputTokens)}
              </td>
              <td className="py-2 text-right font-medium tabular-nums text-(--el-text-strong)">
                {fmt(r.credits)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 6 — member lock note · Panel 7 — low-balance / out-of-credits
function MemberLockNote({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)">
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      <div className="flex flex-col gap-1">
        <Pill tone="neutral" className="w-fit">
          {t('member.readOnly')}
        </Pill>
        <p className="font-sans text-xs text-(--el-text-muted)">{t('member.lockNote')}</p>
      </div>
    </div>
  );
}

function LowBalanceBanner({ balance, pct, t }: { balance: number; pct: number; t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--el-warning)' }}
        aria-hidden
      />
      <p className="font-sans text-xs text-(--el-text-strong)">
        <strong>{t('lowBalance.title')}</strong> {t('lowBalance.body', { n: fmt(balance), pct })}
      </p>
    </div>
  );
}

function OutOfCreditsCard({ orgName, t }: { orgName: string; t: T }) {
  return (
    <Card className="flex flex-col items-center gap-3 text-center">
      <span
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-(--el-tint-yellow)"
        style={{ color: 'var(--el-warning)' }}
      >
        <Pause className="h-6 w-6" aria-hidden />
      </span>
      <h3 className="font-serif text-xl text-(--el-text)">{t('outOfCredits.title')}</h3>
      <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">
        {t('outOfCredits.body', { org: orgName })}
      </p>
      {/* PASSIVE Epic-8 slot — NO active buy/upgrade control here. */}
      <div className="w-full max-w-prose rounded-(--radius-card) border border-dashed border-(--el-border) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-muted)">
        {t('outOfCredits.passiveSlot')}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 8b — loading skeleton
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <span className="block h-2.5 w-1/2 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span className="mt-3 block h-6 w-3/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
            <span className="mt-3 block h-2 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          </Card>
        ))}
      </div>
      <Card>
        <div className="flex h-28 items-end gap-3">
          {[38, 54, 44, 70, 60, 72].map((h, i) => (
            <span
              key={i}
              className="flex-1 animate-pulse rounded-(--radius-control) bg-(--el-muted)"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
