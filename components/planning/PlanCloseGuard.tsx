'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

// THE CLOSE-WITH-PENDING GUARD (MOTIR-4731, under story MOTIR-4725).
//
// `design/ai-chat/design-notes.md` § *Opening & exiting* → *The CLOSE-WITH-PENDING
// guard* specified this from the first draw and nothing built it. On a ROUTE it
// mattered less — leaving a page is a deliberate act. As an OVERLAY the workspace
// closes on `Esc`, on a click beside it and on Back: three ways to lose a
// proposal by accident, which is why the guard ships with the overlay rather
// than after it.
//
// ⚠️ `role="alertdialog"`, not `dialog` — the destructive-confirm precedent
// (Subtask 2.8.4). Assistive tech should INTERRUPT here: the reader is one
// keystroke from discarding work they watched being made.
//
// ⚠️ THE COUNT IS IN THE COPY. *"Discard the proposals"* and *"discard 5 work
// items you just watched appear"* are different sentences, and only one of them
// tells the reader what they are about to lose.
//
// A dialog above a dialog: this sits over the full-size workspace dialog, which
// Radix supports. Focus moves in when it opens and returns to the workspace on
// *Keep planning*; its own `Esc` dismisses THE GUARD, never the workspace —
// otherwise the key that raised the question would also answer it.

export interface PlanCloseGuardProps {
  open: boolean;
  /** How many work items the pending proposal touches. */
  count: number;
  /** An approve or a discard is in flight — both are server writes. */
  deciding: boolean;
  /** Dismiss the guard and stay in the workspace. */
  onKeepPlanning: () => void;
  /** Drop the proposal, then close. */
  onDiscard: () => void;
  /** Commit the proposal; close on success, stay open on failure. */
  onConfirm: () => void;
}

export function PlanCloseGuard({
  open,
  count,
  deciding,
  onKeepPlanning,
  onDiscard,
  onConfirm,
}: PlanCloseGuardProps) {
  const t = useTranslations('planningWorkspace.closeGuard');

  return (
    <Modal
      open={open}
      // Esc and the scrim both arrive here, and both mean *Keep planning*: the
      // guard goes, the workspace stays, the proposal is untouched. Never a
      // discard — the safe answer is the one that loses nothing.
      onOpenChange={(next) => {
        if (!next && !deciding) onKeepPlanning();
      }}
      role="alertdialog"
      size="md"
      title={t('title', { count })}
      description={t('body')}
      // The reader must ANSWER. Dismissing by the corner ✕ would be a fourth
      // answer that looks like a cancel and reads like a discard.
      hideClose
    >
      <Modal.Footer className="flex-wrap">
        {deciding ? <Spinner size="sm" aria-hidden="true" className="mr-auto" /> : null}
        {/* The one legal use of `--el-danger-text`: ink ON a danger fill
            (`motir-core/CLAUDE.md` § the danger rule). */}
        <Button variant="danger" size="sm" onClick={onDiscard} disabled={deciding}>
          {t('discard', { count })}
        </Button>
        <Button variant="ghost" size="sm" onClick={onKeepPlanning} disabled={deciding}>
          {t('keepPlanning')}
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} disabled={deciding}>
          {t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
