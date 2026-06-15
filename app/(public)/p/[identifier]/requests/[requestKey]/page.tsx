import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { Pill } from '@/components/ui/Pill';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { MarkdownView } from '@/components/ui/MarkdownView';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicRoadmapVote } from '@/app/(public)/_components/PublicRoadmapVote';
import { PublicRequestComments } from '@/app/(public)/_components/PublicRequestComments';

// The public REQUEST DETAIL page (Story 6.12 · Subtask 6.12.12 · design Panel 5)
// — the crawlable, server-rendered detail for one public request, reached from
// the roadmap cards + the dedupe candidates. It runs the anonymous browse gate
// (a non-public / unknown project or a missing / archived request → 404, never
// 403) and renders the public PROJECTION: the upvote head, status Pill, title,
// meta, body, and the PUBLIC comment thread (the request's `isPublic` comments
// only — no assignee / estimate / internal discussion crosses the projection).
// READ is fully public — no sign-in; `signedIn` only drives the reused
// PublicRoadmapVote's sign-in-to-act prompt and the comment composer.

const STATUS_TONE: Record<StatusCategoryDto, 'planned' | 'in-progress' | 'done'> = {
  todo: 'planned',
  in_progress: 'in-progress',
  done: 'done',
};

const KIND_LABEL: Record<WorkItemKindDto, string> = {
  epic: 'kindEpic',
  story: 'kindStory',
  task: 'kindFeature',
  bug: 'kindBug',
  subtask: 'kindSubtask',
};

export default async function PublicRequestDetailPage({
  params,
}: {
  params: Promise<{ identifier: string; requestKey: string }>;
}) {
  const { identifier, requestKey } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let detail;
  try {
    detail = await publicProjectsService.getRequestDetail(identifier, requestKey, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PublicRequestNotFoundError) {
      notFound();
    }
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const format = await getFormatter();
  const createdAt = new Date(detail.createdAt);

  return (
    <>
      <PublicTabNav identifier={identifier} active="roadmap" />
      <div className="p-(--spacing-card-padding)">
        <Link
          href={`/p/${encodeURIComponent(identifier)}/roadmap`}
          className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('requestBackToRoadmap')}
        </Link>

        <article className="mx-auto max-w-[48rem]">
          <header className="flex gap-4">
            <PublicRoadmapVote
              requestId={detail.id}
              initialVoted={detail.voted}
              initialCount={detail.voteCount}
              signedIn={session !== null}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <Pill status={STATUS_TONE[detail.statusCategory]}>{detail.statusLabel}</Pill>
              <h1 className="mt-2 font-serif text-2xl font-semibold leading-tight text-(--el-text)">
                {detail.title}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-(--el-text-muted)">
                <span className="inline-flex items-center gap-1.5">
                  <IssueTypeIcon type={detail.kind} className="h-[14px] w-[14px]" />
                  {t(KIND_LABEL[detail.kind])}
                </span>
                <span className="text-(--el-text-faint)">·</span>
                <span>{t('requestOpenedBy', { name: detail.openedByName })}</span>
                <span className="text-(--el-text-faint)">·</span>
                <time
                  dateTime={detail.createdAt}
                  title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                >
                  {format.relativeTime(createdAt)}
                </time>
                <span className="text-(--el-text-faint)">·</span>
                <span className="font-medium text-(--el-text-secondary)">{detail.identifier}</span>
              </div>
            </div>
          </header>

          <div className="mt-6">
            {detail.descriptionMd && detail.descriptionMd.trim().length > 0 ? (
              <MarkdownView value={detail.descriptionMd} className="text-[14px]" />
            ) : (
              <p className="text-[13.5px] text-(--el-text-muted)">{t('requestNoBody')}</p>
            )}
          </div>

          <PublicRequestComments
            requestId={detail.id}
            initialComments={detail.comments}
            signedIn={session !== null}
            viewerName={session?.user.name ?? undefined}
          />
        </article>
      </div>
    </>
  );
}
