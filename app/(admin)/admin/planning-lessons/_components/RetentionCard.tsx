'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { PlatformLessonRetentionDTO } from '@/lib/dto/platformLessons';
import { previewLessonRetentionAction, setLessonRetentionAction } from '../actions';

/**
 * The RETIREMENT-WINDOW card — design Panel 10, card MOTIR-1463.
 *
 * One sentence with the current N, a line saying who set it, and **Change** for a
 * superadmin (anyone else reads "Only a superadmin can change this."). The
 * confirm takes days within motir-ai's bounds, shows how many lessons injected
 * today the new value would rest BEFORE the commit, and requires a reason.
 *
 * Holds only the draft: the stored N is the server-rendered `retention` prop,
 * re-read by the action's `revalidatePath`.
 */
export function RetentionCard({ retention }: { retention: PlatformLessonRetentionDTO }) {
  const t = useTranslations('platformAdmin.lessons');
  const format = useFormatter();
  const { toast } = useToast();
  const daysId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  // The count is keyed by the days it answers, so a stale one never shows.
  const [impact, setImpact] = useState<{ days: number; n: number } | null>(null);
  const [isPending, startTransition] = useTransition();
  const seq = useRef(0);

  const days = Number(draft);
  const valid =
    draft.trim() !== '' &&
    Number.isInteger(days) &&
    days >= retention.minDays &&
    days <= retention.maxDays;
  const changed = valid && days !== retention.days;

  // The impact count follows the draft; a stale answer never overwrites a newer one.
  useEffect(() => {
    if (!open || !changed) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const n = await previewLessonRetentionAction(days);
      if (mine === seq.current && n !== null) setImpact({ days, n });
    }, 250);
    return () => clearTimeout(timer);
  }, [open, changed, days]);
  const shownImpact = impact && impact.days === days ? impact.n : null;

  function close() {
    setOpen(false);
    setReason('');
    setDraft('');
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed || !changed) return;
    const next = days;
    startTransition(async () => {
      const result = await setLessonRetentionAction(next, trimmed);
      close();
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('window.saved'),
          description: t('window.savedBody', { days: next }),
        });
      } else if (result.code === 'UNCHANGED') {
        toast({ variant: 'warning', title: t('noop') });
      } else if (result.code === 'UNAVAILABLE') {
        toast({ variant: 'error', title: t('refused.unavailable') });
      } else if (result.code === 'NOT_PERMITTED') {
        toast({ variant: 'error', title: t('refused.notPermitted') });
      } else if (result.code === 'INVALID') {
        toast({ variant: 'error', title: t('refused.invalid') });
      } else {
        toast({ variant: 'error', title: t('refused.failed') });
      }
    });
  }

  const sub = !retention.isSet
    ? t('window.subDefault', { days: retention.defaultDays })
    : retention.updatedAt
      ? retention.updatedByName
        ? t('window.subBy', {
            who: retention.updatedByName,
            when: format.dateTime(new Date(retention.updatedAt), { dateStyle: 'medium' }),
          })
        : t('window.subByUnknown', {
            when: format.dateTime(new Date(retention.updatedAt), { dateStyle: 'medium' }),
          })
      : null;

  return (
    <Card data-testid="lesson-retention-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Hourglass aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
          <div className="flex min-w-0 flex-col gap-1 font-sans">
            <p className="text-sm text-(--el-text)" data-testid="lesson-retention-line">
              {t('window.line', { days: retention.days })}
            </p>
            {sub ? <p className="text-xs text-(--el-text-secondary)">{sub}</p> : null}
          </div>
        </div>
        {retention.canChange ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDraft(String(retention.days));
              setOpen(true);
            }}
          >
            {t('window.change')}
          </Button>
        ) : (
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('window.readOnly')}</p>
        )}
      </div>
      {retention.canChange ? (
        <Modal
          open={open}
          onOpenChange={(next) => (next ? undefined : close())}
          role="alertdialog"
          title={t('window.confirmTitle')}
          description={t('window.confirmBody')}
          size="md"
        >
          <Modal.Body className="gap-4">
            <Input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={retention.minDays}
              max={retention.maxDays}
              label={t('window.daysLabel')}
              helperText={t('window.bounds', { min: retention.minDays, max: retention.maxDays })}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              data-testid="lesson-retention-days"
            />
            {changed ? (
              <p
                data-testid="lesson-retention-impact"
                className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)"
              >
                <AlertTriangle
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)"
                />
                <span>
                  {shownImpact === null
                    ? t('window.impactCounting')
                    : t('window.impact', { days, n: shownImpact })}
                </span>
              </p>
            ) : null}
            <Input
              label={t('reasonLabel')}
              placeholder={t('reasonPlaceholder')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={280}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onClick={close} disabled={isPending}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              loading={isPending}
              disabled={!changed || reason.trim().length === 0}
            >
              {t('window.confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </Card>
  );
}
