'use client';

import { useTranslations } from 'next-intl';
import { CircleArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { RefusalBox, type AgentRefusal } from './agentRefusal';

// UPDATE — the confirmation (MOTIR-6953; `my-agents--update.mock.html` panel 3):
// the page's own dialog shape, as Delete's. It names both versions and what is
// KEPT. A running agent is told it restarts; a hibernated one that it takes the
// new version at its next wake (`agent-image-update.md` Q2, Q5). Not now is the
// safe default and calls nothing.

export function UpdateAgentDialog({
  agent,
  onOpenChange,
  pending,
  refusal,
  onConfirm,
}: {
  /** The agent being updated; the dialog is open while it carries an update. */
  agent: AgentInstanceListItemDto | null;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  refusal: AgentRefusal | null;
  onConfirm: () => void;
}) {
  const t = useTranslations('myAgents.update');
  const to = agent && agent.update && agent.update !== 'unknown' ? agent.update.version : '';
  const from = agent?.imageVersion ?? t('earlierBuild');
  const asleep = agent?.state === 'hibernated';
  return (
    <Modal
      open={agent !== null}
      onOpenChange={onOpenChange}
      size="md"
      title={t('confirm.title', { name: agent?.name ?? '', to })}
    >
      <Modal.Body className="gap-3 text-sm text-(--el-text)">
        <p className="m-0">
          {t(asleep ? 'confirm.introHibernated' : 'confirm.introRunning', {
            agent: agent?.profileName ?? '',
            from,
            to,
          })}
        </p>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li>{t('confirm.keep1')}</li>
          <li>{t('confirm.keep2')}</li>
          <li>{t('confirm.keep3')}</li>
        </ul>
        <p className="m-0 text-(--el-text-secondary)">
          {t(asleep ? 'confirm.rollbackWake' : 'confirm.rollback', { from })}
        </p>
        {refusal ? <RefusalBox refusal={refusal} /> : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
          {t('confirm.notNow')}
        </Button>
        <Button
          loading={pending}
          leftIcon={<CircleArrowUp aria-hidden="true" />}
          onClick={onConfirm}
        >
          {t(asleep ? 'confirm.hibernated' : 'confirm.running')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
