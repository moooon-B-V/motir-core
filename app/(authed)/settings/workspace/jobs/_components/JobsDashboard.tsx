'use client';

import { useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { JobRunDTO, JobRunDlqDTO, JobRunStatus } from '@/lib/dto/jobs';
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

const STATUS_FILTERS: { label: string; value: JobRunStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Succeeded', value: 'succeeded' },
  { label: 'Failed', value: 'failed' },
  { label: 'Running', value: 'running' },
];

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
function formatDateTime(iso: string): string {
  // Stable, locale-aware short form. The Date is from a server ISO string, so
  // there's no Date.now() involved (which the workflow env forbids).
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
  const tabs: { tab: JobsTab; label: string; badge?: number }[] = [
    { tab: 'runs', label: 'Recent runs' },
    { tab: 'dlq', label: 'Dead letter', badge: dlqCount },
  ];
  if (showSystemTab) tabs.push({ tab: 'system', label: 'System' });

  return (
    <nav aria-label="Job run views" className="flex gap-1 border-b border-(--color-hairline)">
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
                ? 'border-(--color-primary) text-foreground'
                : 'border-transparent text-(--color-muted-foreground) hover:text-foreground',
            )}
          >
            {label}
            {badge && badge > 0 ? (
              <Pill tone="neutral" aria-label={`${badge} in dead-letter queue`}>
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
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
      {STATUS_FILTERS.map(({ label, value }) => {
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
                ? 'border-(--color-primary) bg-(--color-tint-lavender) text-(--color-charcoal)'
                : 'border-(--color-hairline) text-(--color-slate) hover:bg-(--color-surface)',
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

// ── Detail dialog ───────────────────────────────────────────────────────────
function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-[40vh] overflow-auto rounded-(--radius-sm) bg-(--color-surface) p-3 font-mono text-xs text-foreground">
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
        'px-3 py-2 text-left font-sans text-xs font-semibold text-(--color-muted-foreground)',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td className={cn('px-3 py-2 align-middle font-sans text-sm text-foreground', className)}>
      {children}
    </td>
  );
}

function TableShell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-(--radius-card) border border-(--color-hairline)">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function RunsTable({ runs }: { runs: JobRunDTO[] }) {
  const [detail, setDetail] = useState<JobRunDTO | null>(null);
  return (
    <>
      <TableShell caption="Background job runs">
        <thead className="border-b border-(--color-hairline) bg-(--color-surface)">
          <tr>
            <Th>Status</Th>
            <Th>Function</Th>
            <Th>Event</Th>
            <Th className="text-right">Attempts</Th>
            <Th>Started</Th>
            <Th className="text-right">Duration</Th>
            <Th>Failure</Th>
            <Th className="text-right">Details</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              className="border-b border-(--color-hairline) last:border-0 hover:bg-(--color-surface)"
            >
              <Td>
                <Pill severity={statusSeverity(run.status)}>{run.status}</Pill>
              </Td>
              <Td className="font-mono text-xs">{run.functionId}</Td>
              <Td className="font-mono text-xs">{run.eventName}</Td>
              <Td className="text-right tabular-nums">{run.attempt}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(run.startedAt)}</Td>
              <Td className="text-right tabular-nums">{formatDuration(run.durationMs)}</Td>
              <Td className="max-w-[16rem] truncate text-(--color-muted-foreground)">
                {run.failure ? firstLine(run.failure.message) : '—'}
              </Td>
              <Td className="text-right">
                <Button variant="ghost" size="sm" onClick={() => setDetail(run)}>
                  View
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title="Run detail"
        size="lg"
      >
        {detail ? <JsonBlock value={detail} /> : null}
      </Modal>
    </>
  );
}

function DlqTable({ rows, isOwner }: { rows: JobRunDlqDTO[]; isOwner: boolean }) {
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
          title: 'Job replayed',
          description: 'The original event was re-emitted.',
        });
        router.refresh();
      } else {
        toast({ variant: 'error', title: 'Could not replay', description: result.error });
      }
    });
  }

  return (
    <>
      <TableShell caption="Dead-letter queue">
        <thead className="border-b border-(--color-hairline) bg-(--color-surface)">
          <tr>
            <Th>Function</Th>
            <Th>Event</Th>
            <Th className="text-right">Attempts</Th>
            <Th>First failed</Th>
            <Th>Last failed</Th>
            <Th>Replayed</Th>
            <Th className="text-right">Actions</Th>
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
                Replay
              </Button>
            );
            return (
              <tr
                key={row.id}
                className="border-b border-(--color-hairline) last:border-0 hover:bg-(--color-surface)"
              >
                <Td className="font-mono text-xs">{row.functionId}</Td>
                <Td className="font-mono text-xs">{row.eventName}</Td>
                <Td className="text-right tabular-nums">{row.attempts}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(row.firstFailedAt)}</Td>
                <Td className="whitespace-nowrap">{formatDateTime(row.lastFailedAt)}</Td>
                <Td className="whitespace-nowrap text-(--color-muted-foreground)">
                  {row.replayedAt ? formatDateTime(row.replayedAt) : '—'}
                </Td>
                <Td>
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
                      View
                    </Button>
                    {isOwner ? (
                      replayBtn
                    ) : (
                      <Tooltip content="Only a workspace owner can replay jobs" side="left">
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
        title="Dead-letter detail"
        description="The failure and the original event payload (replayable as-is)."
        size="lg"
      >
        {detail ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="mb-1 font-sans text-sm font-semibold text-foreground">Failure</h3>
              <JsonBlock value={detail.failure} />
            </div>
            <div>
              <h3 className="mb-1 font-sans text-sm font-semibold text-foreground">
                Event payload
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
  if (page <= 1 && !hasNext) return null;
  return (
    <div className="flex items-center justify-between font-sans text-sm">
      <span className="text-(--color-muted-foreground)">Page {page}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={buildHref({ tab: activeTab, status, page: page - 1 })}>
            <Button variant="secondary" size="sm">
              Previous
            </Button>
          </Link>
        ) : null}
        {hasNext ? (
          <Link href={buildHref({ tab: activeTab, status, page: page + 1 })}>
            <Button variant="secondary" size="sm">
              Next
            </Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function JobsDashboard(props: JobsDashboardProps) {
  const { activeTab, status, page, hasNext, dlqCount, isOwner, showSystemTab, runs, dlq } = props;
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
          Refresh
        </Button>
      </div>

      {isDlq ? (
        dlq.length === 0 ? (
          <EmptyState
            title="Nothing in the dead-letter queue"
            description="Every job has succeeded or is still retrying."
          />
        ) : (
          <DlqTable rows={dlq} isOwner={isOwner} />
        )
      ) : runs.length === 0 ? (
        <EmptyState
          title="No job runs yet"
          description="When a background job runs, it'll appear here."
        />
      ) : (
        <RunsTable runs={runs} />
      )}

      <Pagination activeTab={activeTab} status={status} page={page} hasNext={hasNext} />
    </div>
  );
}
