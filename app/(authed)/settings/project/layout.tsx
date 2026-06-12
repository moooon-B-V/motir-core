import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';

// The project-settings AREA layout (Story 6.5 · Subtask 6.5.2). The grouped
// settings NAV itself lives in the app rail — SidebarNav swaps to it when the
// route is inside this area (the design's "same rail" decision; the App Router
// keeps the rail in the parent (authed) layout, not a nested one under <main>).
//
// This layout owns the CONTENT-side guards every settings page shares, so the
// area enforces them at ONE chokepoint rather than re-deriving per page:
//   * no active project → the area's "No project selected" empty state. The
//     route still resolves (never 404s) — the retiring hub's empty state, kept.
//   * the active project isn't browsable (e.g. it was made private while pinned)
//     → the 6.4.4 NoAccessState. The rail's registry filter has already removed
//     every settings entry (no nav leak); this is the matching page state.
// When both pass, the page renders normally inside the rail's area chrome.

export default async function ProjectSettingsAreaLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) {
    const t = await getTranslations('settings');
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('area.noProjectTitle')} description={t('area.noProjectDescription')} />
      </div>
    );
  }

  const { canBrowse } = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="mx-auto max-w-[42rem]">
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  return children;
}
