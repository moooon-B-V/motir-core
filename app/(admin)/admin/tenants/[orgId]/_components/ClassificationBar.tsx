'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Coins, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { setInternalBillingAction } from '../actions';
import type { ClassificationActionResult } from '../actions';

/**
 * The INTERNAL-BILLING control — design `platform-admin/design-notes.md`
 * **Panel 12**, card MOTIR-4568. The one write Story MOTIR-4337 adds.
 *
 * The shipped `SupportActionsBar` one entity over, and deliberately not a new
 * pattern: a button in the header's right slot, a confirm dialog whose primary
 * is DISABLED until a reason is typed, and the record rendered back on the same
 * surface by the page.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE REASON IS NOT DECORATION, AND THIS CHECK IS NOT THE ENFORCEMENT
 * ---------------------------------------------------------------------------
 * The design's own words for the sibling control: the reason *"is what makes the
 * audit row readable months later. A row that says only 'suspended by OP'
 * answers nothing."* The same holds here — an `org.internal_billing_set` row
 * with no reason cannot answer *why is this organization not being billed?* a
 * year from now.
 *
 * So the primary is `disabled` until a non-blank reason is typed. That is a
 * COURTESY. The RULE is `PLATFORM_AUDIT_ACTIONS`' reason policy, asserted in the
 * service before the transaction opens, where a Server Action invoked without
 * this dialog still meets it. A client-side check that was the only check would
 * be no check.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ AND THIS ISLAND OWNS NO ORGANIZATION STATE
 * ---------------------------------------------------------------------------
 * It holds a dialog flag and a draft reason, and nothing else. The two
 * classification chips, the note under the header and the audit trail are all
 * SERVER-rendered by the page; the action calls `revalidatePath`, so they
 * re-read. `CLAUDE.md`'s page-state contract, taking its simplest branch on
 * purpose — an island seeded from props with `useState` could not be reached by
 * that refresh, and there is no reason to build one here.
 *
 * ⚠️ AND `internalBilling` IS THE PROP, NOT "internal". The page passes the flag
 * this control sets and NOT `isMeta`, which means something else entirely and is
 * not settable from anywhere. Collapsing the two into one prop is the conflation
 * `docs/decisions/internal-billing-classification.md` §1 refuses, one layer up.
 */

export interface ClassificationBarProps {
  orgId: string;
  /** The organization's display name, interpolated into the confirm copy. */
  name: string;
  /** The CURRENT classification — the direction the button offers is its inverse. */
  internalBilling: boolean;
}

export function ClassificationBar({ orgId, name, internalBilling }: ClassificationBarProps) {
  const t = useTranslations('platformAdmin');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const reasonFieldId = useId();

  function close() {
    setOpen(false);
    setReason('');
  }

  function report(result: ClassificationActionResult) {
    if (result.ok) {
      toast({
        variant: 'success',
        title: internalBilling ? t('orgs.action.unclassified') : t('orgs.action.classified'),
      });
      close();
      return;
    }
    // Every failure is named. `FAILED` is the only one that cannot say what went
    // wrong, and the action has already logged the cause server-side.
    toast({
      variant: 'error',
      title: t('orgs.action.failedTitle'),
      description: t(`orgs.action.error.${result.code}`),
    });
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    startTransition(async () => {
      report(await setInternalBillingAction(orgId, !internalBilling, trimmed));
    });
  }

  const dialogKey = internalBilling ? 'unclassify' : 'classify';

  return (
    <>
      <Button
        // ⚠️ NEITHER DIRECTION IS `danger`. Classifying does not destroy
        // anything and unclassifying does not either — the ledger rows on both
        // sides are history, and the flag governs what happens NEXT. Dressing
        // this as destructive would teach an operator to read a red button as
        // routine, which is the tone the SUSPEND control needs to keep.
        variant="secondary"
        leftIcon={
          internalBilling ? (
            <Undo2 aria-hidden className="h-4 w-4" />
          ) : (
            <Coins aria-hidden className="h-4 w-4" />
          )
        }
        onClick={() => setOpen(true)}
      >
        {internalBilling ? t('orgs.action.unclassify') : t('orgs.action.classify')}
      </Button>

      <Modal
        open={open}
        onOpenChange={(next) => (next ? undefined : close())}
        // `alertdialog`: the consequence is a change to what an organization is
        // billed, and the role is what makes a screen reader announce the
        // consequence rather than just the title.
        role="alertdialog"
        title={t(`orgs.confirm.${dialogKey}.title`, { name })}
        description={t(`orgs.confirm.${dialogKey}.body`, { name })}
        size="md"
      >
        <Modal.Body className="gap-4">
          <Input
            id={reasonFieldId}
            label={t('orgs.confirm.reasonLabel')}
            helperText={t('orgs.confirm.reasonHint')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {t('orgs.confirm.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            // The reason gate, client-side. The enforcing copy is in the audit
            // vocabulary's reason policy — see the header.
            disabled={reason.trim().length === 0}
          >
            {t(`orgs.confirm.${dialogKey}.confirm`)}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
