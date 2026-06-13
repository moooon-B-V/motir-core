'use client';

import { useRef, useState } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils/cn';
import type {
  NotificationEventPreferenceDto,
  NotificationPreferenceMatrixDto,
} from '@/lib/dto/notificationPreferences';
import type { NotificationChannel } from '@/lib/notifications/preferences';

// The per-user notification-preferences card on /settings/account (Story 5.7 ·
// Subtask 5.7.6). A matrix of event-type rows × channel columns (Email · In-app)
// of Switches; the disabled Story 5.4 "transitioned" row is drawn greyed with a
// "Soon" tag. Built against design/notifications/preferences.mock.html.
//
// Each toggle is an INLINE mutation: optimistic flip → PUT /api/notification-
// preferences → the cell trusts the RESPONSE (no router.refresh / revalidatePath
// whole-tree fan-out — the inline-edit-no-tree-refresh memory; the fan-out is
// what caused the revert bug). On failure the switch reverts to its prior
// position and an inline "Couldn't save · Retry" appears. Overlapping toggles
// are sequence-guarded so an older response never clobbers the newest state
// (the WatchControl `seq` pattern; the E2E-race contract).
//
// (Persists via the PUT route rather than a Server Action — the shipped inline-
// toggle convention, AutomationSettings.toggleEnabled, which also gives E2E a
// clean network signal to wait on.)

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; retry: () => void };

const SAVED_LINGER_MS = 1600;

export function NotificationPreferencesCard({
  initial,
}: {
  initial: NotificationPreferenceMatrixDto;
}) {
  const t = useTranslations('settings.account.notifications');
  const [events, setEvents] = useState<NotificationEventPreferenceDto[]>(initial.events);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });

  // Monotonic action stamp — a reconcile applies only when it is still latest.
  const seqRef = useRef(0);
  // Timer for the transient "Saved" badge (cleared if a newer action starts).
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setCell(eventType: string, channel: NotificationChannel, enabled: boolean) {
    setEvents((prev) =>
      prev.map((row) =>
        row.eventType === eventType
          ? { ...row, channels: { ...row.channels, [channel]: enabled } }
          : row,
      ),
    );
  }

  async function toggle(eventType: string, channel: NotificationChannel, prev: boolean) {
    const next = !prev;
    const seq = ++seqRef.current;
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);

    setCell(eventType, channel, next); // optimistic
    setStatus({ kind: 'saving' });

    try {
      const res = await fetch('/api/notification-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType, channel, enabled: next }),
      });
      if (!res.ok) throw new Error(`PUT failed: ${res.status}`);
      const { cell } = (await res.json()) as { cell: { enabled: boolean } };
      if (seq !== seqRef.current) return; // a newer toggle superseded this one
      setCell(eventType, channel, cell.enabled); // trust the response
      setStatus({ kind: 'saved' });
      savedTimerRef.current = setTimeout(() => {
        if (seq === seqRef.current) setStatus({ kind: 'idle' });
      }, SAVED_LINGER_MS);
    } catch {
      if (seq !== seqRef.current) return;
      setCell(eventType, channel, prev); // revert
      setStatus({ kind: 'error', retry: () => void toggle(eventType, channel, prev) });
    }
  }

  return (
    <Card
      header={
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('heading')}</h2>
            <p className="text-(--el-text-muted) mt-1 max-w-[28rem] font-sans text-sm">
              {t('helper')}
            </p>
          </div>
          <div className="ml-auto pt-0.5">
            <SaveIndicator status={status} t={t} />
          </div>
        </div>
      }
    >
      <div
        role="grid"
        aria-label={t('heading')}
        className="mt-2 grid grid-cols-[1fr_5rem_5rem] items-center"
      >
        {/* Column headers */}
        <div className="text-(--el-text-faint) border-(--el-border) border-b pb-3 font-sans text-[11px] font-semibold tracking-wide uppercase">
          {t('columns.event')}
        </div>
        <div className="text-(--el-text-faint) border-(--el-border) border-b pb-3 text-center font-sans text-[11px] font-semibold tracking-wide uppercase">
          {t('columns.email')}
        </div>
        <div className="text-(--el-text-faint) border-(--el-border) border-b pb-3 text-center font-sans text-[11px] font-semibold tracking-wide uppercase">
          {t('columns.inApp')}
        </div>

        {events.map((row) => (
          <EventRow key={row.eventType} row={row} t={t} onToggle={toggle} />
        ))}
      </div>

      <p className="text-(--el-text-muted) mt-4 flex items-start gap-2 font-sans text-xs leading-relaxed">
        <span aria-hidden className="bg-(--el-text-faint) mt-1.5 size-1 shrink-0 rounded-full" />
        <span>{t('defaultsNote')}</span>
      </p>
    </Card>
  );
}

