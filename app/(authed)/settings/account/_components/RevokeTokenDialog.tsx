'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { revokeToken, type ApiTokenDto } from './apiTokensClient';

// Revoke confirm (Story 7.8 · Subtask 7.8.3) — design
// `account-settings.mock.html` Panel 6. A destructive Modal (sm) NAMING the
// token, with a rose-tint danger callout that spells out the consequence in
// text (never colour-only), and a danger primary action. On success the parent
// flips the row to the muted "Revoked" state optimistically from the returned
// DTO (the inline-edit-no-tree-refresh contract).
export function RevokeTokenDialog({
  token,
  onClose,
  onRevoked,
}: {
  token: ApiTokenDto;
  onClose: () => void;
  onRevoked: (revoked: ApiTokenDto) => void;
}) {
  const t = useTranslations('settings.apiTokens');
  const { toast } = useToast();
  const [revoking, setRevoking] = useState(false);

  async function confirm() {
    setRevoking(true);
    try {
      const revoked = await revokeToken(token.id);
      onRevoked(revoked);
    } catch {
      toast({
        variant: 'error',
        title: t('revokeConfirm.errorTitle'),
        description: t('revokeConfirm.errorGeneric'),
      });
      setRevoking(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('revokeConfirm.title', { label: token.label })}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-(--el-danger)" />
          <p className="font-sans text-sm text-(--el-text-strong)">{t('revokeConfirm.body')}</p>
        </div>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={revoking}>
            {t('revokeConfirm.cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            loading={revoking}
            leftIcon={<Trash2 className="size-4" />}
            onClick={() => void confirm()}
          >
            {t('revokeConfirm.confirm')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
