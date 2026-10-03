'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Eye, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import type {
  ImpersonationModeDTO,
  ImpersonationStartOptionsDTO,
} from '@/lib/dto/platformImpersonation';
import { startStaffSessionAction } from '../impersonationActions';

/**
 * **View as {first name}** and its dialog — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-03, Panel 4 (Story 10.3 · MOTIR-749).
 *
 * The safe-action pattern the asset uses for every write: the button opens a
 * `Modal role="alertdialog"`; the dialog states the consequence first (which
 * org, which account, the banner); Access is a `Segmented` (**Read-only** by
 * default · Full access), Ends after another (15 / **30** / 60 min); the mode's
 * note sits in the tint grammar (yellow for read-only, rose + the danger
 * primary for full access); the primary is disabled until a reason is typed.
 * That last one is a courtesy — the service asserts the reason, the time-box,
 * the mode and every eligibility rule itself.
 *
 * Rendered only for a `superadmin`, and only with an eligible account; an
 * ineligible one gets the reason in place of the button (the page decides).
 */
export interface ViewAsDialogProps {
  options: ImpersonationStartOptionsDTO;
}

export function ViewAsDialog({ options }: ViewAsDialogProps) {
  const t = useTranslations('platformAdmin.imp');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ImpersonationModeDTO>('read_only');
  const [minutes, setMinutes] = useState(String(options.defaultDurationMinutes));
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const reasonFieldId = useId();

  const workspace =
    options.workspaces.find((w) => w.workspaceId === options.defaultWorkspaceId) ?? null;
  const org = workspace?.organizationName ?? '';
  const readOnly = mode === 'read_only';

  function close() {
    setOpen(false);
    setReason('');
    setMode('read_only');
    setMinutes(String(options.defaultDurationMinutes));
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await startStaffSessionAction({
        userId: options.targetUserId,
        mode,
        durationMinutes: Number(minutes),
        reason: trimmed,
        workspaceId: options.defaultWorkspaceId,
      });
      if (result.ok) {
        // A full navigation, so the first page of the session renders with the
        // staff-session cookie (see the action's header).
        window.location.assign('/dashboard');
        return;
      }
      toast({
        variant: 'error',
        title: t('failedTitle'),
        description: t(`error.${result.code}`),
      });
    });
  }

  return (
    <>
      <Button
        variant="secondary"
        leftIcon={<Eye aria-hidden className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        {t('viewAs', { firstName: options.firstName })}
      </Button>

      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        role="alertdialog"
        title={t('title', { name: options.name })}
        description={t('body', { org, email: options.email })}
        size="md"
      >
        <Modal.Body className="gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">{t('access')}</span>
            <Segmented<ImpersonationModeDTO>
              label={t('access')}
              value={mode}
              onChange={setMode}
              disabled={isPending}
              options={[
                {
                  value: 'read_only',
                  label: t('readOnly'),
                  icon: <Eye aria-hidden className="h-4 w-4" />,
                },
                {
                  value: 'full',
                  label: t('full'),
                  icon: <KeyRound aria-hidden className="h-4 w-4" />,
                },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">{t('length')}</span>
            <Segmented<string>
              label={t('length')}
              value={minutes}
              onChange={setMinutes}
              disabled={isPending}
              options={options.durationsMinutes.map((n) => ({
                value: String(n),
                label: t('minutes', { n }),
              }))}
            />
            <span className="font-sans text-xs text-(--el-text-secondary)">{t('lengthHint')}</span>
          </div>

          {/* The mode's consequence, in the tint grammar: hue in the tint and the
              glyph, the words on `--el-text-strong` (finding #35). */}
          <p
            className={`flex items-start gap-2 rounded-(--radius-card) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong) ${
              readOnly ? 'bg-(--el-tint-yellow)' : 'bg-(--el-tint-rose)'
            }`}
          >
            {readOnly ? (
              <Eye aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
            ) : (
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
            )}
            <span>
              {readOnly
                ? t('readOnlyNote', { firstName: options.firstName })
                : t('fullWarning', { firstName: options.firstName, org })}
            </span>
          </p>

          <Input
            id={reasonFieldId}
            label={t('reasonLabel')}
            helperText={t('reasonHint')}
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
            variant={readOnly ? 'primary' : 'danger'}
            onClick={submit}
            loading={isPending}
            disabled={reason.trim().length === 0}
          >
            {readOnly ? t('start.readOnly') : t('start.full')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
