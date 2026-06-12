'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { DashboardAccess } from '@prisma/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { DashboardSummaryDto } from '@/lib/dto/dashboards';
import { AccessCards } from './AccessCards';

// The create-dashboard modal (6.3.5, design panel 1b) — name + access only
// (the 6.4.1 access-card grammar narrowed to private|workspace). Any workspace
// member can create; on success it navigates straight into the new dashboard's
// grid (the design's create → open flow).

export function CreateDashboardModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('dashboards.create');
  const tc = useTranslations('common');
  const tToast = useTranslations('dashboards.toast');
  const { toast } = useToast();
  const router = useRouter();

  const [name, setName] = useState('');
  const [access, setAccess] = useState<DashboardAccess>('private');
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/dashboards', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name: trimmed, access }),
      });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const body = (await res.json()) as { dashboard: DashboardSummaryDto };
      onOpenChange(false);
      setName('');
      setAccess('private');
      router.push(`/dashboard/${body.dashboard.id}`);
    } catch {
      toast({ variant: 'error', title: tToast('errorTitle'), description: tToast('createError') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('title')} size="sm">
      <div className="flex flex-col gap-4">
        <Input
          label={t('nameLabel')}
          placeholder={t('namePlaceholder')}
          value={name}
          autoFocus
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreate();
            }
          }}
          data-testid="create-dashboard-name"
        />
        <div>
          <span className="mb-1.5 block text-sm font-medium text-(--el-text-strong)">
            {t('accessLabel')}
          </span>
          <AccessCards value={access} onChange={setAccess} />
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim()}
          loading={saving}
          onClick={handleCreate}
          data-testid="create-dashboard-submit"
        >
          {t('submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
