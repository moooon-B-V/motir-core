'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut, Settings, Shield, UserCog } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { signOut } from '@/lib/auth/client';

export interface UserMenuProps {
  name: string;
  email: string;
  /**
   * The acting user is platform staff — renders the staff-only "Platform admin"
   * row, the single door into the operator console (design
   * `platform-admin/console.mock.html` Panel 1).
   *
   * ⚠️ ABSENT for non-staff, not disabled and not CSS-hidden: the row is not
   * RENDERED, so no markup anywhere names `/admin`. That is half of the
   * 404-not-403 posture (`docs/decisions/platform-staff-auth.md` §2 / §4) — the
   * other half is the route itself answering 404 — and a hidden-but-present row
   * would defeat it in the one place a curious tenant would look first.
   *
   * Resolved SERVER-side in the authed layout from the `platformRole` column;
   * this component receives a boolean and trusts nothing else. A client that
   * flipped it would see a menu row leading to a route that 404s them.
   */
  platformStaff?: boolean;
  /**
   * The active org reveals the WORKSPACE tier (≥2 workspaces the viewer belongs
   * to — `lib/workspaces/tierDisclosure.ts`). Gates the "Workspace settings"
   * row, which is the one entry point in this menu that NAMES the tier.
   *
   * ⚠️ ABSENT below the threshold, not disabled — the same posture as
   * `platformStaff` above, for the same reason: no markup anywhere may name
   * `/settings/workspace` while the product is telling the user that tier does
   * not exist yet (`docs/decisions/organization-tier.md` §6d). A row that is
   * present-but-dimmed still teaches the concept, which is exactly what the
   * collapsed state is for.
   *
   * Settings stay reachable at every count: this menu keeps its Account row, the
   * org control's first row is `/settings/organization`, and at one workspace
   * that page HOSTS the folded-in workspace sections.
   *
   * Defaults FALSE — an omitted prop hides the row rather than leaking it, so a
   * caller that forgets to thread the count fails closed.
   */
  workspaceTierRevealed?: boolean;
}

export function UserMenu({
  name,
  email,
  platformStaff = false,
  workspaceTierRevealed = false,
}: UserMenuProps) {
  const t = useTranslations('shell');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const initial = (name || email).trim().charAt(0).toUpperCase() || '?';

  function handleSignOut() {
    startTransition(async () => {
      await signOut();
      // Drop the in-memory router cache and bounce to sign-in; the proxy
      // would redirect anyway once the session cookie is gone.
      router.push('/sign-in');
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('userMenu.account')}
          // SLOT 4 of the bar's four-slot below-`md` budget (MOTIR-2373). The
          // box is `--height-control` square, not `h-9`: at 375px the avatar
          // used to measure 28px wide against a 36px height and render as an
          // ELLIPSE, because a shrinking flex row squeezed a fixed `w-9`.
          className="bg-(--el-text) text-(--el-text-inverted) focus-visible:ring-(--focus-ring-color) inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-full font-sans text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {initial}
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" width={240} className="py-1">
        <div className="border-(--el-border) mb-1 border-b px-3 pb-2 pt-2">
          <p className="truncate font-sans text-sm font-medium text-(--el-text)">{name || email}</p>
          {name ? (
            <p className="text-(--el-text-muted) truncate font-sans text-xs">{email}</p>
          ) : null}
        </div>
        <div className="px-1">
          <a
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
          >
            <UserCog className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {t('userMenu.accountSettings')}
          </a>
          {workspaceTierRevealed ? (
            <a
              href="/settings/workspace"
              onClick={() => setOpen(false)}
              className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
            >
              <Settings className="text-(--el-text-muted) h-4 w-4" aria-hidden />
              {t('userMenu.workspaceSettings')}
            </a>
          ) : null}
          {platformStaff ? (
            <>
              <div role="separator" className="my-1 border-t border-(--el-border)" />
              <a
                href="/admin"
                onClick={() => setOpen(false)}
                className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-start gap-2 rounded-(--radius-control) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
              >
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block">{t('userMenu.platformAdmin')}</span>
                  <span className="block text-xs text-(--el-text-secondary)">
                    {t('userMenu.platformAdminHint')}
                  </span>
                </span>
                <Pill tone="neutral" className="mt-0.5 shrink-0">
                  {t('userMenu.staffOnly')}
                </Pill>
              </a>
              <div role="separator" className="my-1 border-t border-(--el-border)" />
            </>
          ) : null}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isPending}
            className={cn(
              'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <LogOut className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {isPending ? t('userMenu.signingOut') : t('account.signOut')}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
