'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import type { OrgFeatureFlagKey } from '@/lib/featureFlags/registry';
import { setKillSwitchAction } from '../../killSwitchActions';
import { ReasonConfirmDialog } from './ReasonConfirmDialog';

/**
 * ONE kill-switch's control — design `platform-admin` AMENDMENT 2026-10-03
 * Panel 1 (MOTIR-752; the write is MOTIR-750's `setKillSwitchAction`).
 *
 * The `Switch` shows the STORED state; flipping it (or pressing Turn off / Turn
 * on) never writes — it opens the confirm with the switch's own "When OFF" line
 * and a required reason. A read-only role sees the switch disabled and no button.
 *
 * ⚠️ NO LOCAL COPY OF `enabled`. The table row (state pill, last change) is
 * server-rendered and the action revalidates the org page, so the prop is the
 * truth once the write lands; the island holds only the dialog flag.
 */
export interface KillSwitchControlProps {
  orgId: string;
  orgName: string;
  flagKey: OrgFeatureFlagKey;
  enabled: boolean;
  canWrite: boolean;
}

export function KillSwitchControl({
  orgId,
  orgName,
  flagKey,
  enabled,
  canWrite,
}: KillSwitchControlProps) {
  const t = useTranslations('platformAdmin.ops');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const switchName = t(`switch.${flagKey}.name`);

  function confirm(reason: string) {
    startTransition(async () => {
      const result = await setKillSwitchAction(orgId, { key: flagKey, enabled: !enabled, reason });
      if (result.ok) {
        toast({
          variant: 'success',
          title: enabled
            ? t('result.switchOff', { switch: switchName, org: orgName })
            : t('result.switchOn', { switch: switchName, org: orgName }),
        });
        setOpen(false);
        return;
      }
      toast({ variant: 'error', title: t('failedTitle'), description: t(`error.${result.code}`) });
    });
  }

  return (
    <div className="flex items-center justify-end gap-3">
      <Switch
        checked={enabled}
        onCheckedChange={() => setOpen(true)}
        disabled={!canWrite}
        aria-label={switchName}
      />
      {canWrite ? (
        <Button
          size="sm"
          variant={enabled ? 'secondary' : 'primary'}
          onClick={() => setOpen(true)}
          data-testid={`kill-switch-${flagKey}`}
        >
          {enabled ? t('switches.turnOff') : t('switches.turnOn')}
        </Button>
      ) : null}
      {open ? (
        <ReasonConfirmDialog
          title={
            enabled
              ? t('switches.confirmOff.title', { switch: switchName, org: orgName })
              : t('switches.confirmOn.title', { switch: switchName, org: orgName })
          }
          description={
            enabled
              ? t(`switch.${flagKey}.whenOff`)
              : t('switches.confirmOn.body', { switch: switchName, org: orgName })
          }
          confirmLabel={enabled ? t('switches.turnOff') : t('switches.turnOn')}
          confirmVariant={enabled ? 'danger' : 'primary'}
          pending={pending}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  );
}
