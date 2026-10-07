'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { retireIdeaAction, type IdeaWriteResult } from '../../actions';

/**
 * RETIRE — design `platform-admin` § Ideas, Panel 8, card MOTIR-7681. An
 * `alertdialog` with a REQUIRED reason: **Retire idea** stays disabled until one
 * is typed, and a reason the service still refuses (over 2000 characters) is
 * marked on the field. Every other outcome goes to `onDone`, which draws it.
 */

export interface RetireIdeaDialogProps {
  idea: Pick<StaffIdeaDto, 'slug' | 'title'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (result: Exclude<IdeaWriteResult, { code: 'invalid' }>) => void;
}

export function RetireIdeaDialog({ idea, open, onOpenChange, onDone }: RetireIdeaDialogProps) {
  const t = useTranslations('platformAdmin.ideas');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  // Opening and closing both start from an empty form, so no state outlives it.
  function close(next: boolean) {
    setReason('');
    setError(undefined);
    onOpenChange(next);
  }

  function submit() {
    const stated = reason.trim();
    if (!stated) return;
    startTransition(async () => {
      const result = await retireIdeaAction(idea.slug, stated);
      if (!result.ok && result.code === 'invalid') {
        setError(t('fieldError.reason'));
        return;
      }
      close(false);
      onDone(result);
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      role="alertdialog"
      title={t('retire.title', { title: idea.title })}
      description={t('retire.body')}
      size="md"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Modal.Body className="gap-4">
          <Textarea
            label={t('retire.reason')}
            placeholder={t('retire.placeholder')}
            value={reason}
            rows={3}
            required
            aria-required
            autoFocus
            onChange={(event) => {
              setReason(event.target.value);
              setError(undefined);
            }}
            error={error}
            data-testid="idea-retire-reason"
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={() => close(false)} disabled={pending}>
            {t('retire.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={reason.trim().length === 0}
          >
            {t('retire.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
