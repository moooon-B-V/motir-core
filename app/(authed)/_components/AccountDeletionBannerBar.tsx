'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { cancelAccountDeletionAction } from '../_account-deletion-actions';

// The bar itself — `design/settings/account-data.mock.html` PANEL 5's
// `.appbanner`, and the SECOND of design DECISION 4's two cancel doors
// (Story 8.4 · Subtask MOTIR-3704).
//
// ── THE PAGE-STATE ROUTE THIS COMPONENT IMPLEMENTS ──────────────────────────
// Its PARENT is a server component in the layout (route 2 of CLAUDE.md's
// page-state contract), which is what makes a cancel from the OTHER door — the
// pane, one route below — able to clear this bar at all: `router.refresh()`
// re-runs the layout's read and the bar stops being rendered. A client island
// seeded from `useState(initialProps)` could not be reached that way, and a
// stale *"your account will be deleted"* banner after a successful cancel is
// precisely the failure this surface must not have.
//
// ⚠️ SO WHY IS THERE LOCAL STATE HERE AT ALL? Because when the mutation fires
// from INSIDE this island, the contract's route 3 also applies: an optimistic
// local removal, which is legitimate exactly because this island is the one
// making the change. It buys the round trip — the bar goes on the click rather
// than on the refresh — and it is a LATENCY affordance layered on top of the
// server route, never the mechanism. If the action fails the bar comes straight
// back, because the server read is still the truth and `dismissed` is reset.
//
// It renders NOTHING of its own from a clock or a row: the message and the
// label arrive as finished strings from the server parent, so the `30`-day
// window and the erasure date have exactly one source (the request row) and
// this component cannot drift from it.

export interface AccountDeletionBannerBarProps {
  /** The finished sentence, with the row's date already interpolated. */
  message: string;
  cancelLabel: string;
}

export function AccountDeletionBannerBar({ message, cancelLabel }: AccountDeletionBannerBarProps) {
  const t = useTranslations('settings.account.data.delete.grace');
  const router = useRouter();
  const { toast } = useToast();

  const [dismissed, setDismissed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  function cancel(): void {
    // The optimistic half (route 3). Set BEFORE the await so the bar goes on
    // the click; restored below if the server disagrees.
    setDismissed(true);
    startTransition(async () => {
      const result = await cancelAccountDeletionAction();
      if (result.ok) {
        toast({ variant: 'success', title: t('cancelled') });
        // The authoritative half (route 2): re-runs the layout's server read,
        // so the bar is gone because the ROW is gone — and the pane below,
        // also server-rendered, repaints out of its scheduled state in the
        // same pass. No reload.
        router.refresh();
        return;
      }
      setDismissed(false);
      toast({ variant: 'error', title: t('error') });
    });
  }

  return (
    <div
      // `status` rather than `alert`: it is standing information about the
      // account, present on arrival, not an interruption raised mid-task.
      role="status"
      data-testid="account-deletion-banner"
      className="flex items-center justify-center gap-3 border-b border-(--el-border) bg-(--el-tint-rose) px-4 py-2 text-center font-sans text-sm text-(--el-text-strong)"
    >
      <Clock aria-hidden className="h-4 w-4 shrink-0 text-(--el-danger)" />
      <span className="min-w-0">{message}</span>
      <Button variant="ghost" size="sm" onClick={cancel} loading={isPending} className="shrink-0">
        {cancelLabel}
      </Button>
    </div>
  );
}
