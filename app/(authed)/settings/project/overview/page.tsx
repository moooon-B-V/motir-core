import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EditOverview } from './_components/EditOverview';

// The dedicated "Edit overview" authoring view (Story 6.12 · Subtask 6.12.8,
// design/public-projects Panel 7) — a split MarkdownEditor + live MarkdownView
// preview for the public Overview/README body (`project.publicOverviewMd`,
// 6.12.3). Reached from the make-public settings entry point (Panel 6); a
// dedicated view, not a cramped in-settings box.
//
// The area layout already gates `canBrowse` (a non-browser never reaches here).
// This page only needs the project-admin capability to decide editable-vs-
// read-only — the WRITE itself is re-gated server-side in
// `projectsService.setPublicOverview` (a non-admin POSTing the action still
// fails). `getActiveProject` resolves the project; the layout guarantees it.
export default async function ProjectOverviewSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');

  const [{ canManage }, publicOverviewMd] = await Promise.all([
    projectAccessService.getManageCapabilities(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    projectsService.getPublicOverview({
      key: ctx.project.identifier,
      ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    }),
  ]);

  return (
    <EditOverview
      initialValue={publicOverviewMd ?? ''}
      canManage={canManage}
      isPublic={ctx.project.accessLevel === 'public'}
    />
  );
}
