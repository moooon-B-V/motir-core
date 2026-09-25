import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Inbox } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { triageService } from '@/lib/services/triageService';
import { TriageInbox } from './_components/TriageInbox';
import { ReportButton } from '../_components/ReportButton';

// The admin Triage inbox (Story 6.11 · Subtask 6.11.6) — the incoming-work
// front door. ACTIVE-project-scoped, mirroring `issues/page.tsx`: a server
// component that resolves the active project, gates on the actor's ability to
// ACT (edit), reads page 1 of the cursor-paged triage queue, and renders the
// 2-pane inbox (queue + detail + action bar) as a client island.
//
// 4-layer: the page calls services only (getActiveProject + triageService) —
// never Prisma. Unauthenticated → /sign-in; no active project → the no-project
// empty state; a viewer who can browse but not edit → the no-access state (the
// inbox is for users who can clear the queue).

export default async function TriagePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('triage');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does — the only null
  // left is a session-less request — and it redirects rather than rendering.
  if (!ctx) redirect('/sign-in');

  // The inbox is for users who can ACT on it. A non-throwing read of the actor's
  // keys gates the surface on `work_item:triage` — the key `getTriageQueue` below
  // asserts, and the one the sidebar's Triage row is offered on (MOTIR-6175). It
  // gated on `work_item:edit` until then, which disagreed with both in the
  // direction a custom role can reach: an actor holding triage without edit was
  // shown the door and refused the room, and one holding edit without triage
  // passed this gate and then had the queue read refused. A non-browser holds no
  // key at all, so they land on the same state (no existence leak).
  const held = await projectAccessService.getPermissions(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!held.has('work_item:triage')) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <EmptyState
          icon={<Inbox className="h-12 w-12" aria-hidden />}
          title={t('noAccessTitle')}
          description={t('noAccessDescription')}
        />
      </div>
    );
  }

  const page = await triageService.getTriageQueue(
    ctx.projectId,
    {},
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
            <Pill tone="neutral">{t('count', { count: page.items.length })}</Pill>
          </div>
          <p className="text-sm text-(--el-text-muted)">
            {t('subtitle', { project: ctx.project.name, key: ctx.project.identifier })}
          </p>
        </div>
        {/* The inbox-header "Report" CTA (design/triage panel 1) — opens the
            6.11.7 report widget mounted by ReportProvider in the (authed) layout.
            This page already gates on canEdit, so the trigger renders enabled. */}
        <ReportButton display="inbox" />
      </header>

      <TriageInbox
        initialItems={page.items}
        initialNextCursor={page.nextCursor}
        projectKey={ctx.project.identifier}
        projectName={ctx.project.name}
      />
    </div>
  );
}
