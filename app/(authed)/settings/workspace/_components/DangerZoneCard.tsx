'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { deleteWorkspaceAction, leaveWorkspaceAction } from '../actions';

export interface DangerZoneCardProps {
  workspaceName: string;
  isLastMember: boolean;
}

export function DangerZoneCard({ workspaceName, isLastMember }: DangerZoneCardProps) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleLeave() {
    startTransition(async () => {
      // On success the action redirects, so control only returns here on
      // the last-member error path.
      const result = await leaveWorkspaceAction();
      if (!result.ok) {
        toast({ variant: 'error', title: t('danger.cantLeaveTitle'), description: result.error });
      }
    });
  }

  const leaveButton = (
    <Button variant="danger" onClick={handleLeave} loading={isPending} disabled={isLastMember}>
      {t('danger.leave')}
    </Button>
  );

  return (
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
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('danger.leaveWorkspace')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('danger.leaveWorkspaceDesc')}
          </p>
        </div>
        {isLastMember ? (
          <Tooltip content={t('danger.lastMemberTooltip')}>
            {/* span wrapper: a disabled button doesn't fire the hover events Radix Tooltip needs. */}
            <span tabIndex={0}>{leaveButton}</span>
          </Tooltip>
        ) : (
          leaveButton
        )}
      </div>

      <div className="my-4 h-px bg-(--el-border)" />

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-sans text-sm font-medium text-(--el-text)">
            {t('danger.deleteWorkspace')}
          </p>
          <p className="text-(--el-text-muted) font-sans text-xs">
            {t('danger.deleteWorkspaceDesc')}
          </p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          {t('danger.delete')}
        </Button>
      </div>

      <DeleteConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        workspaceName={workspaceName}
      />
    </Card>
  );
}

function DeleteConfirmModal({
  open,
  onOpenChange,
  workspaceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [typed, setTyped] = useState('');
  const [isPending, startTransition] = useTransition();
  // Case-sensitive exact match enables the destructive button.
  const matches = typed === workspaceName;

  function handleDelete() {
    if (!matches) return;
    startTransition(async () => {
      // Success redirects; control only returns on an unexpected error.
      const result = await deleteWorkspaceAction();
      if (!result.ok) {
        toast({
          variant: 'error',
          title: t('danger.deleteErrorTitle'),
          description: result.error,
        });
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped('');
        onOpenChange(o);
      }}
      size="md"
    >
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-rose)' }}
        >
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--el-danger)' }} />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('danger.deleteModalTitle', { workspaceName })}
          </h2>
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">
            {t('danger.deleteModalDesc')}
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleDelete();
        }}
      >
        <Input
          label={t('danger.confirmLabel', { workspaceName })}
          placeholder={workspaceName}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={isPending}>
            {t('danger.deleteConfirmButton')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
