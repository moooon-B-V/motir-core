'use client';

import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { RefusalBox, type AgentRefusal } from './agentRefusal';

// DELETE (MOTIR-6868 revision 3, panel 6): the confirmation names what is lost —
// the machine AND its home go (§1, §4) — and says the machine time already used
// stays charged. Keep it is the safe default; Delete agent is the danger fill.

export function DeleteAgentDialog({
  name,
  onOpenChange,
  pending,
  refusal,
  onConfirm,
}: {
  /** The agent being deleted; the dialog is open while it is set. */
  name: string | null;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  refusal: AgentRefusal | null;
  onConfirm: () => void;
}) {
  const t = useTranslations('myAgents.delete');
  return (
    <Modal
      open={name !== null}
      onOpenChange={onOpenChange}
      size="md"
      role="alertdialog"
      title={t('title', { name: name ?? '' })}
    >
      <Modal.Body className="gap-3 text-sm text-(--el-text)">
        <p className="m-0">{t.rich('intro', { b: (chunks) => <strong>{chunks}</strong> })}</p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li>{t('lose1')}</li>
          <li>{t('lose2')}</li>
          <li>{t('lose3')}</li>
        </ul>
        <p className="m-0 text-(--el-text-secondary)">{t('irreversible')}</p>
        {refusal ? <RefusalBox refusal={refusal} /> : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
          {t('keep')}
        </Button>
        <Button
          variant="danger"
          loading={pending}
          leftIcon={<Trash2 aria-hidden="true" />}
          onClick={onConfirm}
        >
          {t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
