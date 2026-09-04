'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';
import type { RemoveLinkActionResult } from '../actions';

// The per-row remove affordance on the relationships panel (Subtask 2.4.9), per
// the links mockup: a quiet × button that opens a confirm popover ("…the issue
// isn't deleted — only the link"). AA-safe: muted by default, danger tint on
// hover.
//
// MOTIR-4496: this control no longer performs the write. `onRemove` is the
// panel's, and the panel drops the row OPTIMISTICALLY before the request leaves
// — so the row is gone by the time this popover closes, instead of when a
// whole-page `router.refresh()` lands.
//
// ⚠️ WHICH IS WHY THE ERROR IS NOT LOCAL STATE ANY MORE. The optimistic
// removal unmounts this component along with its row, so a message written into
// local state at the moment the write is REJECTED would be discarded by the
// rollback that puts the row back — the one case the message exists for. The
// panel holds it across that gap and hands it back as `error`, and this control
// re-opens its popover to show it, which is where the user last looked.

export function RemoveLinkButton({
  linkId,
  relationshipLabel,
  targetIdentifier,
  onRemove,
  error = null,
  onDismissError,
}: {
  linkId: string;
  relationshipLabel: string;
  targetIdentifier: string;
  /** The panel's optimistic remove — applies the local removal, awaits the
   *  Server Action, and rolls back on a non-2xx. */
  onRemove: (linkId: string) => Promise<RemoveLinkActionResult>;
  /** The message from a rolled-back removal of THIS link, held by the panel
   *  because this component was unmounted when it arrived. Non-null re-opens
   *  the confirm popover to show it. */
  error?: string | null;
  /** Retire that message — on dismiss, and on a fresh attempt. */
  onDismissError?: (linkId: string) => void;
}) {
  const t = useTranslations('issueViews');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(error !== null);
  const [isPending, setPending] = useState(false);

  // A rollback that did NOT unmount this row (the write failed fast enough that
  // React batched the two renders) still has to open the popover — the mount
  // initializer above only covers the case where it did. React's own
  // adjust-state-on-prop-change pattern, not an effect.
  const [lastError, setLastError] = useState(error);
  if (error !== lastError) {
    setLastError(error);
    if (error !== null) setOpen(true);
  }

  // ⚠️ NOT a `useTransition` any more (MOTIR-4496). `onRemove` applies its
  // optimistic removal synchronously, and an update made inside a transition is
  // non-urgent by definition — React is free to defer the very repaint this
  // card exists to make immediate. The pending flag is plain state instead; the
  // only transition left is the panel's own, around `router.refresh()`, where a
  // deferred render is exactly what is wanted.
  function confirm() {
    onDismissError?.(linkId);
    setPending(true);
    void (async () => {
      try {
        await onRemove(linkId);
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onDismissError?.(linkId);
      }}
    >
      <Popover.Trigger
        className="text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        aria-label={t('removeLinkAria', {
          relationship: relationshipLabel,
          target: targetIdentifier,
        })}
      >
        <X className="h-[15px] w-[15px]" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={300} align="end">
        <div className="flex flex-col gap-3 p-3.5">
          <p className="text-(--el-text) font-sans text-sm leading-snug">
            {t('removeConfirmBefore', { relationship: relationshipLabel.toLowerCase() })}{' '}
            <span className="font-mono text-xs">{targetIdentifier}</span>
            {t('removeConfirmAfter', { relationship: relationshipLabel.toLowerCase() })}
          </p>
          {error ? (
            <p className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-(--radius-control) px-2.5 py-1.5 font-sans text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              {tc('cancel')}
            </Button>
            <Button size="sm" variant="danger" onClick={confirm} loading={isPending}>
              {t('removeLink')}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}
