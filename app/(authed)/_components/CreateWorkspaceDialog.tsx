'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { entitlementExceededMessage } from '@/lib/billing/entitlementCopy';
import { createWorkspaceAction } from '../_actions';

// THE create-workspace dialog behind BOTH org-tier doors (MOTIR-6312 ·
// `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 1a): the
// org menu's `New workspace` row and the org settings page's Workspaces card.
// The design says they open the SAME dialog, so it is one component rather than
// a second copy in the card — it was `OrgControl`'s private name modal until the
// card needed it too.
//
// It is only ever MOUNTED for someone holding `manageWorkspaces`: both doors
// render for an Owner or Admin alone, and the server refuses anyone else
// (`workspacesService.createWorkspace`, MOTIR-6309).
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a successful create — the caller decides what to refresh. */
  onCreated: () => void;
}) {
  const t = useTranslations('orgAdmin');
  const ts = useTranslations('shell');
  const tc = useTranslations('common');
  const tErr = useTranslations('errors');
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit() {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      try {
        const result = await createWorkspaceAction(value);
        if (!result.ok) {
          // MOTIR-5130 — a §4.4 cap refusal comes back as a VALUE, not a throw.
          // Nothing was created, so the dialog stays open with the name intact
          // while the plan limit is named — in the reader's language, picked by
          // the `entitlement` kind rather than the server's English (MOTIR-5133).
          toast({ variant: 'error', title: entitlementExceededMessage(tErr, result.entitlement) });
          return;
        }
        setName('');
        onOpenChange(false);
        onCreated();
      } catch {
        toast({ variant: 'error', title: t('settings.saveError') });
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setName('');
        onOpenChange(o);
      }}
      title={t('menu.newWorkspace')}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          label={ts('workspaceSwitcher.nameLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" type="submit" loading={isPending} disabled={!name.trim()}>
            {t('menu.newWorkspace')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
