'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { cancelAccountDeletionAction } from '@/app/(authed)/_account-deletion-actions';

// `Cancel deletion`, on the PANE — the first of design DECISION 4's two doors
// (Story 8.4 · Subtask MOTIR-3704). The second is the app-wide banner, which
// owns its own button because it also owns its own disappearance; see
// `app/(authed)/_components/AccountDeletionBanner.tsx`.
//
// ── THE PAGE-STATE ROUTE, STATED ────────────────────────────────────────────
// This button's surroundings — the scheduled card here, and the banner in the
// layout above — are BOTH server-rendered, so `router.refresh()` re-runs their
// reads and repaints them (CLAUDE.md's page-state contract, route 2). There is
// deliberately no optimistic local state here: the card this sits in is not a
// client island holding a copy of the request, so there is nothing a refresh
// cannot reach, and inventing one would be a second source of truth for the
// same row.
//
// ⚠️ NO `revalidatePath` SUBSTITUTE. The action revalidates the pane's own path,
// which is what a later navigation gets; the refresh is what updates the tree
// on screen NOW, including the banner mounted in the shell above it.

export interface CancelAccountDeletionButtonProps {
  label: string;
}

export function CancelAccountDeletionButton({ label }: CancelAccountDeletionButtonProps) {
  const t = useTranslations('settings.account.data.delete.grace');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  function cancel(): void {
    startTransition(async () => {
      const result = await cancelAccountDeletionAction();
      if (result.ok) {
        toast({ variant: 'success', title: t('cancelled') });
        router.refresh();
        return;
      }
      toast({ variant: 'error', title: t('error') });
    });
  }

  return (
    <Button variant="secondary" size="sm" onClick={cancel} loading={isPending} className="shrink-0">
      {label}
    </Button>
  );
}
