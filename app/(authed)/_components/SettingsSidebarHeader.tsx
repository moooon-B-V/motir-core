'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import type { ProjectDTO } from '@/lib/dto/projects';
import { ProjectMark } from './ProjectMark';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// The settings-area rail header (Story 6.5 · Subtask 6.5.2). When the rail is in
// the project-settings area it REPLACES the SidebarHeader/ProjectSwitcher with a
// "← Back to {project}" link + a static project-identity block + a "Project
// settings" eyebrow — Jira's verified team-managed shape (decision-ladder rung 1),
// per `design/projects/settings-area.mock.html` (the `.rail-head` panel).
//
// Back goes to the PROJECT HOME, and that is `/home` (MOTIR-3171). It was
// `/dashboard` when this file landed and the line here said so; MOTIR-2654 then
// made `/home` the signed-in landing and the rail's first project row, and
// MOTIR-2761 narrowed it to the ACTIVE project with a create-first door for the
// no-project case (`docs/decisions/home-scope.md` §2). `/dashboard` kept its
// route and its own rail entry and is reached by navigating to it — it is one
// project surface among the rows, not the home (`app/(authed)/dashboard/page.tsx`
// carries the same warning). `tests/components/rail-head-back-link.test.tsx` is
// the guard on the rendered `href`, in both rail variants.

// The constant is IMPORTED, not retyped (MOTIR-3373) — this file is one of
// the three that carried the stale `/dashboard` this comment is about.
const BACK_HREF = AUTHED_LANDING_PATH;

export interface SettingsSidebarHeaderProps {
  activeProject: ProjectDTO;
  /** When true, render the icon-only (collapsed rail) affordance. */
  collapsed?: boolean;
}

export function SettingsSidebarHeader({
  activeProject,
  collapsed = false,
}: SettingsSidebarHeaderProps) {
  const t = useTranslations('settings');
  const backLabel = t('nav.backToProject', { projectName: activeProject.name });

  // Collapsed rail (56px): a back-arrow icon button (tooltip) above the project
  // tile, mirroring the SidebarHeader collapsed treatment.
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
        <ProjectMark image={activeProject.image} size={32} />
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
        <ProjectMark image={activeProject.image} size={30} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-[13.5px] font-semibold text-(--el-text)">
            {activeProject.name}
          </span>
          <span className="font-mono text-[11px] text-(--el-text-secondary)">
            {activeProject.identifier}
          </span>
        </span>
      </div>

      {/* Eyebrow on the sidebar surface (#f6f5f4): --el-text-faint/-muted both
          undershoot WCAG AA at 11px, so use --el-text-secondary (AA-safe). */}
      <span className="px-(--spacing-control-x) font-sans text-[11px] font-semibold uppercase tracking-[0.02em] text-(--el-text-secondary)">
        {t('nav.eyebrow')}
      </span>
    </div>
  );
}
