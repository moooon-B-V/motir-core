'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Activity,
  Bug,
  CircleAlert,
  CircleCheckBig,
  Info,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { useToast } from '@/components/ui/Toast';
import type { MonitorConnectionDto, MonitorConnectionViewDto } from '@/lib/dto/monitors';
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
}

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
                <li
                  key={connection.id}
                  className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) px-3.5 py-3"
                >
                  <Bug
                    className="size-[18px] flex-none text-(--el-icon-muted)"
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="font-mono text-sm font-semibold text-(--el-text)">
                      {connection.externalProjectSlug}
                    </span>
                    <span className="font-sans text-xs text-(--el-text-secondary)">
                      {boundLabels[connection.id]}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={t('row.disconnect', { slug: connection.externalProjectSlug })}
                    disabled={busy !== null}
                    onClick={() => setRemoving(connection)}
                    className="inline-flex size-(--height-control) flex-none items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:bg-(--el-surface) hover:text-(--el-text) disabled:opacity-50"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </li>
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
