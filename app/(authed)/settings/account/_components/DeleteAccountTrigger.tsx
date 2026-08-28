'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { AccountErasurePreviewDTO } from '@/lib/dto/accountErasure';
import { DeleteAccountConfirmModal } from './DeleteAccountConfirmModal';

// The `Delete account` control and the confirmation it opens (Story 8.4 ·
// Subtask MOTIR-3704). MOTIR-1136 shipped this button DRAWN AND NOT WIRED, and
// said why: *"the ledger is what makes an irreversible write safe to reach, and
// giving the write a door before the confirmation that gates it exists would be
// exactly backwards."* This is the wiring, arriving with the ledger.
//
// The smallest possible client island: `DeleteAccountCard` stays a SERVER
// component (everything else it draws is a pure function of the impact preview),
// and only the open/closed state of the dialog lives here.

export interface DeleteAccountTriggerProps {
  label: string;
  /** `true` while an organization's last-owner guard blocks the erasure. */
  disabled: boolean;
  preview: AccountErasurePreviewDTO;
  email: string;
  /** Server-computed `erasureDueAt(now)` — see the modal's clock note. */
  projectedErasureDueAt: string;
}

export function DeleteAccountTrigger({
  label,
  disabled,
  preview,
  email,
  projectedErasureDueAt,
}: DeleteAccountTriggerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="danger"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        leftIcon={<Trash2 className="h-4 w-4" />}
      >
        {label}
      </Button>
      {/* Mounted only once the reader has asked for it: the ledger renders the
          whole preview, and a blocked reader never reaches it at all. */}
      {open ? (
        <DeleteAccountConfirmModal
          open={open}
          onOpenChange={setOpen}
          preview={preview}
          email={email}
          projectedErasureDueAt={projectedErasureDueAt}
        />
      ) : null}
    </>
  );
}
