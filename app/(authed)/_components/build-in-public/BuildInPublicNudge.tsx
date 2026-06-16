'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Rocket, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { BuildInPublicDialog } from '@/app/(authed)/settings/project/members/_components/BuildInPublicDialog';
import { useBuildInPublicNudge } from '@/lib/hooks/useBuildInPublicNudge';
import { useGoPublic } from './useGoPublic';

// BuildInPublicNudge (Story 6.17 · Subtask 6.17.3 · design Panel 10b) — a
// dismissible, one-time project-shell nudge that REINFORCES the persistent
// header button (BuildInPublicButton) with context. A richer prompt — rocket
// glyph, a title + sub, and a "Start building in public" primary CTA — shown
// once to project admins on a non-public project; the header button remains
// after it's dismissed.
//
// Rendered by the authed shell ONLY when the active project is non-public and
// the actor can manage it (the access + manage gate is resolved server-side in
// the layout). Two further client-only gates:
//   • DISMISSAL is persisted per-project in localStorage via the
//     `useBuildInPublicNudge` store (SSR-safe useSyncExternalStore, the
//     useCommentsSort pattern) — SSR paints it hidden, so a dismissed nudge
//     never flashes and the markup never mismatches.
//   • It is suppressed on the SETTINGS area, whose General page already carries
//     the durable promo card (Panel 10c) — no double CTA on the same page.

export function BuildInPublicNudge({ projectKey }: { projectKey: string }) {
  const t = useTranslations('settings.buildInPublic');
  const pathname = usePathname();
  const { open, setOpen, pending, confirm } = useGoPublic(projectKey);
  const [dismissed, dismiss] = useBuildInPublicNudge(projectKey);

  // The promo card owns the settings surface — don't double up there.
  if (dismissed || pathname.startsWith('/settings')) return null;

  return (
    <>
      <div className="mb-4 flex items-center gap-3 rounded-(--radius-card) border border-(--el-border) border-l-[3px] border-l-(--el-accent) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
        <Rocket className="size-[18px] shrink-0 text-(--el-accent)" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-sm font-semibold text-(--el-text)">{t('nudgeTitle')}</p>
          <p className="font-sans text-xs text-(--el-text-muted)">{t('nudgeSub')}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
          {t('confirmCta')}
        </Button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('nudgeDismiss')}
          className="inline-flex shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) transition-colors hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <BuildInPublicDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        pending={pending}
      />
    </>
  );
}
