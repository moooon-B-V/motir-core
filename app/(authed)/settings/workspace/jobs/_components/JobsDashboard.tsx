'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import { formatDateTime } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import type { EmailDeliveryState, JobRunDTO, JobRunDlqDTO, JobRunStatus } from '@/lib/dto/jobs';
import { replayDlqAction } from '../actions';

// Client orchestrator for the operator dashboard (Subtask 1.6.5). Receives the
// active tab's already-fetched, serializable data from the server page and
// renders the tab strip, status filter, the runs / DLQ tables, the row-detail
// JSON dialog, the owner-gated Replay action, pagination, and a Refresh button.
//
// Tabs + filters + paging are URL-driven (Link navigations that re-run the
// server fetch) — there is NO client polling or websockets in v1 (the AC's
// explicit deferral; auto-refresh is PRODECT_FINDINGS #37). The only genuinely
// client-side state is the open detail dialog and the in-flight replay.

export type JobsTab = 'runs' | 'dlq' | 'system';

const BASE = '/settings/workspace/jobs';

const STATUS_FILTER_VALUES: (JobRunStatus | 'all')[] = ['all', 'succeeded', 'failed', 'running'];

export interface JobsDashboardProps {
  activeTab: JobsTab;
  status?: JobRunStatus;
  page: number;
  hasNext: boolean;
  dlqCount: number;
  isOwner: boolean;
  showSystemTab: boolean;
  /** Populated for the runs + system tabs (empty on the dlq tab). */
  runs: JobRunDTO[];
  /** Populated for the dlq tab (empty on the runs + system tabs). */
  dlq: JobRunDlqDTO[];
}

function buildHref(params: { tab: JobsTab; status?: JobRunStatus | 'all'; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.tab !== 'runs') sp.set('tab', params.tab);
  if (params.status && params.status !== 'all') sp.set('status', params.status);
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  const qs = sp.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
// `formatDateTime` (deterministic en-US/UTC, the 1.6.5 hydration fix) is now the
// shared `@/lib/utils/datetime` formatter — reused, not re-derived (the issue
// detail page renders audit timestamps through the same module).

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusSeverity(status: JobRunStatus): 'success' | 'danger' | 'info' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  return 'info';
}

/**
 * The DELIVERY tone map (Bug MOTIR-3507 · Subtask MOTIR-3517) — exactly as
 * `design/jobs/design-notes.md` specifies, and no new component: every value is
 * the `Pill` primitive.
 *
 * `accepted` is the one that is NOT a severity, and deliberately: it means the
 * provider took the message and has said nothing since. That is the absence of
 * news, not good news, and colouring it as success would restate the exact
 * conflation this column exists to end.
 */
export function deliveryPill(state: EmailDeliveryState, label: string) {
  if (state === 'accepted') return <Pill tone="neutral">{label}</Pill>;
  const severity =
    state === 'delivered'
      ? 'success'
      : state === 'bounced'
        ? 'danger'
        : state === 'complained'
          ? 'warning'
          : 'info';
  return <Pill severity={severity}>{label}</Pill>;
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? '';
}

// ── Tab strip + status filter ───────────────────────────────────────────────
function TabStrip({
  activeTab,
  dlqCount,
  showSystemTab,
}: {
  activeTab: JobsTab;
  dlqCount: number;
  showSystemTab: boolean;
}) {
  const t = useTranslations('settings');
  const tabs: { tab: JobsTab; label: string; badge?: number }[] = [
    { tab: 'runs', label: t('jobs.tab.runs') },
    { tab: 'dlq', label: t('jobs.tab.dlq'), badge: dlqCount },
  ];
  if (showSystemTab) tabs.push({ tab: 'system', label: t('jobs.tab.system') });

  return (
    <nav aria-label={t('jobs.tabNavLabel')} className="flex gap-1 border-b border-(--el-border)">
      {tabs.map(({ tab, label, badge }) => {
        const active = tab === activeTab;
        return (
          <Link
            key={tab}
            href={buildHref({ tab })}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 px-3 py-2 font-sans text-sm font-medium',
              '-mb-px border-b-2 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              active
                ? 'border-(--el-accent) text-(--el-text)'
                : 'border-transparent text-(--el-text-muted) hover:text-(--el-text)',
            )}
          >
            {label}
            {badge && badge > 0 ? (
              <Pill tone="neutral" aria-label={t('jobs.dlqBadgeLabel', { count: badge })}>
                {badge}
              </Pill>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function StatusFilter({ activeTab, status }: { activeTab: JobsTab; status?: JobRunStatus }) {
  const t = useTranslations('settings');
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t('jobs.filterGroupLabel')}
    >
      {STATUS_FILTER_VALUES.map((value) => {
        const active = value === 'all' ? !status : status === value;
        return (
          <Link
            key={value}
            href={buildHref({ tab: activeTab, status: value })}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded-(--radius-badge) border px-2.5 py-0.5 font-sans text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              active
                ? 'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-text-strong)'
                : 'border-(--el-border) text-(--el-text-secondary) hover:bg-(--el-surface)',
            )}
          >
            {t(`jobs.filter.${value}`)}
          </Link>
        );
      })}
    </div>
  );
}

// ── Detail dialog ───────────────────────────────────────────────────────────
function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[40vh] overflow-auto rounded-(--radius-control) bg-(--el-surface) p-3 font-mono text-xs text-(--el-text)">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────────
function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-sans text-xs font-semibold text-(--el-text-muted)',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td className={cn('px-3 py-2 align-middle font-sans text-sm text-(--el-text)', className)}>
      {children}
    </td>
  );
}

