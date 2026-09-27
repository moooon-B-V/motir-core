'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

// CANCEL RUN for a live HOSTED run (Story MOTIR-683 · MOTIR-691;
// `design/runs/design-notes.md` § CANCEL) — in the Run section's header and beside
// the run modal's pill, never on a local run: that one is on somebody's machine,
// and Ctrl-C is theirs.
//
// ⚠️ A CONFIRM, because the act cannot be undone. `Keep running` takes the focus.
// The copy names what the end path does (MOTIR-6450) — and, under the run-dies
// decision, that the work item STAYS where it is: a cancel moves no card.
//
// The caller decides what a cancel refreshes (the page-state contract): the run
// section bumps its tick and refreshes the server surfaces; the modal re-reads
// the run.

export function HostedRunCancel({
  runId,
  onCancelled,
}: {
  runId: string;
  onCancelled: () => void;
}) {
  const t = useTranslations('runs.hosted.cancel');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/dispatch-runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      // 409 — the run already ended (it finished while the dialog was open): the
      // outcome the reader wanted is already true, so it closes like a success.
      if (res.ok || res.status === 409) {
        setOpen(false);
        onCancelled();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="hosted-run-cancel"
      >
        {t('button')}
      </Button>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => (!o && !busy ? setOpen(false) : undefined)}
          title={t('title')}
          description={t('body')}
          size="sm"
          role="alertdialog"
        >
          {failed ? (
            <p role="alert" className="text-sm text-(--el-danger-on-surface)">
              {t('failed')}
            </p>
          ) : null}
          <Modal.Footer>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              autoFocus
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('keep')}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={busy}
              onClick={() => void confirm()}
              data-testid="hosted-run-cancel-confirm"
            >
              {t('confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
