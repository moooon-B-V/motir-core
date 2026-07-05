'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { buttonVariants } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { BILLING_PLANS_PATH } from '@/components/ai/AiPaywall';

// The org-settings "Acceptance video" card (Story MOTIR-1627 · Subtask
// MOTIR-1635), a sibling of OrgGeneralCard, built to
// design/work-items/acceptance-panel.png (panel S). Org owner/admin toggles the
// org-wide flag via PATCH /api/organizations/[orgId] (acceptanceVideoEnabled).
// When the org has NO paid AI plan the toggle is moot (the entitlement blocks
// generation regardless), so it renders disabled + an Upgrade CTA — the same
// plan gate the acceptance panel's State C shows. `id="acceptance-video"` is the
// anchor the panel's "Go to settings" link targets.

export interface AcceptanceVideoCardProps {
  orgId: string;
  initialEnabled: boolean;
  /** The org holds a paid AI plan (or the build is off-cloud → ungated). */
  hasPlan: boolean;
  /** The actor may flip the toggle (org owner/admin). */
  canManage: boolean;
}

export function AcceptanceVideoCard({
  orgId,
  initialEnabled,
  hasPlan,
  canManage,
}: AcceptanceVideoCardProps) {
  const t = useTranslations('acceptance');
  const router = useRouter();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setEnabled(next); // optimistic
    startTransition(async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ acceptanceVideoEnabled: next }),
        });
        if (res.ok) {
          toast({ variant: 'success', title: t('card.saved') });
          router.refresh();
          return;
        }
        setEnabled(!next); // revert the optimistic flip on failure
        toast({ variant: 'error', title: t('card.saveError') });
      } catch {
        setEnabled(!next);
        toast({ variant: 'error', title: t('card.saveError') });
      }
    });
  }

  return (
    <Card
      id="acceptance-video"
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('card.title')}</h2>
          <p className="text-(--el-text-muted) font-sans text-sm">{t('card.desc')}</p>
        </div>
      }
      footer={
        hasPlan ? undefined : (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-(--el-text-secondary) font-sans text-xs">
              <Sparkles className="h-3.5 w-3.5 text-(--el-text-faint)" aria-hidden />
              {t('card.requiresPlan')}
            </span>
            <Link
              href={BILLING_PLANS_PATH}
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
            >
              {t('card.upgrade')}
            </Link>
          </div>
        )
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-(--el-text-secondary) font-sans text-sm">
          {enabled ? t('card.on') : t('card.off')}
        </span>
        <Switch
          checked={enabled && hasPlan}
          onCheckedChange={toggle}
          disabled={!canManage || !hasPlan || isPending}
          aria-label={t('card.title')}
        />
      </div>
    </Card>
  );
}
