'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Crown } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';

export interface OrgGeneralCardProps {
  orgId: string;
  initialName: string;
  slug: string;
  role: string;
  workspaceCount: number;
  memberCount: number;
}

// The org-settings General card (design/org-admin panel 2). Name is editable;
// the URL (slug) is a read-only preview (slug changes are out of 6.10.4's
// service surface). Save PATCHes the org route, then router.refresh() so the
// new name re-renders the shell org control too (an explicit Save, not a
// list-cell edit — so the whole-tree refresh is appropriate here).
export function OrgGeneralCard({
  orgId,
  initialName,
  slug,
  role,
  workspaceCount,
  memberCount,
}: OrgGeneralCardProps) {
  const t = useTranslations('orgAdmin');
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [isPending, startTransition] = useTransition();

  const isOwner = role === ORGANIZATION_ROLE.owner;

  function handleSave() {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      try {
        const res = await fetch(`/api/organizations/${orgId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: value }),
        });
        if (res.ok) {
          toast({ variant: 'success', title: t('settings.saved') });
          router.refresh();
          return;
        }
        toast({ variant: 'error', title: t('settings.saveError') });
      } catch {
        toast({ variant: 'error', title: t('settings.saveError') });
      }
    });
  }

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('settings.general')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-sm">{t('settings.generalSub')}</p>
          </div>
          <Pill orgRole={isOwner ? 'owner' : 'admin'} className="shrink-0">
            <Crown className="h-3.5 w-3.5" aria-hidden />
            {isOwner ? t('settings.youreOwner') : t('settings.youreAdmin')}
          </Pill>
        </div>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-(--el-text-muted) font-sans text-xs">
            {t('settings.workspacesSummary', { count: workspaceCount })} ·{' '}
            {t('settings.membersSummary', { count: memberCount })}
          </span>
          <Button
            variant="primary"
            loading={isPending}
            disabled={!name.trim()}
            onClick={handleSave}
          >
            {t('settings.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('settings.nameLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t('settings.urlLabel')}
          value={slug}
          readOnly
          disabled
          addonStart={<span className="text-(--el-text-faint)">motir.co/</span>}
          helperText={t('settings.urlHint')}
        />
      </div>
    </Card>
  );
}
