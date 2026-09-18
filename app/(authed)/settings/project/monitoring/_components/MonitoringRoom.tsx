'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Activity,
  Bug,
  CircleAlert,
  CircleCheckBig,
  Info,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
import { isMonitorLevel, MONITOR_LEVELS } from '@/lib/monitors/levels';
import type { MonitorBannerTone, MonitoringBannerCopy } from '@/lib/monitors/returnBanner';
import { monitorConnectHref } from '@/lib/monitors/returnSurface';
import { recheckMonitorHealthAction } from '../actions';
import { MonitoringProjectPicker } from './MonitoringProjectPicker';

// The Monitoring room's CLIENT island (Story MOTIR-4928 · MOTIR-5262).
//
// ⚠️ IT KEEPS NO COPY OF THE VIEW. Everything below renders straight from props,
// so the server read re-runs on `router.refresh()` and this re-renders with it —
// after Re-check, after Disconnect, and after the picker (MOTIR-5297) binds a
// project — the picker is handed `router.refresh()` as its `onBound`. Local state holds only what is genuinely local: which confirmation is
// open, whether a request is in flight, and whether the return banner was
// dismissed.

export interface MonitoringRoomProps {
  projectKey: string;
  view: MonitorConnectionViewDto;
  banner: MonitoringBannerCopy | null;
  /** "checked N minutes ago", formatted on the server; null when never checked. */
  checkedLabel: string | null;
  /** "Bound N days ago" per connection id, formatted on the server. */
  boundLabels: Record<string, string>;
  /** Each row's poll line per connection id — DECIDED and FORMATTED on the
   *  server (MOTIR-5582): the overdue threshold is the reconciler's own
   *  constant, in a server-only module. A row with no entry shows none. */
  pollLines?: Record<string, PollLineView>;
  /** When each row's last FAILED resolve-back happened, formatted on the server
   *  like every other time here (Story MOTIR-4931 · MOTIR-5707). A row with no
   *  recorded failure has no entry. */
  syncErrorLabels?: Record<string, string>;
}

/**
 * One row's ingestion line, as the server decided it (`lib/monitors/pollLine.ts`)
 * — `design-notes.md` §12's state table, with every time already a string.
 */
export type PollLineView =
  | { kind: 'waiting' }
  | { kind: 'ok'; ago: string; filedCount: number }
  | { kind: 'overdue'; since: string }
  | { kind: 'failed'; reason: string; lastSuccess: string | null };

const BANNER_CLASS: Record<MonitorBannerTone, string> = {
  success: 'bg-(--el-success-surface) text-(--el-text-strong)',
  danger: 'bg-(--el-danger-surface) text-(--el-danger-surface-text)',
  info: 'bg-(--el-notice-info-bg) text-(--el-text-strong)',
};

const BANNER_ICON: Record<MonitorBannerTone, typeof Info> = {
  success: CircleCheckBig,
  danger: CircleAlert,
  info: Info,
};

const BANNER_ICON_CLASS: Record<MonitorBannerTone, string> = {
  success: 'text-(--el-success)',
  danger: 'text-(--el-danger)',
  info: 'text-(--el-info)',
};

