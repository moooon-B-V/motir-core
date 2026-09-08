'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The WORKSPACE-settings-area rail header (Story MOTIR-4843 · MOTIR-4846).
// The fourth of four, and written from the same pattern as its three siblings —
// `SettingsSidebarHeader` (the project), `AccountSidebarHeader` (the user) and
// `OrganizationSidebarHeader` (the organisation).
//
// The constant across all four is what the head NAMES: the tenant the area
// configures. Per `design/settings/workspace-settings.mock.html` (MOTIR-4844):
// a "← Back to Motir" link, the workspace's initial tile + name, and a
// "Workspace settings" eyebrow.
//
// ⚠️ IT IS STATIC, NOT A SWITCHER — and the workspace is the one tier where that
// was a real choice rather than the only option. The project area's head is a
// `ProjectSwitcher`, and the workspace HAS a switcher of its own. It is
// deliberately not used here: switching a workspace re-points the active project
// and NAVIGATES AWAY (`afterContextSwitchTarget`), so a switcher in a settings
// rail buries a context switch inside a configuration surface. The switcher
// stays in the top bar, where it already is and where it now also carries the
// door INTO this area.
//
// ⚠️ THE FOUR HEADS GO STALE AS A SET, which is the siblings' own recorded
// experience: `/dashboard` survived in two of them after MOTIR-2654 moved the
// signed-in landing to `/home`, because they are written from one pattern and
// nobody re-read the rest. So the back href is IMPORTED, never retyped
// (MOTIR-3373), and `tests/components/rail-head-back-link.test.tsx` is the guard
// on the rendered value in every rail variant.
const BACK_HREF = AUTHED_LANDING_PATH;

export interface WorkspaceSidebarHeaderProps {
  workspace: { name: string };
  /** When true, render the icon-only (collapsed rail) affordance. */
  collapsed?: boolean;
}

/** The workspace's initial tile. A SQUARE with `--radius-control`, matching the
 *  organisation's rather than the circle the project and account heads use — the
 *  circle is this product's PERSON grammar (avatars, the UserMenu), and a
 *  workspace is not a person. Its fill is `--el-tint-sky` where the
 *  organisation's is `--el-tint-lavender`, so a reader moving between the two
 *  rails tells the tiers apart by hue; the ink is `--el-text-strong`, the AA-safe
 *  pairing on a tint in both themes. */
function WorkspaceAvatar({ initial, size }: { initial: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) font-sans text-[13px] font-bold text-(--el-text-strong)"
    >
      {initial}
    </span>
  );
}

export function WorkspaceSidebarHeader({
  workspace,
  collapsed = false,
}: WorkspaceSidebarHeaderProps) {
  const t = useTranslations('settings.workspace');
  const backLabel = t('back');
  const displayName = workspace.name;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  // Collapsed rail (56px): a back-arrow icon button (tooltip) above the tile,
  // mirroring all three sibling heads' collapsed treatment.
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
        <WorkspaceAvatar initial={initial} size={32} />
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
        <WorkspaceAvatar initial={initial} size={30} />
        <span className="flex min-w-0 flex-col">
          {/* font-serif: the workspace name is a header IDENTITY label, and it
              wears the same face the WorkspaceSwitcher gives it in the top bar. */}
          <span className="truncate font-serif text-[14.5px] font-semibold text-(--el-text)">
            {displayName}
          </span>
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
