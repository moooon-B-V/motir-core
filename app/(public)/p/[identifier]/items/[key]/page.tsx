import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { EyeOff, Inbox, Lock } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicWorkItemNotFoundError } from '@/lib/publicProjects/errors';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicChildIssues } from '@/app/(public)/_components/PublicChildIssues';

// The public read-only WORK-ITEM DETAIL page (Story 6.14 · Subtask 6.14.11 ·
// design `public-item-detail.mock.html`) — the crawlable, server-rendered detail
// a public / non-member viewer lands on from an items-list row or a board card
// at `/p/[identifier]/items/[key]`. It runs the anonymous browse gate (a
// non-public / unknown project or a missing / archived / triage / hidden item →
// 404, never 403) and renders the public PROJECTION: the header (kind icon +
// identifier + title + status Pill), a public-safe body, a CHILD / sub-issue
// panel (the first page SSR'd, the rest lazy-loaded), and a public-safe sidebar
// (Status / Type / Children-or-Parent). NO assignee / estimate / story points /
// internal comments cross the wire — they're absent from the DTO, not DOM-hidden.
//
// Epic-privacy (Subtask 6.14.4 · design epic-privacy panel 3): a NON-MEMBER
// viewing a PRIVATE epic gets the lavender "Not public" header badge, the "this
// epic is not public" placeholder INSTEAD of the child list (no child rows in
// the DOM — excluded server-side), and "Hidden" sidebar rollups. READ is fully
// public — no sign-in.

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

/** A centered icon + title + body panel state (the design `.empty` block) —
 *  rendered INSIDE the "Child work items" Card under its section label, so it
 *  never double-cards an `EmptyState`. */
function CenteredState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center text-(--el-text-muted)">
        {icon}
      </span>
      <h3 className="font-serif text-base font-semibold text-(--el-text)">{title}</h3>
      <p className="mt-1 max-w-prose text-[13px] text-(--el-text-secondary)">{body}</p>
    </div>
  );
}

/** One sidebar key/value row. */
function SideRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex-none text-(--el-text-muted)">{k}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

export default async function PublicWorkItemDetailPage({
  params,
}: {
  params: Promise<{ identifier: string; key: string }>;
}) {
  const { identifier, key } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let detail;
  try {
    detail = await publicProjectsService.getWorkItemDetail(identifier, key, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PublicWorkItemNotFoundError) {
      notFound();
    }
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const itemsBase = `/p/${encodeURIComponent(identifier)}/items`;
  const isEpic = detail.kind === 'epic';
  // The child panel shows for any item WITH children, for the private-epic
  // placeholder, and for an epic with none (the "no child work items yet"
  // state). A non-epic LEAF (no children) simply omits the panel (design anno).
  const showChildPanel = detail.childrenHidden || detail.children.length > 0 || isEpic;

  return (
    <>
      <PublicTabNav identifier={identifier} active="items" />
      <div className="p-(--spacing-card-padding)">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-3">
              <nav
                aria-label={t('detailBreadcrumbLabel')}
                className="flex flex-wrap items-center gap-1.5 text-[12px] text-(--el-text-muted)"
              >
                <Link
                  href={itemsBase}
                  className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
                >
                  {t('tabWorkItems')}
                </Link>
                {detail.parent ? (
                  <>
                    <span className="text-(--el-text-faint)" aria-hidden>
                      /
                    </span>
                    <Link
                      href={`${itemsBase}/${encodeURIComponent(detail.parent.identifier)}`}
                      className="font-mono text-[11.5px] text-(--el-link) hover:text-(--el-link-pressed)"
                    >
                      {detail.parent.identifier}
                    </Link>
                  </>
                ) : null}
                <span className="text-(--el-text-faint)" aria-hidden>
                  /
                </span>
                <span className="font-mono text-[11.5px] text-(--el-text-secondary)">
                  {detail.identifier}
                </span>
              </nav>

              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                <IssueTypeIcon type={detail.kind} className="h-5 w-5 flex-none" />
                <span className="font-mono text-[12px] text-(--el-text-faint)">
                  {detail.identifier}
                </span>
                <h1 className="font-serif text-2xl font-semibold leading-tight text-(--el-text)">
                  {detail.title}
                </h1>
                {detail.childrenHidden ? (
                  <Pill tone="private" className="flex-none">
                    <Lock className="h-3 w-3" aria-hidden />
                    {t('epicNotPublicBadge')}
                  </Pill>
                ) : (
                  <Pill status={STATUS_TONE[detail.statusCategory]} className="flex-none">
                    {detail.statusLabel}
                  </Pill>
                )}
              </div>
            </div>

            <Card>
              <SectionLabel label={t('detailDescriptionLabel')} className="mb-2.5" />
              {detail.descriptionMd && detail.descriptionMd.trim().length > 0 ? (
                <MarkdownView value={detail.descriptionMd} className="text-[14px]" />
              ) : (
                <p className="text-[13.5px] text-(--el-text-muted)">{t('detailNoDescription')}</p>
              )}
            </Card>

            {showChildPanel ? (
              <Card>
                <SectionLabel label={t('detailChildIssuesLabel')} className="mb-2.5" />
                {detail.childrenHidden ? (
                  <CenteredState
                    icon={<EyeOff className="h-10 w-10" aria-hidden />}
                    title={t('epicNotPublicTitle')}
                    body={t('epicNotPublicBody')}
                  />
                ) : detail.children.length > 0 ? (
                  <PublicChildIssues
                    identifier={identifier}
                    parentId={detail.id}
                    initialChildren={detail.children}
                    initialHasMore={detail.childrenHasMore}
                    total={detail.childCount}
                  />
                ) : (
                  <CenteredState
                    icon={<Inbox className="h-10 w-10" aria-hidden />}
                    title={t('detailNoChildrenTitle')}
                    body={t('detailNoChildrenBody')}
                  />
                )}
              </Card>
            ) : null}
          </div>

          <Card className="h-max">
            <dl className="flex flex-col gap-3 text-[13px]">
              <SideRow k={t('detailSideStatus')}>
                <span className="text-(--el-text)">{detail.statusLabel}</span>
              </SideRow>
              <SideRow k={t('detailSideType')}>
                <span className="inline-flex items-center gap-1.5 text-(--el-text)">
                  <IssueTypeIcon type={detail.kind} className="h-3.5 w-3.5 flex-none" />
                  {t(KIND_LABEL[detail.kind])}
                </span>
              </SideRow>
              {isEpic ? (
                detail.childrenHidden ? (
                  <>
                    <SideRow k={t('detailSideChildren')}>
                      <span className="italic text-(--el-text-secondary)">
                        {t('detailSideHidden')}
                      </span>
                    </SideRow>
                    <SideRow k={t('detailSideProgress')}>
                      <span className="italic text-(--el-text-secondary)">
                        {t('detailSideHidden')}
                      </span>
                    </SideRow>
                  </>
                ) : (
                  <SideRow k={t('detailSideChildren')}>
                    <span className="text-(--el-text)">{detail.childCount}</span>
                  </SideRow>
                )
              ) : detail.parent ? (
                <SideRow k={t('detailSideParent')}>
                  <Link
                    href={`${itemsBase}/${encodeURIComponent(detail.parent.identifier)}`}
                    className="text-(--el-link) hover:text-(--el-link-pressed)"
                  >
                    {detail.parent.identifier} · {detail.parent.title}
                  </Link>
                </SideRow>
              ) : null}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
