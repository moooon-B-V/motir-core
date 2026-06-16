'use client';

import { useTranslations } from 'next-intl';
import { Megaphone } from 'lucide-react';
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
 */
export function BuildInPublicButton({ projectKey }: { projectKey: string }) {
  const t = useTranslations('settings.buildInPublic');
  const { open, setOpen, pending, confirm } = useGoPublic(projectKey);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-2 rounded-(--radius-sm) border border-transparent bg-(--el-build-bg) px-2.5 font-sans text-sm font-medium text-(--el-text-strong) transition-colors hover:bg-[color-mix(in_srgb,var(--el-accent)_18%,var(--el-page-bg))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <Megaphone className="h-4 w-4 text-(--el-build-glyph)" aria-hidden />
        <span className="hidden sm:inline">{t('entryButton')}</span>
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
