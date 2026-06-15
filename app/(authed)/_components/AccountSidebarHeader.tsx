'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';

// The account-settings-area rail header (Story 7.8 · Subtask 7.8.12). When the
// rail is in the account-settings area it REPLACES the SidebarHeader/ProjectSwitcher
// with a "← Back to Motir" link + the signed-in user's identity (initial avatar +
// name + email) + an "Account settings" eyebrow — per
// `design/settings/account-settings.mock.html` (the `.rail-head` panel). The
// account area is PERSONAL (no project context), which is why the header shows the
// user rather than the project (the SettingsSidebarHeader's shape, retargeted).
// Back goes to the app home (the dashboard reads the active project context).

const BACK_HREF = '/dashboard';

export interface AccountSidebarHeaderProps {
  user: { name: string; email: string };
  /** When true, render the icon-only (collapsed rail) affordance. */
  collapsed?: boolean;
}

/** The signed-in user's circular initial tile — mirrors the UserMenu avatar
 *  grammar (ink fill, inverted text, circular). `rounded-full` is a genuine
 *  circle, so it stays raw (not a shape token). */
function UserAvatar({ initial, size }: { initial: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-(--el-text) font-sans text-[13px] font-semibold text-(--el-text-inverted)"
    >
      {initial}
    </span>
  );
}

export function AccountSidebarHeader({ user, collapsed = false }: AccountSidebarHeaderProps) {
  const t = useTranslations('settings.account');
  const backLabel = t('back');
  const displayName = user.name || user.email;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  // Collapsed rail (56px): a back-arrow icon button (tooltip) above the user
  // tile, mirroring the SettingsSidebarHeader collapsed treatment.
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2">
        <Tooltip content={backLabel} side="right">
          <Link
            href={BACK_HREF}
            aria-label={backLabel}
            className={cn(
              'flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control)',
              'text-(--el-text-muted) transition-colors hover:bg-(--el-sidebar-item-bg-hover) hover:text-(--el-text)',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
            )}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </Tooltip>
        <UserAvatar initial={initial} size={32} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Link
        href={BACK_HREF}
        className={cn(
          'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x)',
          'font-sans text-[13px] font-medium text-(--el-text-secondary) transition-colors',
          'hover:bg-(--el-sidebar-item-bg-hover) hover:text-(--el-text)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
        )}
      >
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{backLabel}</span>
      </Link>

      <div className="flex items-center gap-2.5 px-(--spacing-control-x) pb-0.5 pt-1.5">
        <UserAvatar initial={initial} size={30} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-[13.5px] font-semibold text-(--el-text)">
            {displayName}
          </span>
          {user.name ? (
            <span className="truncate font-sans text-[11px] text-(--el-text-secondary)">
              {user.email}
            </span>
          ) : null}
        </span>
      </div>

      {/* Eyebrow on the sidebar surface (#f6f5f4): --el-text-faint/-muted both
          undershoot WCAG AA at 11px, so use --el-text-secondary (AA-safe). */}
      <span className="px-(--spacing-control-x) font-sans text-[11px] font-semibold uppercase tracking-[0.02em] text-(--el-text-secondary)">
        {t('eyebrow')}
      </span>
    </div>
  );
}
