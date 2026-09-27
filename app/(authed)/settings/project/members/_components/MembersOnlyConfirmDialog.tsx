'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { AccessLossPersonDTO } from '@/lib/dto/projectMembers';
import { RolePill, ScopePill } from './MemberChips';

// The Members-only confirm (Story MOTIR-6169 · MOTIR-6550 ·
// `design/projects/access-members--access-modes.mock.html` A2 / A3). Choosing
// Members only does NOT flip the radio: the page reads
// `GET /api/projects/<key>/access/preview?mode=members` (MOTIR-6544) first, and
// this dialog names exactly the people who lose access — the Full, non-Manager
// members who were not added — or, with nobody, says so in one sentence. The
// switch adds nobody to the project. Initial focus is Cancel (design § a11y).

export interface MembersOnlyConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  workspaceName: string;
  /** The preview's answer — who stops being able to open the project. */
  losing: AccessLossPersonDTO[];
  onConfirm: () => void;
  pending?: boolean;
}

export function MembersOnlyConfirmDialog({
  open,
  onOpenChange,
  projectName,
  workspaceName,
  losing,
  onConfirm,
  pending = false,
}: MembersOnlyConfirmDialogProps) {
  const t = useTranslations('settings.access');
  const tc = useTranslations('common');

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={t('membersOnlyConfirmTitle', { projectName })}
      closeLabel={tc('close')}
    >
      <Modal.Body className="gap-4">
        {losing.length === 0 ? (
          <p className="text-(--el-text-secondary) font-sans text-sm">
            {t('membersOnlyConfirmNobody', { projectName })}
          </p>
        ) : (
          <>
            <p className="text-(--el-text-secondary) font-sans text-sm">
              {t.rich('membersOnlyConfirmBody', {
                count: losing.length,
                workspaceName,
                b: (chunks) => <strong className="text-(--el-text)">{chunks}</strong>,
              })}
            </p>
            <ul
              role="list"
              aria-label={t('membersOnlyConfirmTitle', { projectName })}
              className="border-(--el-border) flex max-h-[16rem] flex-col overflow-y-auto rounded-(--radius-card) border"
            >
              {losing.map((person) => (
                <li
                  key={person.userId}
                  className="border-(--el-border-soft) flex items-center gap-3 border-b px-(--spacing-control-x) py-(--spacing-control-y) last:border-b-0"
                >
                  <span
                    className="bg-(--el-text) text-(--el-text-inverted) inline-flex size-7 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold"
                    aria-hidden
                  >
                    {(person.name || person.email).charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
                      {person.name}
                    </span>
                    <span className="text-(--el-text-secondary) block truncate font-sans text-xs">
                      {person.email}
                    </span>
                  </span>
                  <RolePill role={person.workspaceRole} customRoleName={person.customRoleName} />
                  <ScopePill scope="full" />
                </li>
              ))}
            </ul>
            <p className="text-(--el-text-secondary) font-sans text-xs">
              {t('membersOnlyConfirmHint')}
            </p>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button autoFocus variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
          {tc('cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          loading={pending}
          leftIcon={<Lock className="size-4" aria-hidden />}
        >
          {t('membersOnlyConfirmAction')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
