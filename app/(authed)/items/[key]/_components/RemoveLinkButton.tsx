'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';
import { removeLinkAction } from '../actions';

// The per-row remove affordance on the relationships panel (Subtask 2.4.9), per
// the links mockup: a quiet × button that opens a confirm popover ("…the issue
// isn't deleted — only the link"). On confirm, `removeLinkAction` deletes the
// edge (+ the reciprocal `relates_to` row) and revalidates the detail path;
// `router.refresh()` re-renders the panel + readiness banner. AA-safe: muted by
// default, danger tint on hover.

export function RemoveLinkButton({
  linkId,
  identifier,
  relationshipLabel,
  targetIdentifier,
}: {
  linkId: string;
  identifier: string;
  relationshipLabel: string;
  targetIdentifier: string;
}) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await removeLinkAction({ linkId, identifier });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <Popover.Trigger
        className="text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
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
            <p className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-md px-2.5 py-1.5 font-sans text-xs">
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
