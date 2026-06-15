import { notFound } from 'next/navigation';
import { Route } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';

// The public Roadmap tab (Story 6.12 · design Panel 3). The ROADMAP ITSELF is
// owned by Subtask 6.12.7 (status-grouped, vote-counted, paginated columns over
// the public projection). For 6.12.4 this renders the design-specified empty
// state ("Nothing on the roadmap yet") so the 4-tab nav is complete and no tab
// link 404s. This is the DESIGN'S empty state (design-notes Panel 8), NOT
// improvised UI.
//
// TODO(6.12.7): replace this EmptyState with the real status-grouped roadmap
// (submitted → planned → in progress → done columns, per-column pagination,
// upvote control) built over publicProjectsService.

export default async function PublicRoadmapPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  // Re-run the anonymous browse gate so a non-public / unknown project 404s here
  // too (getOverview throws ProjectNotFoundError on a non-public project).
  try {
    await publicProjectsService.getOverview(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');

  return (
    <>
      <PublicTabNav identifier={identifier} active="roadmap" />
      <div className="p-(--spacing-card-padding)">
        <EmptyState
          icon={<Route className="h-12 w-12" aria-hidden />}
          title={t('roadmapEmptyTitle')}
          description={t('roadmapEmptyBody')}
        />
      </div>
    </>
  );
}
