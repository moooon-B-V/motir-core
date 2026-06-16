'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/Toast';

// useGoPublic (Story 6.17 · Subtask 6.17.3) — the shared confirm + write the
// three discoverable entry points (the project-shell header button, the
// dismissible nudge, and the Settings → General promo card) all reuse. Each
// entry point renders its own trigger markup + the reusable
// `BuildInPublicDialog` (6.17.2), and drives both from this one hook so the
// access mutation has a single implementation:
//   • `setOpen` opens / closes the explainer/confirm dialog;
//   • `confirm` runs the actual write — `PATCH /api/projects/[key]/access`
//     with `accessLevel: 'public'`, the shipped 6.4 `setAccessLevel` path
//     (Story 6.17.2: reframe the label, never fork the model);
//   • on success it toasts, closes the dialog, and `router.refresh()`es so the
//     SERVER-gated surfaces re-render — the header button + nudge + promo card
//     disappear (the project is now `public`) and the 6.17.4 "Building in
//     public" status badge takes the same header slot. The entry points are
//     conditionally rendered server-side on `accessLevel`, so a single
//     `router.refresh()` is the whole page-state-after-mutation story (no
//     client island owns the visibility — CLAUDE.md "Page state after a
//     mutation").
export function useGoPublic(projectKey: string) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations('settings');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/projects/${projectKey}/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessLevel: 'public' }),
      });
      if (!res.ok) throw new Error('ACCESS_WRITE_FAILED');
      toast({
        variant: 'success',
        title: t('access.levelChangedToast', { level: t('access.level.public') }),
      });
      setOpen(false);
      // Re-run the server tree: the entry points (header / nudge / promo) are
      // gated on the now-`public` access level and vanish; the 6.17.4 badge
      // takes the header slot. router.refresh reaches every server-rendered
      // surface here — none is a client island holding the access state.
      router.refresh();
    } catch {
      toast({
        variant: 'error',
        title: t('access.changeAccessErrorTitle'),
        description: t('access.errorGeneric'),
      });
    } finally {
      setPending(false);
    }
  }

  return { open, setOpen, pending, confirm };
}