function TableShell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-(--radius-card) border border-(--el-border)">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function RunsTable({ runs }: { runs: JobRunDTO[] }) {
  const t = useTranslations('settings');
  const locale = useLocale() as Locale;
  const [detail, setDetail] = useState<JobRunDTO | null>(null);
  return (
    <>
      <TableShell caption={t('jobs.runsTableCaption')}>
        <thead className="border-b border-(--el-border) bg-(--el-surface)">
          <tr>
            <Th>{t('jobs.col.status')}</Th>
            <Th>{t('jobs.col.delivery')}</Th>
            <Th>{t('jobs.col.function')}</Th>
            <Th>{t('jobs.col.event')}</Th>
            <Th className="text-right">{t('jobs.col.attempts')}</Th>
            <Th>{t('jobs.col.started')}</Th>
            <Th className="text-right">{t('jobs.col.duration')}</Th>
            <Th>{t('jobs.col.failure')}</Th>
            <Th className="text-right">{t('jobs.col.details')}</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              className="border-b border-(--el-border) last:border-0 hover:bg-(--el-surface)"
            >
              <Td>
                <Pill severity={statusSeverity(run.status)}>{run.status}</Pill>
              </Td>
              <Td className="text-(--el-text-secondary)">
                {/* The em-dash this table already uses in Failure and Duration,
                    so a row this column does not apply to costs a reader
                    nothing. `--el-text-secondary`, not `-muted`: the row can sit
                    on the hover surface, where muted fails AA. */}
                {run.delivery
                  ? deliveryPill(run.delivery.state, t(`jobs.delivery.${run.delivery.state}`))
                  : '—'}
              </Td>
              <Td className="font-mono text-xs">{run.functionId}</Td>
              <Td className="font-mono text-xs">{run.eventName}</Td>
              <Td className="text-right tabular-nums">{run.attempt}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(run.startedAt, locale)}</Td>
              <Td className="text-right tabular-nums">{formatDuration(run.durationMs)}</Td>
              <Td className="max-w-[16rem] truncate text-(--el-text-secondary)">
                {run.failure ? firstLine(run.failure.message) : '—'}
              </Td>
              <Td className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setDetail(run)}>
                  {t('jobs.view')}
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title={t('jobs.runDetailTitle')}
        size="lg"
      >
        {detail ? (
          <div className="flex flex-col gap-4">
            <DeliveryDetail delivery={detail.delivery} />
            <JsonBlock value={detail} />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/**
 * The named delivery block the run detail gains (MOTIR-3517).
 *
 * It sits ABOVE the JSON dump rather than inside it because the one thing an
 * operator needs from this modal is something they can paste into the
 * provider's own dashboard: the message id. Telling them a message bounced and
 * leaving them to find its handle in a JSON blob is most of the way to telling
 * them nothing.
 */
export function DeliveryDetail({ delivery }: { delivery: JobRunDTO['delivery'] }) {
  const t = useTranslations('settings');
  const locale = useLocale() as Locale;
  if (delivery === null) {
    return <p className="font-sans text-sm text-(--el-text-secondary)">{t('jobs.deliveryNone')}</p>;
  }
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{t('jobs.deliveryDetail.heading')}</SectionLabel>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 font-sans text-sm">
        <dt className="text-(--el-text-secondary)">{t('jobs.deliveryDetail.state')}</dt>
        <dd>{deliveryPill(delivery.state, t(`jobs.delivery.${delivery.state}`))}</dd>

        <dt className="text-(--el-text-secondary)">{t('jobs.deliveryDetail.messageId')}</dt>
        <dd className="font-mono text-xs break-all">{delivery.providerMessageId ?? '—'}</dd>

        <dt className="text-(--el-text-secondary)">{t('jobs.deliveryDetail.recipient')}</dt>
        <dd className="font-mono text-xs break-all">{delivery.recipient}</dd>

        <dt className="text-(--el-text-secondary)">{t('jobs.deliveryDetail.template')}</dt>
        <dd className="font-mono text-xs">{delivery.template}</dd>

        <dt className="text-(--el-text-secondary)">{t('jobs.deliveryDetail.lastEvent')}</dt>
        <dd>
          {delivery.lastEventAt
            ? formatDateTime(delivery.lastEventAt, locale)
            : t('jobs.deliveryDetail.never')}
        </dd>
      </dl>
    </section>
  );
}

function DlqTable({ rows, isOwner }: { rows: JobRunDlqDTO[]; isOwner: boolean }) {
  const t = useTranslations('settings');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { toast } = useToast();
  const [detail, setDetail] = useState<JobRunDlqDTO | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleReplay(id: string) {
    setReplayingId(id);
    startTransition(async () => {
      const result = await replayDlqAction(id);
      setReplayingId(null);
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('jobs.replayedToastTitle'),
          description: t('jobs.replayedToastDesc'),
        });
        router.refresh();
      } else {
        toast({ variant: 'error', title: t('jobs.replayErrorTitle'), description: result.error });
      }
    });
  }

  return (
    <>
      <TableShell caption={t('jobs.dlqTableCaption')}>
        <thead className="border-b border-(--el-border) bg-(--el-surface)">
          <tr>
            <Th>{t('jobs.col.function')}</Th>
            <Th>{t('jobs.col.event')}</Th>
            <Th className="text-right">{t('jobs.col.attempts')}</Th>
            <Th>{t('jobs.col.firstFailed')}</Th>
            <Th>{t('jobs.col.lastFailed')}</Th>
            <Th>{t('jobs.col.replayed')}</Th>
            <Th className="text-right">{t('jobs.col.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const replaying = replayingId === row.id;
            const replayBtn = (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                loading={replaying}
                disabled={!isOwner}
                onClick={() => handleReplay(row.id)}
              >
                {t('jobs.replay')}
              </Button>
            );
            return (
              <tr
                key={row.id}
                className="border-b border-(--el-border) last:border-0 hover:bg-(--el-surface)"
              >
                <Td className="font-mono text-xs">{row.functionId}</Td>
                <Td className="font-mono text-xs">{row.eventName}</Td>
                <Td className="text-right tabular-nums">{row.attempts}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(row.firstFailedAt, locale)}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(row.lastFailedAt, locale)}</Td>
                <Td className="whitespace-nowrap text-(--el-text-secondary)">
                  {row.replayedAt ? formatDateTime(row.replayedAt, locale) : '—'}
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
                      {t('jobs.view')}
                    </Button>
                    {isOwner ? (
                      replayBtn
                    ) : (
                      <Tooltip content={t('jobs.replayTooltip')} side="left">
                        {/* Wrap the disabled button so the tooltip still fires on
                            hover/focus of the surrounding span. */}
                        <span className="inline-flex">{replayBtn}</span>
                      </Tooltip>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableShell>

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title={t('jobs.dlqDetailTitle')}
        description={t('jobs.dlqDetailDesc')}
        size="lg"
      >
        {detail ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="mb-1 font-sans text-sm font-semibold text-(--el-text)">
                {t('jobs.failureHeading')}
              </h3>
              <JsonBlock value={detail.failure} />
            </div>
            <div>
              <h3 className="mb-1 font-sans text-sm font-semibold text-(--el-text)">
                {t('jobs.eventPayloadHeading')}
              </h3>
              <JsonBlock value={detail.eventData} />
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ── Pagination ──────────────────────────────────────────────────────────────
function Pagination({
  activeTab,
  status,
  page,
  hasNext,
}: {
  activeTab: JobsTab;
  status?: JobRunStatus;
  page: number;
  hasNext: boolean;
}) {
  const t = useTranslations('settings');
  if (page <= 1 && !hasNext) return null;
  return (
    <div className="flex items-center justify-between font-sans text-sm">
      <span className="text-(--el-text-muted)">{t('jobs.pageLabel', { page })}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={buildHref({ tab: activeTab, status, page: page - 1 })}>
            <Button variant="secondary" size="sm">
              {t('jobs.previous')}
            </Button>
          </Link>
        ) : null}
        {hasNext ? (
          <Link href={buildHref({ tab: activeTab, status, page: page + 1 })}>
            <Button variant="secondary" size="sm">
              {t('jobs.next')}
            </Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function JobsDashboard(props: JobsDashboardProps) {
  const { activeTab, status, page, hasNext, dlqCount, isOwner, showSystemTab, runs, dlq } = props;
  const t = useTranslations('settings');
  const router = useRouter();
  const isDlq = activeTab === 'dlq';

  return (
    <div className="flex flex-col gap-4">
      <TabStrip activeTab={activeTab} dlqCount={dlqCount} showSystemTab={showSystemTab} />

      <div className="flex items-center justify-between gap-3">
        {isDlq ? <div /> : <StatusFilter activeTab={activeTab} status={status} />}
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => router.refresh()}
        >
          {t('jobs.refresh')}
        </Button>
      </div>

      {isDlq ? (
        dlq.length === 0 ? (
          <EmptyState title={t('jobs.dlqEmptyTitle')} description={t('jobs.dlqEmptyDesc')} />
        ) : (
          <DlqTable rows={dlq} isOwner={isOwner} />
        )
      ) : runs.length === 0 ? (
        <EmptyState title={t('jobs.runsEmptyTitle')} description={t('jobs.runsEmptyDesc')} />
      ) : (
        <RunsTable runs={runs} />
      )}

      <Pagination activeTab={activeTab} status={status} page={page} hasNext={hasNext} />
    </div>
  );
}
