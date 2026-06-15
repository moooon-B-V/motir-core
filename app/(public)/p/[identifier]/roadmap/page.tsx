import { notFound } from 'next/navigation';
import { Route } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicRoadmap } from '@/app/(public)/_components/PublicRoadmap';

// The public Roadmap tab (Story 6.12 · Subtask 6.12.7 · design Panel 3) — the
// status-grouped, vote-counted, per-column-paginated public roadmap over the
// 6.12.4 public projection. Server component: it runs the anonymous browse gate
// (a non-public / unknown project 404s, never 403) and renders the SSR'd first
// page of every column into the crawlable HTML (SEO/GEO), then hands the columns
// to the PublicRoadmap client island for the upvote toggles + the per-column
// "Load more". When every column is empty it shows the design's empty state
// (Panel 8) rather than four empty columns. READ is fully public — no sign-in;
// `signedIn` only drives the upvote control's sign-in-to-act prompt.

export default async function PublicRoadmapPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let roadmap;
  try {
    roadmap = await publicProjectsService.getRoadmap(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const isEmpty = roadmap.columns.every((c) => c.totalCount === 0);

  return (
    <>
      <PublicTabNav identifier={identifier} active="roadmap" />
      <div className="p-(--spacing-card-padding)">
        {isEmpty ? (
          <EmptyState
            icon={<Route className="h-12 w-12" aria-hidden />}
            title={t('roadmapEmptyTitle')}
            description={t('roadmapEmptyBody')}
          />
        ) : (
          <PublicRoadmap
            identifier={identifier}
            initialColumns={roadmap.columns}
            signedIn={session !== null}
          />
        )}
      </div>
    </>
  );
}
