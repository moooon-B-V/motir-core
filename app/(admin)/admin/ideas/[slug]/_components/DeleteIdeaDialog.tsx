'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { deleteIdeaAction, type IdeaDeleteResult } from '../../actions';

/**
 * DELETE — design `platform-admin` § Ideas, Panel 9, card MOTIR-7681; rendered
 * for a superadmin only, and the action re-gates it. An `alertdialog` saying
 * what is lost and pointing at Retire, with a REQUIRED reason and the slug typed
 * back: the danger button stays disabled until both are there.
 */

export interface DeleteIdeaDialogProps {
  idea: Pick<StaffIdeaDto, 'slug' | 'title'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (result: Exclude<IdeaDeleteResult, { code: 'invalid' }>) => void;
}

export function DeleteIdeaDialog({ idea, open, onOpenChange, onDone }: DeleteIdeaDialogProps) {
  const t = useTranslations('platformAdmin.ideas');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const ready = reason.trim().length > 0 && typed.trim() === idea.slug;

  // Opening and closing both start from an empty form, so no state outlives it.
  function close(next: boolean) {
    setReason('');
    setTyped('');
    setError(undefined);
    onOpenChange(next);
  }

  function submit() {
    if (!ready) return;
    startTransition(async () => {
      const result = await deleteIdeaAction(idea.slug, reason.trim());
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
      title={t('delete.title', { title: idea.title })}
      description={t('delete.body')}
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
            label={t('delete.reason')}
            placeholder={t('delete.placeholder')}
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
            data-testid="idea-delete-reason"
          />
          <Input
            label={t('delete.typeSlug', { slug: idea.slug })}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            data-testid="idea-delete-slug"
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={() => close(false)} disabled={pending}>
            {t('delete.cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={pending} disabled={!ready}>
            {t('delete.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