function EventRow({
  row,
  t,
  onToggle,
}: {
  row: NotificationEventPreferenceDto;
  t: ReturnType<typeof useTranslations>;
  onToggle: (eventType: string, channel: NotificationChannel, prev: boolean) => void;
}) {
  const label = t(`events.${row.eventType}.label`);
  const desc = t(`events.${row.eventType}.desc`);
  return (
    <>
      <div className="border-(--el-border-soft) border-b py-3.5 pr-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-sans text-sm font-medium',
              row.settable ? 'text-(--el-text)' : 'text-(--el-text-faint)',
            )}
          >
            {label}
          </span>
          {!row.settable && (
            // The Story 5.4 seam tag — design-notes specifies the exact tokens
            // (lavender tint + --el-text-strong, --radius-badge), AA-safe.
            <span className="bg-(--el-tint-lavender) text-(--el-text-strong) rounded-(--radius-badge) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-sans text-[10px] font-semibold tracking-wide uppercase">
              {t('soon')}
            </span>
          )}
        </div>
        <p className="text-(--el-text-muted) mt-0.5 font-sans text-xs leading-snug">{desc}</p>
      </div>
      <NotificationCell row={row} channel="email" t={t} onToggle={onToggle} />
      <NotificationCell row={row} channel="in_app" t={t} onToggle={onToggle} />
    </>
  );
}

function NotificationCell({
  row,
  channel,
  t,
  onToggle,
}: {
  row: NotificationEventPreferenceDto;
  channel: NotificationChannel;
  t: ReturnType<typeof useTranslations>;
  onToggle: (eventType: string, channel: NotificationChannel, prev: boolean) => void;
}) {
  const checked = row.channels[channel];
  const channelLabel = t(channel === 'email' ? 'columns.email' : 'columns.inApp');
  const eventLabel = t(`events.${row.eventType}.label`);
  const ariaLabel = row.settable
    ? t('cellAria', { channel: channelLabel, event: eventLabel })
    : t('cellAriaSoon', { channel: channelLabel, event: eventLabel });
  return (
    <div className="border-(--el-border-soft) flex justify-center border-b py-3.5">
      <Switch
        checked={checked}
        disabled={!row.settable}
        onCheckedChange={() => onToggle(row.eventType, channel, checked)}
        aria-label={ariaLabel}
      />
    </div>
  );
}

function SaveIndicator({
  status,
  t,
}: {
  status: SaveStatus;
  t: ReturnType<typeof useTranslations>;
}) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'saving') {
    return (
      <span className="text-(--el-text-muted) inline-flex items-center gap-1.5 font-sans text-xs font-medium">
        <Spinner className="size-3.5" />
        {t('status.saving')}
      </span>
    );
  }
  if (status.kind === 'saved') {
    return (
      <span
        role="status"
        className="text-(--el-success) inline-flex items-center gap-1.5 font-sans text-xs font-medium"
      >
        <Check className="size-3.5" aria-hidden />
        {t('status.saved')}
      </span>
    );
  }
  return (
    <span
      role="alert"
      className="text-(--el-danger) inline-flex items-center gap-1.5 font-sans text-xs font-medium"
    >
      <TriangleAlert className="size-3.5" aria-hidden />
      {t('status.error')}
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={status.retry}
        className="text-(--el-link) font-semibold underline"
      >
        {t('status.retry')}
      </button>
    </span>
  );
}
