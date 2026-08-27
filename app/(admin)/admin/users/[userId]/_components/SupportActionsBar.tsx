'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Ban, KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { sendPasswordResetAction, setSuspendedAction } from '../actions';
import type { SupportActionResult } from '../actions';

/**
 * Panel 9's two writes, in the header's right slot — design
 * `platform-admin/design-notes.md`, card MOTIR-1167.
 *
 * > `Send password reset` (`.btn-secondary`, `i-key`) and `Suspend account`
 * > (`.btn-danger`, `i-ban`) sit in the header's right slot, exactly where Panel
 * > 6 puts *"View as tenant (read-only)"*. Every other field on the account is
 * > read-only.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE CONFIRM STEP IS THE DESIGN, AND THE REASON IS NOT DECORATION
 * ---------------------------------------------------------------------------
 * The asset's own words: the dialog *"states the consequence in plain words —
 * what happens to the person, what happens to their data, and that it is
 * reversible — and requires a **reason** before the destructive button is
 * usable. The reason is not decoration: it is what makes the audit row readable
 * months later. A row that says only 'suspended by OP' answers nothing."*
 *
 * So the destructive button is `disabled` until a non-blank reason is typed.
 * That is a COURTESY, not the enforcement: the rule is asserted in
 * `PLATFORM_AUDIT_ACTIONS`' reason policy, inside the transaction, where a
 * Server Action invoked without this dialog still meets it. A client-side check
 * that was the only check would be no check.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ AND THIS ISLAND OWNS NO ACCOUNT STATE
 * ---------------------------------------------------------------------------
 * It holds a dialog's open flag and a draft reason, and nothing else. The chip
 * that says whether the account is suspended, the session count and the support
 * log are all SERVER-rendered by the page; the action calls `revalidatePath`, so
 * they re-read. That is `CLAUDE.md`'s page-state contract taking its simplest
 * branch on purpose — an island seeded from props with `useState` could not be
 * reached by that refresh, and there is no reason to build one here.
 */

export interface SupportActionsBarProps {
  userId: string;
  /** The account's display name, interpolated into the confirm copy. */
  name: string;
  suspended: boolean;
}

type Pending = 'reset' | 'suspend' | null;

export function SupportActionsBar({ userId, name, suspended }: SupportActionsBarProps) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const [open, setOpen] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const reasonFieldId = useId();

  function close() {
    setOpen(null);
    setReason('');
  }

  function report(result: SupportActionResult, successTitle: string) {
    if (result.ok) {
      toast({ variant: 'success', title: successTitle });
      close();
      return;
    }
    // Every failure is named. `FAILED` is the only one that cannot say what went
    // wrong, and the action has already logged the cause server-side.
    toast({
      variant: 'error',
      title: t('users.action.failedTitle'),
      description: t(`users.action.error.${result.code}`),
    });
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed || open === null) return;
    const action = open;
    startTransition(async () => {
      const result =
        action === 'reset'
          ? await sendPasswordResetAction(userId, trimmed)
          : await setSuspendedAction(userId, !suspended, trimmed);
      report(
        result,
        action === 'reset'
          ? t('users.action.resetSent')
          : suspended
            ? t('users.action.unsuspended')
            : t('users.action.suspended'),
      );
    });
  }

  const dialogKey = open === 'reset' ? 'reset' : suspended ? 'unsuspend' : 'suspend';

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          leftIcon={<KeyRound aria-hidden className="h-4 w-4" />}
          onClick={() => setOpen('reset')}
        >
          {t('users.action.sendReset')}
        </Button>
        <Button
          // Suspending is destructive and LIFTING a suspension is not, so the two
          // directions do not share a tone — a filled-danger "Unsuspend" would
          // dress the safe half of the toggle as the dangerous one.
          variant={suspended ? 'secondary' : 'danger'}
          leftIcon={
            suspended ? (
              <ShieldCheck aria-hidden className="h-4 w-4" />
            ) : (
              <Ban aria-hidden className="h-4 w-4" />
            )
          }
          onClick={() => setOpen('suspend')}
        >
          {suspended ? t('users.action.unsuspend') : t('users.action.suspend')}
        </Button>
      </div>

      <Modal
        open={open !== null}
        onOpenChange={(next) => (next ? undefined : close())}
        // `alertdialog`, not `dialog`: two of the three confirmations take an
        // irreversible-feeling action on somebody else's account, and the role
        // is what makes a screen reader announce the consequence rather than
        // just the title.
        role="alertdialog"
        title={t(`users.confirm.${dialogKey}.title`, { name })}
        description={t(`users.confirm.${dialogKey}.body`, { name })}
        size="md"
      >
        <Modal.Body className="gap-4">
          <Input
            id={reasonFieldId}
            label={t('users.confirm.reasonLabel')}
            helperText={t('users.confirm.reasonHint', { name })}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('users.confirm.cancel')}
          </Button>
          <Button
            variant={dialogKey === 'suspend' ? 'danger' : 'primary'}
            onClick={submit}
            loading={isPending}
            // The reason gate, client-side. The enforcing copy is in the audit
            // vocabulary's reason policy — see the header.
            disabled={reason.trim().length === 0}
          >
            {t(`users.confirm.${dialogKey}.confirm`)}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
