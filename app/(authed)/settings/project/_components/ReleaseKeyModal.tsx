'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { ProjectDTO } from '@/lib/dto/projects';
import { releaseProjectKeyAction } from '../actions';

// The release-alias confirm (Story 6.8 · Subtask 6.8.4) — the Jira Cloud
// "Previous project keys" remove, per `design/projects/details.mock.html` panel
// 4. The archive-confirm danger grammar (TriangleAlert in a tint-rose circle +
// a danger Button) with NO typed-arm step — the broken-links consequence is the
// gate (parity with the components/automation delete confirms). Releasing
// un-reserves the key and breaks its old links; success → toast +
// `router.refresh()`.

export interface ReleaseKeyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The retired key being released (e.g. `PROD`). */
  alias: string;
  onSuccess?: (project: ProjectDTO) => void;
}

export function ReleaseKeyModal({ open, onOpenChange, alias, onSuccess }: ReleaseKeyModalProps) {
  const t = useTranslations('settings.details');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  function handleRelease() {
    startTransition(async () => {
      const result = await releaseProjectKeyAction(alias);
      if (result.ok) {
        onOpenChange(false);
        toast({ variant: 'success', title: t('releasedToast', { ident: alias }) });
        onSuccess?.(result.project);
        router.refresh();
      } else {
        onOpenChange(false);
        toast({ variant: 'error', title: t('releaseErrorTitle') });
      }
    });
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="md">
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose)"
        >
          <TriangleAlert className="h-5 w-5 text-(--el-danger)" />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('releaseTitle', { ident: alias })}
          </h2>
          <p className="mt-1 font-sans text-sm text-(--el-text-muted)">
            {t('releaseBody', { ident: alias })}
          </p>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
          {tc('cancel')}
        </Button>
        <Button variant="danger" onClick={handleRelease} loading={isPending}>
          {t('releaseButton')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
