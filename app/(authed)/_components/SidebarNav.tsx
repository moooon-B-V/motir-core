'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  CircleDot,
  CirclePlay,
  Columns3,
  LayoutDashboard,
  ListChecks,
  Settings,
} from 'lucide-react';
import { Sidebar, type SidebarSection } from '@/components/ui/Sidebar';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { useSidebarCollapsed } from '@/lib/hooks/useSidebarCollapsed';
import type { ProjectDTO } from '@/lib/dto/projects';
import { SidebarHeader } from './SidebarHeader';

// The signed-in navigation rail. Composes the 1.5.2 Sidebar primitive with
// a SidebarHeader (project context) and the route-aware nav sections. Active
// detection is client-side (usePathname), which is why the whole rail is a
// client component rather than the layout building <Sidebar sections={…} />
// directly — section `active` flags can't be computed in the server layout.
//
// Section shape (PRODECT_FINDINGS #29):
//   - active project (archived or not) → primary [Dashboard, Issues, Boards,
//     Reports] + bottom [Settings → /settings/project, Docs]. The project-
//     scoped nav stays visible even when archived (#29.2); the stub pages
//     render the "this project is archived" empty state themselves.
//   - no project (#29.1) → only the bottom section, with Settings deep-
//     linking to the WORKSPACE settings (there's no project to configure).
//
// Two variants: `rail` (the persistent desktop rail, follows the shared
// collapse store, carries the footer collapse toggle) and `drawer` (the
// <md off-canvas body, always expanded, no footer — the drawer chrome owns
// its own close affordance).

// Docs is an external link (no in-app docs route yet); points at the repo.
const DOCS_URL = 'https://github.com/moooon-B-V/prodect-core#readme';

export interface SidebarNavProps {
  activeProject: ProjectDTO | null;
  projects: ProjectDTO[];
  variant?: 'rail' | 'drawer';
  /**
   * The active project's readiness count for the "Ready" entry's badge
   * (Subtask 7.0.6). Resolved once in the (authed) layout and threaded here, so
   * the badge never double-fetches. `hasMore` renders the bounded-count "{cap}+"
   * cap; a zero count hides the badge.
   */
  readyCount?: { count: number; hasMore: boolean } | null;
}

function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

/** The "Ready" entry's count badge — the neutral rail-badge grammar (7.0.1
 *  design-notes): muted fill, secondary text, hairline border, badge radius. */
function ReadyBadge({ count, hasMore }: { count: number; hasMore: boolean }) {
  return (
    <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-(--radius-badge) border border-(--el-border) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) text-center font-sans text-[11px] font-semibold tabular-nums text-(--el-text-secondary)">
      {hasMore ? `${count}+` : count}
    </span>
  );
}

export function SidebarNav({
  activeProject,
  projects,
  variant = 'rail',
  readyCount,
}: SidebarNavProps) {
  const t = useTranslations('shell');
  const pathname = usePathname();
  const [storeCollapsed] = useSidebarCollapsed();
  const isDrawer = variant === 'drawer';
  // The drawer always renders expanded; the rail follows the shared store.
  const collapsed = isDrawer ? false : storeCollapsed;

  const hasProject = Boolean(activeProject);

  const sections: SidebarSection[] = [];

  if (hasProject) {
    sections.push({
      id: 'primary',
      items: [
        {
          icon: <LayoutDashboard />,
          label: t('nav.dashboard'),
          href: '/dashboard',
          active: isActive(pathname, '/dashboard'),
        },
        {
          icon: <CircleDot />,
          label: t('nav.issues'),
          href: '/issues',
          active: isActive(pathname, '/issues'),
        },
        {
          // The AI dispatch surface (Subtask 7.0.6) — sits BETWEEN Issues and
          // Boards. `CirclePlay` (run/dispatch) is the 7.0.1-locked glyph (Zap
          // is taken by the epic issue type). The badge is the readiness count;
          // hidden when zero.
          icon: <CirclePlay />,
          label: t('nav.ready'),
          href: '/ready',
          active: isActive(pathname, '/ready'),
          badge:
            readyCount && readyCount.count > 0 ? (
              <ReadyBadge count={readyCount.count} hasMore={readyCount.hasMore} />
            ) : undefined,
        },
        {
          icon: <Columns3 />,
          label: t('nav.boards'),
          href: '/boards',
          active: isActive(pathname, '/boards'),
        },
        {
          icon: <BarChart3 />,
          label: t('nav.reports'),
          href: '/reports',
          active: isActive(pathname, '/reports'),
        },
      ],
    });
  }

  sections.push({
    id: 'bottom',
    items: [
      {
        icon: <Settings />,
        label: t('nav.settings'),
        // Deep-link to project settings when a project is active; otherwise
        // there's nothing project-scoped to configure, so go to workspace.
        href: hasProject ? '/settings/project' : '/settings/workspace',
        // Stay un-highlighted when the more-specific Job runs sub-link is the
        // active route, so only one row reads as current.
        active: isActive(pathname, '/settings') && !isActive(pathname, '/settings/workspace/jobs'),
      },
      {
        // Operator surface (Subtask 1.6.5) — the workspace's background-job runs
        // + dead-letter queue. A workspace-scoped settings sub-page.
        icon: <ListChecks />,
        label: t('nav.jobRuns'),
        href: '/settings/workspace/jobs',
        active: isActive(pathname, '/settings/workspace/jobs'),
      },
      {
        icon: <BookOpen />,
        label: t('nav.docs'),
        href: DOCS_URL,
      },
    ],
  });

  return (
    <Sidebar
      header={
        <SidebarHeader activeProject={activeProject} projects={projects} collapsed={collapsed} />
      }
      sections={sections}
      footer={isDrawer ? undefined : <SidebarToggle variant="footer" />}
      collapsed={isDrawer ? false : undefined}
    />
  );
}
