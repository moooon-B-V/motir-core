'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The ORGANISATION-settings-area rail header (Story MOTIR-4669 · MOTIR-4710).
// The third of three, and written from the same pattern as its two siblings —
// `SettingsSidebarHeader` (the project) and `AccountSidebarHeader` (the user).
//
// The constant across all three is what the head NAMES: the tenant the area
// configures. The project area shows the ProjectSwitcher, the account area the
// signed-in user, and this one the ORGANISATION — per
// `design/org-admin/org-admin.mock.html` panel 7 (the `.rail-head` block): a
// "← Back to Motir" link, the org's initial tile + name, and an "Organisation
// settings" eyebrow.
//
// ⚠️ THE THREE HEADS GO STALE AS A SET, which is the sibling's own recorded
// experience: `/dashboard` survived in two of them after MOTIR-2654 moved the
// signed-in landing to `/home`, because they are written from one pattern and
// nobody re-read the third. So the back href is IMPORTED, never retyped
// (MOTIR-3373), and `tests/components/rail-head-back-link.test.tsx` is the guard
// on the rendered value in every rail variant.
const BACK_HREF = AUTHED_LANDING_PATH;

export interface OrganizationSidebarHeaderProps {
  organization: { name: string };
  /** When true, render the icon-only (collapsed rail) affordance. */
  collapsed?: boolean;
}

/** The organisation's initial tile. A SQUARE with `--radius-control`, not the
 *  circle the two sibling heads use — the circle is this product's PERSON
 *  grammar (avatars, the UserMenu), and an organisation is not a person. The
 *  same distinction `OrgControl`'s own trigger tile already draws. */
function OrgAvatar({ initial, size }: { initial: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) font-sans text-[13px] font-bold text-(--el-text-strong)"
    >
      {initial}
    </span>
  );
}

export function OrganizationSidebarHeader({
  organization,
  collapsed = false,
}: OrganizationSidebarHeaderProps) {
  const t = useTranslations('settings.organization');
  const backLabel = t('back');
  const displayName = organization.name;
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';

  // Collapsed rail (56px): a back-arrow icon button (tooltip) above the org
  // tile, mirroring both sibling heads' collapsed treatment.
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
        <OrgAvatar initial={initial} size={32} />
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
        <OrgAvatar initial={initial} size={30} />
        <span className="flex min-w-0 flex-col">
          {/* font-serif: the organisation name is a header IDENTITY label, and it
              wears the same face `OrgControl` gives it in the top bar. */}
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