export function MonitoringRoom({
  projectKey,
  view,
  banner,
  checkedLabel,
  boundLabels,
  pollLines = {},
  syncErrorLabels = {},
}: MonitoringRoomProps) {
  const t = useTranslations('monitoring');
  const router = useRouter();
  const { toast } = useToast();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [removing, setRemoving] = useState<MonitorConnectionDto | null>(null);
  const [busy, setBusy] = useState<'recheck' | 'disconnect' | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const connectHref = monitorConnectHref(projectKey);
  const degraded = view.health === 'degraded';
  const org = view.orgSlug ?? t('grant.unknownOrg');

  async function recheck() {
    setBusy('recheck');
    try {
      const result = await recheckMonitorHealthAction();
      if (!result.ok) toast({ variant: 'error', title: t('recheckFailed') });
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('recheckFailed') });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(connection: MonitorConnectionDto) {
    setBusy('disconnect');
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/monitors/${encodeURIComponent(connection.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        toast({ variant: 'error', title: t('disconnectFailed') });
        return;
      }
      setRemoving(null);
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('disconnectFailed') });
    } finally {
      setBusy(null);
    }
  }

  const bannerNode =
    banner && !bannerDismissed ? (
      <ReturnBanner
        banner={banner}
        dismissLabel={t('banner.dismiss')}
        onDismiss={() => setBannerDismissed(true)}
      />
    ) : null;

  // PANEL 1 — no grant at all.
  if (!view.installationId) {
    return (
      <div className="flex flex-col gap-4">
        {bannerNode}
        <EmptyState
          icon={<Activity className="size-6" aria-hidden="true" />}
          title={t('empty.title')}
          description={t('empty.body')}
          action={
            <a href={connectHref} className={buttonVariants({ variant: 'primary' })}>
              {t('empty.action')}
            </a>
          }
        />
      </div>
    );
  }

  const others = removing ? view.connections.filter((c) => c.id !== removing.id) : [];
  const removingLast = removing !== null && others.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {bannerNode}

      {/* THE GRANT — above the rows, because the health belongs to it (§1.2). */}
      <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid size-[34px] flex-none place-items-center rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) text-(--el-icon-muted)">
            <Activity className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
              {t('grant.provider')}
              <HealthChip
                degraded={degraded}
                label={t(degraded ? 'health.degraded' : 'health.connected')}
              />
            </span>
            <span className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
              <span className="font-mono">{org}</span>
              {checkedLabel ? (
                <>
                  <span aria-hidden="true">·</span>
                  {checkedLabel}
                </>
              ) : null}
            </span>
          </span>
          <span className="flex flex-none items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'recheck'}
              disabled={busy !== null}
              leftIcon={<RefreshCw className="size-3.5" aria-hidden="true" />}
              onClick={() => void recheck()}
            >
              {t('grant.recheck')}
            </Button>
            {degraded ? (
              <a href={connectHref} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                {t('grant.reconnect')}
              </a>
            ) : null}
          </span>
        </div>
        {degraded ? (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-warning-surface) px-3.5 py-3 font-sans text-sm text-(--el-warning-text)"
          >
            <TriangleAlert
              className="mt-0.5 size-4 flex-none text-(--el-warning)"
              aria-hidden="true"
            />
            <span>
              <b className="font-semibold">{t('degraded.says')}</b>{' '}
              {view.healthReason ? `${view.healthReason} ` : null}
              {t('degraded.consequence')}
            </span>
          </div>
        ) : null}
      </div>

      {/* THE MONITORED PROJECTS. */}
      <section className="flex flex-col gap-3">
        <SectionLabel label={t('section.label')} />
        {view.connections.length === 0 ? (
          // PANEL 1b — connected, nothing monitored: the state every connect lands in.
          <div className="flex flex-wrap items-center gap-3.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)">
            <span className="grid size-[38px] flex-none place-items-center rounded-full bg-(--el-surface-soft) text-(--el-icon-muted)">
              <Bug className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('unbound.title')}
              </h2>
              <p className="mt-[3px] font-sans text-[13px] leading-relaxed text-(--el-text-secondary)">
                {t('unbound.body', { org })}
              </p>
            </span>
            <Button variant="primary" size="sm" onClick={() => setPickerOpen(true)}>
              {t('unbound.action')}
            </Button>
          </div>
        ) : (
          <>
            <p className="max-w-[68ch] font-sans text-[13px] leading-relaxed text-(--el-text-secondary)">
              {t(degraded ? 'section.hintDegraded' : 'section.hint')}
            </p>
            <ul className="flex flex-col gap-2">
              {view.connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  projectKey={projectKey}
                  connection={connection}
                  boundLabel={boundLabels[connection.id]}
                  pollLine={pollLines[connection.id] ?? null}
                  syncErrorWhen={syncErrorLabels[connection.id] ?? null}
                  roomBusy={busy !== null}
                  onDisconnect={() => setRemoving(connection)}
                  onSaved={() => router.refresh()}
                />
              ))}
            </ul>
            <div>
              <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
                {t('section.add')}
              </Button>
            </div>
          </>
        )}
      </section>

      {/* PANELS 6–7 — the picker, opened by both Choose buttons. */}
      <MonitoringProjectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectKey={projectKey}
        org={org}
        connectHref={connectHref}
        onBound={() => router.refresh()}
      />

      {/* PANEL 8 — the confirmation says what disconnect DOES, in its two cases. */}
      <Modal
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setRemoving(null);
        }}
        role="alertdialog"
        title={
          removing
            ? removingLast
              ? t('confirm.last.title')
              : t('confirm.one.title', { slug: removing.externalProjectSlug })
            : ''
        }
      >
        {/* The body names every project that stays monitored, and a project can
            hold many — so it scrolls in Modal.Body and the footer stays pinned. */}
        <Modal.Body>
          <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
            {removing
              ? removingLast
                ? t.rich('confirm.last.body', {
                    slug: removing.externalProjectSlug,
                    org,
                    b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
                  })
                : t.rich('confirm.one.body', {
                    slug: removing.externalProjectSlug,
                    others: others.map((c) => c.externalProjectSlug).join(', '),
                    count: others.length,
                    b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
                  })
              : null}
          </p>
        </Modal.Body>
        <Modal.Footer className="shrink-0">
          <Button
            variant="ghost"
            size="md"
            disabled={busy !== null}
            onClick={() => setRemoving(null)}
          >
            {t('confirm.cancel')}
          </Button>
          <Button
            variant="danger"
            size="md"
            loading={busy === 'disconnect'}
            onClick={() => removing && void disconnect(removing)}
          >
            {removingLast ? t('confirm.last.action') : t('confirm.one.action')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

/** The level control's value for "every level" — the stored `null`. */
const EVERY_LEVEL = 'every';
type LevelValue = typeof EVERY_LEVEL | (typeof MONITOR_LEVELS)[number];

/**
 * ONE monitored project (MOTIR-5582, `design-notes.md` §12): the slug, the
 * `Bound …` line, the poll line beneath it, the minimum-level control, and the
 * disconnect action.
 *
 * ⚠️ PAGE STATE AFTER THE LEVEL WRITE. The control's own value is the edited
 * field's cell, so it shows the WRITE'S RESPONSE the moment it resolves rather
 * than waiting on a refresh; the row is then refreshed through `router.refresh()`
 * — the room's one refresh mechanism, the picker's `onBound` — so the server's
 * read and this cell agree. A refused write keeps the stored value and says so
 * on the row, never across the room.
 */
function ConnectionRow({
  projectKey,
  connection,
  boundLabel,
  pollLine,
  syncErrorWhen,
  roomBusy,
  onDisconnect,
  onSaved,
}: {
  projectKey: string;
  connection: MonitorConnectionDto;
  boundLabel: string | undefined;
  pollLine: PollLineView | null;
  syncErrorWhen: string | null;
  roomBusy: boolean;
  onDisconnect: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('monitoring');
  const [saving, setSaving] = useState(false);
  const [syncSaving, setSyncSaving] = useState(false);
  const [refused, setRefused] = useState(false);
  // The write's answer, keyed to the stored value it replaced, so a later
  // refresh that brings a DIFFERENT stored value (another person's change) wins.
  const [saved, setSaved] = useState<{ base: string | null; value: string | null } | null>(null);
  const stored =
    saved && saved.base === connection.minimumLevel ? saved.value : connection.minimumLevel;

  const options: ComboboxOption<LevelValue>[] = [
    { value: EVERY_LEVEL, label: t('row.level.every') },
    ...MONITOR_LEVELS.map((level) => ({ value: level, label: level })),
  ];

  async function choose(value: LevelValue) {
    const minimumLevel = value === EVERY_LEVEL ? null : value;
    if (minimumLevel === stored) return;
    setSaving(true);
    setRefused(false);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/monitors/${encodeURIComponent(connection.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ minimumLevel }),
        },
      );
      if (!res.ok) {
        setRefused(true);
        return;
      }
      const dto = (await res.json()) as MonitorConnectionDto;
      setSaved({ base: connection.minimumLevel, value: dto.minimumLevel });
      onSaved();
    } catch {
      setRefused(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Bug className="size-[18px] flex-none text-(--el-icon-muted)" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="font-mono text-sm font-semibold text-(--el-text)">
            {connection.externalProjectSlug}
          </span>
          <span className="font-sans text-xs text-(--el-text-secondary)">{boundLabel}</span>
          {pollLine ? <PollLine line={pollLine} /> : null}
        </span>
        <span className="flex flex-none items-center gap-2">
          <span className="font-sans text-xs text-(--el-text-secondary)" aria-hidden="true">
            {t('row.level.label')}
          </span>
          <Combobox<LevelValue>
            label={t('row.level.label')}
            options={options}
            // A stored value outside the vocabulary filters nothing (`meetsMinimumLevel`),
            // so it reads as what it does: every level.
            value={saving ? null : stored !== null && isMonitorLevel(stored) ? stored : EVERY_LEVEL}
            placeholder={t('row.level.saving')}
            disabled={saving || roomBusy}
            onChange={(value) => void choose(value)}
            footer={t('row.level.helper')}
            className="min-w-[9rem]"
          />
        </span>
        <button
          type="button"
          aria-label={t('row.disconnect', { slug: connection.externalProjectSlug })}
          disabled={roomBusy || saving || syncSaving}
          onClick={onDisconnect}
          className="inline-flex size-(--height-control) flex-none items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:bg-(--el-surface) hover:text-(--el-text) disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
      {refused ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2 font-sans text-xs text-(--el-warning-text)"
        >
          <TriangleAlert
            className="mt-px size-3.5 flex-none text-(--el-warning)"
            aria-hidden="true"
          />
          <span>
            {t.rich('row.level.failed', {
              b: (chunks) => <b className="font-semibold">{chunks}</b>,
            })}
          </span>
        </p>
      ) : null}
      <SyncBand
        projectKey={projectKey}
        connection={connection}
        syncErrorWhen={syncErrorWhen}
        onPendingChange={setSyncSaving}
        onSaved={onSaved}
      />
    </li>
  );
}

