'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ArchiveProjectModal } from './ArchiveProjectModal';

export interface ArchiveProjectCardProps {
  projectId: string;
  projectName: string;
  projectIdentifier: string;
}

export function ArchiveProjectCard({
  projectId,
  projectName,
  projectIdentifier,
}: ArchiveProjectCardProps) {
  const t = useTranslations('settings');
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card
        className="border-2 border-(--el-danger)"
        header={
          <h2 className="font-sans text-base font-semibold" style={{ color: 'var(--el-danger)' }}>
            {t('danger.heading')}
          </h2>
        }
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-sans text-sm font-medium text-(--el-text)">{t('archive.title')}</p>
            <p className="text-(--el-text-muted) font-sans text-xs">{t('archive.description')}</p>
          </div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            {t('archive.archive')}
          </Button>
        </div>
      </Card>

      <ArchiveProjectModal
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        projectName={projectName}
        projectIdentifier={projectIdentifier}
      />
    </>
  );
}
