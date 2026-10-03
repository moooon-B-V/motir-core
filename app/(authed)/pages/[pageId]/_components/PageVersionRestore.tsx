'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { PageVersionDto, RestorePageVersionResultDto } from '@/lib/dto/pages';

// RESTORE from the history panel (Story MOTIR-5754 · MOTIR-7388), mounted in
// `PageVersionView`'s slot and drawn by `design/pages/page--history.mock.html`
// states 7–13.
//
// It only asks and reports. The restore itself is computed on the server as a
// Yjs update merged into the stored state, so the client never sends the
// version's content back: it POSTs the number and hands the server's resulting
// state to `PageView`, which remounts the live editor on it.
//
// ⚠️ HELD WHILE EDITS ARE UNSAVED (state 13). Remounting the editor over an
// unsaved offline buffer would discard the writer's own edits — the thing the
// host's leave guard exists to protect — and a restore over a pending save would
// race it. So while the live status is not `saved` the button is disabled and
// described by the hold line `PageView` draws under the version's head.

export type RestoreRefusal = 'tooLarge' | 'gone' | 'failed';

export interface PageVersionRestoreProps {
  pageId: string;
  version: PageVersionDto;
  /** The live editor has unsaved edits. */
  held: boolean;
  /** This version was refused as too large; it would fail the same way again. */
  refused: boolean;
  /** The id of the line that explains a disabled Restore. */
  describedBy?: string;
  /** A restore is in flight — the panel goes inert. */
  onBusyChange: (busy: boolean) => void;
  onRestored: (result: RestorePageVersionResultDto, from: number) => void;
  onRefused: (refusal: RestoreRefusal, number: number) => void;
}

async function postRestore(
  pageId: string,
  number: number,
): Promise<RestorePageVersionResultDto | RestoreRefusal> {
  try {
    const res = await fetch(`/api/pages/${encodeURIComponent(pageId)}/versions/${number}/restore`, {
      method: 'POST',
    });
    const body = (await res.json()) as RestorePageVersionResultDto | { code?: unknown };
    if (res.ok) return body as RestorePageVersionResultDto;
    if (res.status === 413) return 'tooLarge';
    return 'code' in body && body.code === 'PAGE_VERSION_NOT_FOUND' ? 'gone' : 'failed';
  } catch {
    return 'failed';
  }
}

export function PageVersionRestore({
  pageId,
  version,
  held,
  refused,
  describedBy,
  onBusyChange,
  onRestored,
  onRefused,
}: PageVersionRestoreProps) {
  const t = useTranslations('pages.history');
  const tCommon = useTranslations('common');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const number = version.number;

  const confirm = async () => {
    setPending(true);
    onBusyChange(true);
    const result = await postRestore(pageId, number);
    setPending(false);
    onBusyChange(false);
    setConfirming(false);
    if (typeof result === 'string') onRefused(result, number);
    else onRestored(result, number);
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
        disabled={held || refused}
        aria-describedby={held || refused ? describedBy : undefined}
        onClick={() => setConfirming(true)}
      >
        {t('restore')}
      </Button>
      <Modal
        open={confirming}
        // A restore cannot be abandoned half way: while it is in flight nothing closes it.
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
        size="sm"
        role="alertdialog"
        title={t('confirm.title', { number })}
        description={t('confirm.body', { number })}
      >
        <Modal.Footer>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => setConfirming(false)}
            autoFocus
          >
            {tCommon('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={pending}
            aria-busy={pending || undefined}
            leftIcon={<RotateCcw className="h-4 w-4" />}
            onClick={() => void confirm()}
          >
            {pending ? t('restoring') : t('confirm.action', { number })}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
