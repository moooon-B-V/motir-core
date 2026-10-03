'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { reasonReady, slugConfirmed } from './opsGate';

/**
 * THE CONFIRM every ops-toolkit write goes through — design
 * `platform-admin/design-notes.md` AMENDMENT 2026-10-03 § _The safe-action
 * pattern_ (MOTIR-752). The shipped `ClassificationBar` grammar, generalised:
 *
 * 1. a `Modal role="alertdialog"` — nothing writes on the first click;
 * 2. the consequence stated before anything is asked (`children`);
 * 3. a REQUIRED reason (`Textarea`, "Reason — required, written to the audit
 *    log"), the primary `disabled` until it is non-blank;
 * 4. on the heavy ones, a TYPED confirm of the org's slug (`typedSlug`).
 *
 * The dialog owns only its drafts. Mount it when it opens and unmount it when it
 * closes (the callers render it conditionally), so a reopened dialog never
 * carries a stale reason or slug. `extraReady` is the caller's own gate (an
 * amount, a chosen plan); `onConfirm` receives the trimmed reason.
 *
 * ⚠️ THE DISABLED PRIMARY IS A COURTESY — every service re-checks the reason
 * before its transaction opens (`opsGate.ts`'s header).
 */
export interface ReasonConfirmDialogProps {
  title: string;
  description?: string;
  /** The consequence block and any input the write needs (an amount, a plan). */
  children?: ReactNode;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
  /** When set, the operator must type this slug back before the primary enables. */
  typedSlug?: string | null;
  /** The caller's own readiness (default true). */
  extraReady?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function ReasonConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  confirmVariant = 'primary',
  typedSlug = null,
  extraReady = true,
  pending,
  onCancel,
  onConfirm,
}: ReasonConfirmDialogProps) {
  const t = useTranslations('platformAdmin.ops');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const reasonId = useId();
  const slugId = useId();

  const ready =
    extraReady && reasonReady(reason) && (typedSlug === null || slugConfirmed(typed, typedSlug));

  return (
    <Modal
      open
      onOpenChange={(next) => (next || pending ? undefined : onCancel())}
      role="alertdialog"
      title={title}
      description={description}
      size="md"
    >
      <Modal.Body className="gap-4">
        {children}
        {typedSlug !== null ? (
          <Input
            id={slugId}
            label={t('typeToConfirm', { slug: typedSlug })}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="ops-typed-slug"
          />
        ) : null}
        <Textarea
          id={reasonId}
          label={t('reason.label')}
          placeholder={t('reason.placeholder')}
          helperText={t('reason.hint')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          rows={3}
          data-testid="ops-reason"
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          variant={confirmVariant}
          loading={pending}
          disabled={!ready}
          onClick={() => {
            if (ready) onConfirm(reason.trim());
          }}
          data-testid="ops-confirm"
        >
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
