'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';

// `Cancel deletion` and its confirm (Story MOTIR-6306 · MOTIR-6402, design
// MOTIR-6390 panel 4b → panel 7). Two doors open it: the Owner's scheduled row in
// the Danger zone, and the Owner's closing bar above every page (MOTIR-6403) — so
// it lives once, here, and each door picks its button's look.
//
// ⚠️ PAGE STATE AFTER THE MUTATION (motir-core/CLAUDE.md, case 2): the scheduled
// row, the Danger zone and the closing bar are all SERVER-rendered, so success is
// a `router.refresh()`. There is no local copy of the request to patch.

export function CancelOrganizationDeletionControl({
  orgId,
  orgName,
  variant = 'secondary',
  size = 'md',
}: {
  orgId: string;
  orgName: string;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('orgAdmin');
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [isPending, startTransition] = useTransition();

  function cancel(): void {
    setError(false);
    startTransition(async () => {
      let ok = false;
      try {
        const res = await fetch(`/api/organizations/${orgId}/deletion`, { method: 'DELETE' });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        setError(true);
        return;
      }
      setOpen(false);
      toast({ variant: 'success', title: t('cancel.success', { org: orgName }) });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        className="shrink-0"
        data-testid="org-deletion-cancel"
      >
        {t('scheduled.cancel')}
      </Button>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => {
            if (!o && !isPending) setOpen(false);
          }}
          size="sm"
          srTitle={t('cancel.title', { org: orgName })}
        >
          <div className="flex items-start gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-muted)">
              <RotateCcw className="h-5 w-5 text-(--el-text-strong)" aria-hidden />
            </span>
            <div>
              <h2 className="font-serif text-xl font-semibold text-(--el-text)">
                {t('cancel.title', { org: orgName })}
              </h2>
              <p className="mt-1 font-sans text-sm text-(--el-text-secondary)">
                {t('cancel.body')}
              </p>
            </div>
          </div>
          {error ? (
            <div
              role="alert"
              className="mt-(--spacing-md) flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-3 font-sans text-sm text-(--el-text-strong)"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
              <span>{t('cancel.error')}</span>
            </div>
          ) : null}
          <Modal.Footer>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              {t('cancel.keep')}
            </Button>
            <Button variant="primary" onClick={cancel} loading={isPending}>
              {t('cancel.confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
