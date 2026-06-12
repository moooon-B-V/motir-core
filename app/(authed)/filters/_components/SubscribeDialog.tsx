'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Combobox } from '@/components/ui/Combobox';
import { useToast } from '@/components/ui/Toast';
import {
  getSubscription,
  subscribe,
  unsubscribe,
  type SavedFilterSubscriptionDto,
  type SavedFilterSummaryDto,
} from './savedFiltersClient';

// Subscribe / re-schedule / unsubscribe dialog (Story 6.2 · Subtask 6.2.5) —
// per design/work-items/saved-filters.mock.html panel 5. Mounted from the
// directory row's ⋯ menu (the dropdown row action lands with 6.2.3). Preset
// tier only (Jira's daily/weekdays/weekly — advanced cron is the extension);
// hours are UTC (the app's pinned timezone). The subscribed state is the mint
// bell tile + Unsubscribe; editing it re-PUTs the schedule. The schedule
// matrix + a11y mirror the EditFilterDialog (focus-trapped Modal, labelled
// controls, state never colour-only).

type Schedule = 'daily' | 'weekdays' | 'weekly';

// JS getUTCDay order — Monday-first reads better but the value IS getUTCDay, so
// keep the value↔label honest (0=Sun).
const WEEKDAY_VALUES = ['1', '2', '3', '4', '5', '6', '0'] as const;
const HOUR_VALUES = Array.from({ length: 24 }, (_, h) => String(h));

export function SubscribeDialog({
  projectKey,
  filter,
  onClose,
}: {
  projectKey: string;
  filter: SavedFilterSummaryDto;
  onClose: () => void;
}) {
  const t = useTranslations('savedFilters');
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<SavedFilterSubscriptionDto | null>(null);
  const [editing, setEditing] = useState(false);

  const [schedule, setSchedule] = useState<Schedule>('daily');
  const [weekday, setWeekday] = useState<number>(1);
  const [hour, setHour] = useState<number>(9);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    getSubscription(projectKey, filter.id)
      .then((sub) => {
        if (!active) return;
        setCurrent(sub);
        if (sub) {
          setSchedule(sub.schedule);
          setHour(sub.hour);
          if (sub.weekday != null) setWeekday(sub.weekday);
        }
        setEditing(sub === null);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        toast({ variant: 'error', title: t('subscribe.loadError') });
        onClose();
      });
    return () => {
      active = false;
    };
  }, [projectKey, filter.id, onClose, t, toast]);

  const weekdayOptions = useMemo(
    () => WEEKDAY_VALUES.map((v) => ({ value: v, label: t(`subscribe.weekday.${v}`) })),
    [t],
  );
  const hourOptions = useMemo(
    () =>
      HOUR_VALUES.map((v) => ({
        value: v,
        label: t('subscribe.hourOption', { hour: `${v.padStart(2, '0')}:00` }),
      })),
    [t],
  );

  async function save() {
    setSaving(true);
    try {
      const sub = await subscribe(projectKey, filter.id, {
        schedule,
        hour,
        ...(schedule === 'weekly' ? { weekday } : { weekday: null }),
      });
      setCurrent(sub);
      setEditing(false);
      toast({ variant: 'success', title: t('subscribe.savedToast', { name: filter.name }) });
    } catch {
      toast({ variant: 'error', title: t('subscribe.saveError') });
    } finally {
      setSaving(false);
    }
  }

  async function removeSubscription() {
    setSaving(true);
    try {
      await unsubscribe(projectKey, filter.id);
      toast({ variant: 'success', title: t('subscribe.unsubscribedToast', { name: filter.name }) });
      onClose();
    } catch {
      toast({ variant: 'error', title: t('subscribe.saveError') });
      setSaving(false);
    }
  }

  function scheduleSummary(sub: SavedFilterSubscriptionDto): string {
    const time = `${String(sub.hour).padStart(2, '0')}:00`;
    if (sub.schedule === 'weekly') {
      return t('subscribe.summaryWeekly', {
        day: t(`subscribe.weekday.${sub.weekday ?? 1}`),
        time,
      });
    }
    return t(`subscribe.summary.${sub.schedule}`, { time });
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('subscribe.title', { name: filter.name })}
      size="md"
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <div className="h-24 animate-pulse rounded-(--radius-card) bg-(--el-muted)" aria-hidden />
        ) : !editing && current ? (
          <>
            <div className="flex items-start gap-3 rounded-(--radius-card) bg-(--el-tint-mint) px-3 py-3">
              <BellRing className="mt-0.5 size-5 shrink-0 text-(--el-text-strong)" aria-hidden />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-(--el-text-strong)">
                  {t('subscribe.subscribedTitle')}
                </p>
                <p className="text-xs text-(--el-text-strong)">{scheduleSummary(current)}</p>
              </div>
            </div>
            <p className="text-xs text-(--el-text-muted)">{t('subscribe.explainer')}</p>
            <Modal.Footer>
              <Button type="button" variant="ghost" onClick={removeSubscription} loading={saving}>
                {t('subscribe.unsubscribe')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditing(true)}
                disabled={saving}
              >
                {t('subscribe.changeSchedule')}
              </Button>
            </Modal.Footer>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saving) void save();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-(--el-text)">
                {t('subscribe.frequencyLabel')}
              </span>
              <Segmented<Schedule>
                label={t('subscribe.frequencyLabel')}
                value={schedule}
                onChange={setSchedule}
                options={[
                  { value: 'daily', label: t('subscribe.frequency.daily') },
                  { value: 'weekdays', label: t('subscribe.frequency.weekdays') },
                  { value: 'weekly', label: t('subscribe.frequency.weekly') },
                ]}
              />
            </div>

            <div className="flex flex-wrap gap-4">
              {schedule === 'weekly' ? (
                <label className="flex min-w-40 flex-1 flex-col gap-1.5">
                  <span className="text-sm font-medium text-(--el-text)">
                    {t('subscribe.dayLabel')}
                  </span>
                  <Combobox<string>
                    label={t('subscribe.dayLabel')}
                    options={weekdayOptions}
                    value={String(weekday)}
                    onChange={(v) => setWeekday(Number(v))}
                    searchable={false}
                  />
                </label>
              ) : null}
              <label className="flex min-w-40 flex-1 flex-col gap-1.5">
                <span className="text-sm font-medium text-(--el-text)">
                  {t('subscribe.timeLabel')}
                </span>
                <Combobox<string>
                  label={t('subscribe.timeLabel')}
                  options={hourOptions}
                  value={String(hour)}
                  onChange={(v) => setHour(Number(v))}
                  searchable={false}
                />
              </label>
            </div>

            <p className="text-xs text-(--el-text-muted)">{t('subscribe.explainer')}</p>

            <Modal.Footer>
              <Button
                type="button"
                variant="ghost"
                onClick={current ? () => setEditing(false) : onClose}
                disabled={saving}
              >
                {t('subscribe.cancel')}
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                {current ? t('subscribe.save') : t('subscribe.subscribe')}
              </Button>
            </Modal.Footer>
          </form>
        )}
      </div>
    </Modal>
  );
}