type SyncKey = 'resolveOnDone' | 'syncAssignee';

/**
 * The row's SYNC band (Story MOTIR-4931 · MOTIR-5707; `design-notes.md` §13) —
 * the two per-connection direction switches, under the row's top line, and the
 * connection's last FAILED resolve-back directly under the switch it belongs to.
 *
 * - WRITE ON TOGGLE, one key at a time: the switch moves at once, is disabled
 *   with "Saving…" after its label while the PATCH is in flight, and then shows
 *   the response DTO's value. The OTHER switch stays operable — the writes are
 *   independent keys (§13 decision 5).
 * - A refused write returns the switch to the stored value and shows the
 *   failed-save line under the band. It never turns the grant degraded.
 * - OPERABLE on a degraded grant: a switch is a Motir-side preference and makes
 *   no provider call (§13 decision 4), so nothing here reads the grant's health.
 * - The failure line renders only while `lastSyncError` is set; "never resolved"
 *   and "last resolve succeeded" both render nothing (§13 decision 3). The
 *   provider's reason is shown verbatim — never worded or summarised here.
 */
function SyncBand({
  projectKey,
  connection,
  syncErrorWhen,
  onPendingChange,
  onSaved,
}: {
  projectKey: string;
  connection: MonitorConnectionDto;
  syncErrorWhen: string | null;
  onPendingChange: (pending: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations('monitoring');
  // The value the switch shows while its write is in flight, per key.
  const [pending, setPending] = useState<Partial<Record<SyncKey, boolean>>>({});
  // The write's answer, keyed to the stored value it replaced — the level
  // control's rule: a later refresh bringing a DIFFERENT stored value wins.
  const [saved, setSaved] = useState<Partial<Record<SyncKey, { base: boolean; value: boolean }>>>(
    {},
  );
  const [refused, setRefused] = useState(false);
  // The row's Disconnect is disabled while either switch is saving (§13 decision 5).
  const anyPending = Object.keys(pending).length > 0;
  useEffect(() => onPendingChange(anyPending), [anyPending, onPendingChange]);

  const shown = (key: SyncKey): boolean => {
    const inFlight = pending[key];
    if (inFlight !== undefined) return inFlight;
    const answer = saved[key];
    return answer && answer.base === connection[key] ? answer.value : connection[key];
  };

  async function toggle(key: SyncKey, next: boolean) {
    setPending((current) => ({ ...current, [key]: next }));
    setRefused(false);
    const settle = () =>
      setPending((current) => {
        const rest = { ...current };
        delete rest[key];
        return rest;
      });
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/monitors/${encodeURIComponent(connection.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          // SPARSE: only the key that changed (MOTIR-5706's PATCH).
          body: JSON.stringify({ [key]: next }),
        },
      );
      if (!res.ok) {
        setRefused(true);
        return;
      }
      const dto = (await res.json()) as MonitorConnectionDto;
      setSaved((current) => ({ ...current, [key]: { base: connection[key], value: dto[key] } }));
      onSaved();
    } catch {
      setRefused(true);
    } finally {
      settle();
    }
  }

  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  const items: { key: SyncKey; copy: 'resolve' | 'assignee' }[] = [
    { key: 'resolveOnDone', copy: 'resolve' },
    { key: 'syncAssignee', copy: 'assignee' },
  ];

  return (
    <div
      className="ml-[30px] flex flex-col gap-2.5 border-t border-(--el-border-soft) pt-2.5"
      data-testid="monitor-sync-band"
    >
      <span className="font-sans text-xs text-(--el-text-secondary)">{t('row.sync.label')}</span>
      {items.map(({ key, copy }) => {
        const labelId = `sync-${connection.id}-${key}`;
        const inFlight = pending[key] !== undefined;
        return (
          <div key={key} className="flex items-start gap-2.5">
            <Switch
              checked={shown(key)}
              onCheckedChange={(next) => void toggle(key, next)}
              disabled={inFlight}
              aria-labelledby={labelId}
              className="mt-px"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 font-sans text-[13px] font-medium text-(--el-text)">
                <span id={labelId}>{t(`row.sync.${copy}.label`)}</span>
                {inFlight ? (
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-(--el-text-secondary)">
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                    {t('row.sync.saving')}
                  </span>
                ) : null}
              </span>
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t(`row.sync.${copy}.hint`)}
              </span>
              {key === 'resolveOnDone' && connection.lastSyncError !== null ? (
                <span
                  data-testid="monitor-sync-failure"
                  className="mt-1 flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-2.5 py-1.5 font-sans text-xs text-(--el-warning-text)"
                >
                  <TriangleAlert
                    className="mt-px size-3.5 flex-none text-(--el-warning)"
                    aria-hidden="true"
                  />
                  <span>
                    {t.rich('row.sync.resolveFailed', {
                      key: connection.lastSyncErrorWorkItemIdentifier ?? '—',
                      reason: connection.lastSyncError,
                      b,
                      link: (chunks) =>
                        connection.lastSyncErrorWorkItemIdentifier ? (
                          <Link
                            href={`/items/${encodeURIComponent(connection.lastSyncErrorWorkItemIdentifier)}`}
                            className="font-mono text-(--el-link) underline-offset-2 hover:underline"
                          >
                            {chunks}
                          </Link>
                        ) : (
                          chunks
                        ),
                    })}
                    {syncErrorWhen ? (
                      <> {t('row.sync.resolveFailedWhen', { when: syncErrorWhen })}</>
                    ) : null}
                  </span>
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
      {refused ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-3 py-2 font-sans text-xs text-(--el-warning-text)"
        >
          <TriangleAlert
            className="mt-px size-3.5 flex-none text-(--el-warning)"
            aria-hidden="true"
          />
          <span>{t.rich('row.sync.failed', { b })}</span>
        </p>
      ) : null}
    </div>
  );
}

/** The poll line beneath `Bound …` — quiet for waiting / recent ok, a filled
 *  warning line for overdue / failed (§12). The failure reason is the stored
 *  string, rendered verbatim: this component never words or summarises it. */
function PollLine({ line }: { line: PollLineView }) {
  const t = useTranslations('monitoring');
  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

  if (line.kind === 'waiting' || line.kind === 'ok') {
    return (
      <span className="font-sans text-xs text-(--el-text-secondary)" data-poll-state={line.kind}>
        {line.kind === 'waiting' ? t('row.poll.waiting') : t('row.poll.ok', { ago: line.ago })}
        {line.kind === 'ok' && line.filedCount > 0 ? (
          <>
            {' · '}
            <span className="text-(--el-text-strong)">
              {t.rich('row.poll.filed', { count: line.filedCount, b })}
            </span>
          </>
        ) : null}
      </span>
    );
  }

  return (
    <span
      data-poll-state={line.kind}
      className="mt-1 flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-2.5 py-1.5 font-sans text-xs text-(--el-warning-text)"
    >
      <TriangleAlert className="mt-px size-3.5 flex-none text-(--el-warning)" aria-hidden="true" />
      <span>
        {line.kind === 'overdue' ? (
          t.rich('row.poll.overdue', { since: line.since, b })
        ) : (
          <>
            {t.rich('row.poll.failed', { reason: line.reason, b })}
            {line.lastSuccess ? (
              <> {t('row.poll.lastSuccess', { when: line.lastSuccess })}</>
            ) : null}
          </>
        )}
      </span>
    </span>
  );
}

/** The grant's health chip — a FILLED token per value, never a border style (§4). */
function HealthChip({ degraded, label }: { degraded: boolean; label: string }) {
  const Icon = degraded ? TriangleAlert : CircleCheckBig;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium ${
        degraded
          ? 'bg-(--el-warning-surface) text-(--el-warning-text)'
          : 'bg-(--el-success-surface) text-(--el-text-strong)'
      }`}
    >
      <Icon
        className={`size-3.5 ${degraded ? 'text-(--el-warning)' : 'text-(--el-success)'}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/** Panel 10 — above the grant, dismissible, never replacing the room under it. */
function ReturnBanner({
  banner,
  dismissLabel,
  onDismiss,
}: {
  banner: MonitoringBannerCopy;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  const Icon = BANNER_ICON[banner.tone];
  return (
    <div
      role={banner.tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-3 font-sans text-sm ${BANNER_CLASS[banner.tone]}`}
    >
      <Icon
        className={`mt-0.5 size-4 flex-none ${BANNER_ICON_CLASS[banner.tone]}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{banner.title}</b> {banner.body}
      </span>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="inline-flex size-6 flex-none items-center justify-center rounded-(--radius-control) opacity-70 hover:opacity-100"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
