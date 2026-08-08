'use client';

import { useTranslations } from 'next-intl';
import { Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { BuildInPublicDialog } from '@/app/(authed)/settings/project/members/_components/BuildInPublicDialog';
import { useGoPublic } from './useGoPublic';

/**
 * BuildInPublicButton (Story 6.17 · Subtask 6.17.3) — the PRIMARY, promoted
 * entry point: a persistent build-tinted action in the project-shell header
 * (`.btn-build`, design/public-projects Panel 10a). It is the obvious, never
 * buried home for "turn this project public", visible to project admins on
 * every project view while the project is NOT yet public.
 *
 * It is rendered by TopNav ONLY when the active project is non-public and the
 * actor can manage it (the gate is resolved server-side in the layout, so this
 * client component never has to know the access level itself — it just renders
 * the trigger). It shares the SAME header slot that the 6.17.4 "Building in
 * public" status badge takes once the project is public, so the affordance is
 * stateful, never duplicated.
 *
 * One click opens the reusable explainer/confirm dialog (6.17.2); confirming
 * runs the `setAccessLevel('public')` write via `useGoPublic`.
 *
 * `placement` is WHERE the slot renders (MOTIR-2373 · design/shell
 * design-notes.md § *Every control's disposition below `md`*). The whole
 * build-in-public slot is DISPLACED from the below-`md` bar — a status stripped
 * of its label is not a status, and this control's label was the one in the bar
 * that was never breakpoint-gated (117px at 375px, which is what made the public
 * project the widest surface in the product). So `'bar'` is `hidden
 * md:inline-flex` with a `lg`-gated label; `'drawer'` renders it unconditionally
 * in `SidebarDrawer`'s utility strip, LABELLED, where there is width for it.
 */
export function BuildInPublicButton({
  projectKey,
  placement = 'bar',
}: {
  projectKey: string;
  placement?: 'bar' | 'drawer';
}) {
  const t = useTranslations('settings.buildInPublic');
  const { open, setOpen, pending, confirm } = useGoPublic(projectKey);
  const inDrawer = placement === 'drawer';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Between `md` and `lg` the bar renders this icon-only, so the label
        // cannot be the accessible name there.
        aria-label={t('entryButton')}
        className={cn(
          'h-9 items-center gap-2 rounded-(--radius-btn) border border-transparent bg-(--el-build-bg) px-2.5 font-sans text-sm font-medium text-(--el-text-strong) transition-colors hover:bg-[color-mix(in_srgb,var(--el-accent)_18%,var(--el-page-bg))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
          // Selected, not appended — equal specificity with `.hidden`.
          inDrawer ? 'inline-flex' : 'hidden md:inline-flex',
          inDrawer && 'min-w-0 max-w-full',
        )}
      >
        <Megaphone className="h-4 w-4 shrink-0 text-(--el-build-glyph)" aria-hidden />
        <span className={cn('truncate', !inDrawer && 'hidden lg:inline')}>{t('entryButton')}</span>
      </button>
      <BuildInPublicDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        pending={pending}
      />
    </>
  );
}
