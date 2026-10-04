'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { CircleCheck, Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { reactivateOrganizationAction, suspendOrganizationAction } from '../../lifecycleActions';
import { ReasonConfirmDialog } from './ReasonConfirmDialog';

/**
 * SUSPEND / REACTIVATE — design `platform-admin` AMENDMENT 2026-10-03 Panel 3a/3c
 * (MOTIR-752; the writes are MOTIR-748's `lifecycleActions.ts`).
 *
 * Suspend is the heavy one: the consequence list, the org's slug typed back, a
 * reason, and the danger fill. Reactivate is a reason and a secondary button with
 * a check glyph — the design system has no success-filled button, and the success
 * hue is carried by the Active pill the action produces.
 *
 * ⚠️ THIS ISLAND OWNS NO ORGANIZATION STATE. The status card, the header pill and
 * the audit slice are server-rendered and the actions `revalidatePath` the org
 * page, so they re-read (CLAUDE.md's page-state contract, case 2). It holds a
 * dialog flag and nothing else.
 */
export interface OrgLifecycleControlProps {
  orgId: string;
  name: string;
  slug: string;
  suspended: boolean;
  memberCount: number;
  workspaceCount: number;
}

export function OrgLifecycleControl({
  orgId,
  name,
  slug,
  suspended,
  memberCount,
  workspaceCount,
}: OrgLifecycleControlProps) {
  const t = useTranslations('platformAdmin.ops');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm(reason: string) {
    startTransition(async () => {
      const result = suspended
        ? await reactivateOrganizationAction(orgId, { reason })
        : await suspendOrganizationAction(orgId, { reason });
      if (result.ok) {
        toast({
          variant: 'success',
          title: suspended
            ? t('result.reactivated', { org: name })
            : t('result.suspended', { org: name }),
        });
        setOpen(false);
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
      {suspended ? (
        <Button
          variant="secondary"
          leftIcon={<CircleCheck aria-hidden className="h-4 w-4" />}
          onClick={() => setOpen(true)}
        >
          {t('reactivate.button')}
        </Button>
      ) : (
        <Button
          variant="danger"
          leftIcon={<Lock aria-hidden className="h-4 w-4" />}
          onClick={() => setOpen(true)}
        >
          {t('suspend.button')}
        </Button>
      )}

      {open && !suspended ? (
        <ReasonConfirmDialog
          title={t('suspend.title', { org: name })}
          confirmLabel={t('suspend.confirm', { org: name })}
          confirmVariant="danger"
          typedSlug={slug}
          pending={pending}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        >
          <div className="flex flex-col gap-2 font-sans text-sm text-(--el-text)">
            <p>{t('suspend.lead')}</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>
                {t('suspend.c1', {
                  members: memberCount,
                  workspaces: workspaceCount,
                })}
              </li>
              <li>{t('suspend.c2')}</li>
              <li>{t('suspend.c3')}</li>
            </ul>
          </div>
        </ReasonConfirmDialog>
      ) : null}

      {open && suspended ? (
        <ReasonConfirmDialog
          title={t('reactivate.title', { org: name })}
          description={t('reactivate.body', { members: memberCount })}
          confirmLabel={t('reactivate.confirm', { org: name })}
          pending={pending}
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
        />
      ) : null}
    </>
  );
}
