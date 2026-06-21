import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Archive } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { commentsService } from '@/lib/services/commentsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { estimationService } from '@/lib/services/estimationService';
import { componentsService } from '@/lib/services/componentsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import type { IssueType } from '@/lib/issues/parentRules';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { EmptyState } from '@/components/ui/EmptyState';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Pill } from '@/components/ui/Pill';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { ArchivedBanner } from './_components/ArchivedBanner';
import { CoreFieldsPanel } from './_components/CoreFieldsPanel';
import { WorkItemDetailActions } from './_components/WorkItemDetailActions';
import { EpicPrivacyControl } from './_components/EpicPrivacyControl';
import { WatchControl } from './_components/WatchControl';
import { ContentSectionCard } from './_components/ContentSectionCard';
import { IssueExplanation } from './_components/IssueExplanation';
import { ParentBreadcrumb } from './_components/ParentBreadcrumb';
import { ChildList } from './_components/ChildList';
import { ActivitySection } from './_components/ActivitySection';
import { AttachmentsPanel } from './_components/AttachmentsPanel';
import { RelationshipsPanel } from './_components/RelationshipsPanel';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { AttachmentsPageDTO } from '@/lib/dto/attachments';
import type { ActivityAllPageDto, ActivityHistoryPageDto } from '@/lib/dto/activity';
import { activityService } from '@/lib/services/activityService';
import { parseActivityTab } from '@/lib/activity/tab';

// The issue DETAIL route (Story 2.4 · Subtask 2.4.1). Server Component:
// resolves the active project (the shipped active-project model — finding #50,
// no /projects/[key] tree; sibling of 2.3.6's edit route), loads the aggregate
// `getIssueDetail` by the [key] identifier (e.g. "PROD-7"), and renders the page
// SHELL — header (type icon · identifier · title · status) + the rendered
// description + an "Edit" link to 2.3.6's form. The two-column body reserves the
// regions later subtasks fill (2.4.2 core-fields panel · 2.4.3 breadcrumb +
// child list · 2.4.4 inline status/assignee controls · 2.4.5 relationships +
// readiness) and the Epic-5 extension slots (comments · attachments · custom
// fields · activity). Cross-workspace / missing → 404 (no existence leak);
// unauthenticated → /sign-in; no active project → a hint, not a crash.

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ activity?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('issueViews');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[48rem]">
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDetailDescription')} />
      </div>
    );
  }

  const { key } = await params;
  let detail;
  try {
    detail = await workItemsService.getIssueDetail(ctx.projectId, key, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    // A browse denial (6.4.3) means the project is hidden from this actor — it
    // must be indistinguishable from a missing issue (404, no existence leak).
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) {
      // Story 6.8.2 — old-key link: if `key` addresses an issue under a RETIRED
      // project key (PROD-7 after PROD→NIF), 308-redirect to the canonical
      // identifier (NIF-7) so old bookmarks keep working; otherwise a real 404.
      const canonical = await resolveAliasedIssueKey(key, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (canonical) permanentRedirect(`/items/${canonical}`);
      notFound();
    }
    throw err;
  }

  const { item } = detail;

  // The actor's EDIT capability (6.4.6) — a read-only actor (viewer / member on
  // a limited project) sees NO edit affordances: the "Edit" link to the form is
  // hidden and the edit route itself is blocked (see edit/page.tsx). Inline field
  // controls render disabled (CoreFieldsPanel, via ProjectAccessProvider).
  const { canEdit } = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // Members back the inline assignee picker + reporter display (getIssueDetail
  // carries ids only); the workflow (already in the detail bundle) backs the
  // inline status picker's legal-transition set.
  // Assignable users scoped by access level (6.4.6): private → project members.
  const members = await assignableMembersService.list({
    projectId: ctx.projectId,
    accessLevel: ctx.project.accessLevel,
    ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
  });

  // Sprints (Subtask 2.4.14) back the inline Sprint field's picker + the current
  // sprint's display name, and the ⋯ menu's "Add to active sprint" quick action.
  // The active sprint (one per project) is the menu's assign target.
  const sprints = await sprintsService.listByProject(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const activeSprint = sprints.find((s) => s.state === 'active') ?? null;

  // Comments (Story 5.1 · 5.1.5): the caller's comment capabilities (the Jira
  // permission split on the 6.4 role model — viewer reads only) + the first
  // cursor page (the NEWEST 20 threads; the section's "Show more comments"
  // extends backward — finding #57, never load-all). A failed read renders the
  // section's ErrorState + retry instead of crashing the page.
  const commentCaps = await projectAccessService.getCommentCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // The Activity tab (Story 5.5 · 5.5.4): URL-driven via `?activity=`
  // (default Comments — the Jira default); the server fetches ONLY the
  // active tab's first cursor page (finding #57 — the other tabs fetch when
  // switched to, via a URL replace that re-renders this page). A failed read
  // renders that tab's ErrorState + retry instead of crashing the page.
  const activityTab = parseActivityTab((await searchParams).activity);
  let initialComments: CommentsPageDTO | null = null;
  let initialHistory: ActivityHistoryPageDto | null = null;
  let initialAll: ActivityAllPageDto | null = null;
  try {
    if (activityTab === 'comments') {
      initialComments = await commentsService.listComments(
        item.id,
        { order: 'desc' },
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
      );
    } else if (activityTab === 'history') {
      initialHistory = await activityService.listHistory(
        item.id,
        { order: 'desc' },
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
      );
    } else {
      initialAll = await activityService.listAll(
        item.id,
        { order: 'desc' },
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
      );
    }
  } catch {
    // The active tab's section renders ErrorState + retry on its null page.
  }

  // Attachments (Story 5.2 · 5.2.5): the caller's attachment capabilities
  // (the Jira three-permission split on the 6.4 roles — create / delete own /
  // delete all; viewers read only) + the first cursor page (the newest 50;
  // the panel's "Show more (N)" extends backward — finding #57, never
  // load-all). A failed read renders the panel's ErrorState + retry.
  const attachmentCaps = await projectAccessService.getAttachmentCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  let initialAttachments: AttachmentsPageDTO | null = null;
  try {
    initialAttachments = await attachmentsService.listForWorkItem(
      item.id,
      {},
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
  } catch {
    initialAttachments = null;
  }

  // Labels + components (Story 5.4 · Subtask 5.4.8): the issue's rows ride the
  // detail read above; the rail's Components picker additionally needs the
  // project taxonomy (browse-gated, name-ordered, admin-bounded — finding #57),
  // and the empty-taxonomy "Manage components" link is admin-only — resolved
  // like the settings pages do (workspace manager OR project-role admin).
  const [projectComponents, wsRole, projectMembers] = await Promise.all([
    componentsService.listComponents(ctx.project.identifier, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    workspacesService.getMemberRole(ctx.userId, ctx.workspaceId),
    projectMembersService.listMembers({
      key: ctx.project.identifier,
      actorUserId: ctx.userId,
      ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    }),
  ]);
  const canManageProject =
    isWorkspaceManager(wsRole) ||
    projectMembers.find((m) => m.userId === ctx.userId)?.role === 'admin';

  // The project estimation config (Subtask 4.3.4) — the rail's inline
  // story-points EstimateBadge reads the scale deck from it via context.
  const estimationConfig = await estimationService.getEstimationConfig(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // Epic/parent subtree roll-up (Subtask 4.3.5) — the SUM of the configured
  // statistic across this item's descendants, computed server-side (one bounded
  // recursive-CTE aggregate — finding #57) ONLY when the item has children, so
  // the header badge renders with no client fetch / flash. A leaf shows none.
  const parentRollup =
    detail.children.length > 0
      ? await estimationService.rollupForParent(item.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : null;

  // Archived state (Story 2.9 · Subtask 2.9.6) — an archived item's detail page
  // renders (the read doesn't filter `archivedAt`), so it gets a top-of-main
  // banner + an eyebrow chip as the archived-state signal. The WHEN is formatted
  // server-side (locale-aware, the same `formatDate` the 2.9.3 list view uses);
  // the WHO rides `detail.archivedBy` (latest `'archived'` revision).
  const isArchived = item.archivedAt != null;
  const locale = (await getLocale()) as Locale;
  const archivedAtLabel = item.archivedAt ? formatDate(item.archivedAt, locale) : '';

  return (
    <EstimationConfigProvider config={estimationConfig} canEdit={canEdit}>
      <div className="flex flex-col gap-6">
        {/* Header — type icon · identifier · parent breadcrumb · title +
          Edit link. The breadcrumb (2.4.3) renders the ancestor chain right
          after the identifier, per the detail.png eyebrow. (Status lives in the
          core-fields rail's StatusPicker, not the eyebrow — 2.4.13.) */}
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <IssueTypeIcon type={item.kind as IssueType} className="h-5 w-5 shrink-0" />
            <span className="text-(--el-text-muted) font-mono text-sm">{item.identifier}</span>
            {/* bug-issue-detail-eyebrow-overflows-viewport: the breadcrumb sits in
              a `min-w-0 flex-1` cell so it has a BOUNDED track to truncate against
              — its inner `<span className="truncate">` (ParentBreadcrumb) only
              fires inside a bounded parent. Without this cell the breadcrumb sits
              as a bare flex child and resolves to its min-content width (a flex
              item defaults to `min-width:auto`), so a long ancestor chain pushes
              the whole page wider than the viewport and clips the right cluster +
              core-fields rail. Short / no-ancestor items render exactly as before
              (the cell collapses to content width at the left). */}
            <div className="flex min-w-0 flex-1 items-center gap-x-3">
              <ParentBreadcrumb ancestors={detail.ancestors} />
              {/* 2.9.6: the always-visible "Archived" chip follows the breadcrumb
                so the archived state stays legible when the page is scrolled past
                the banner. Neutral register (NOT a colored Pill tone) — the only
                eyebrow tag (the status Pill was removed in 2.4.13). */}
              {isArchived ? (
                <Pill className="shrink-0 border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)">
                  <Archive className="size-3 text-(--el-text-muted)" aria-hidden />
                  {t('archivedEntry')}
                </Pill>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-3">
              {/* Epic/parent subtree roll-up (4.3.5) — labelled so it never reads
                as the parent's OWN estimate; shown only when it has descendants. */}
              {parentRollup ? (
                <ParentRollupBadge
                  itemId={item.id}
                  initialTotal={parentRollup.total}
                  variant="header"
                />
              ) : null}
              {/* 5.4.9: the watch control + watchers popover — BEFORE Edit,
                beside the roll-up badge (the labels-components-watch mockup's
                panel-0 placement). Every viewer gets it: watching is not
                editing (the verified permission split). */}
              <WatchControl
                workItemId={item.id}
                initialCount={detail.watcherCount}
                initialWatching={detail.viewerIsWatching}
                currentUserId={ctx.userId}
                candidates={members.map((m) => ({
                  id: m.userId,
                  name: m.name,
                  email: m.email,
                }))}
              />
              {/* 2.8.4: the ⋯ actions menu — Edit details · Copy link · Archive
                · Delete… (Edit folded in here). Permission-gated: Edit/Archive
                on canEdit, Delete on canManageProject. 2.9.11: on an archived
                item the menu swaps Archive→Restore and Delete… opens the
                archived confirm. */}
              <WorkItemDetailActions
                itemId={item.id}
                identifier={item.identifier}
                title={item.title}
                canEdit={canEdit}
                canManage={canManageProject}
                archived={isArchived}
                activeSprintId={activeSprint?.id ?? null}
                activeSprintName={activeSprint?.name ?? null}
                inActiveSprint={activeSprint != null && item.sprintId === activeSprint.id}
              />
            </div>
          </div>
          <h1 className="text-(--el-text) font-serif text-2xl font-semibold">{item.title}</h1>
        </header>

        {/* Body — two columns; later subtasks fill the regions. The `1fr` track is
          `minmax(auto, 1fr)`, so `min-w-0` on the <main> floors its min-content to
          0 — otherwise a wide markdown child (a long unbroken URL, a code block, a
          wide table) blows the track past the viewport. The code block itself
          scrolls inside its own `.motir-prose pre` (overflow-x:auto), but only once
          this track is bounded. Sibling of the eyebrow fix above —
          bug-issue-detail-eyebrow-overflows-viewport. */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
          <main className="flex min-w-0 flex-col gap-6">
            {/* 2.9.6: the archived banner is the FIRST element of the main column,
              above Description — the page's archived-state signal + Restore. */}
            {isArchived ? (
              <ArchivedBanner
                itemId={item.id}
                identifier={item.identifier}
                archivedByName={detail.archivedBy?.name ?? null}
                archivedAtLabel={archivedAtLabel}
                canEdit={canEdit}
              />
            ) : null}
            <ContentSectionCard
              title={t('description')}
              subtitle={t('descriptionGloss')}
              editHref={canEdit ? `/items/${item.identifier}/edit` : undefined}
            >
              {item.descriptionMd ? (
                <MarkdownView value={item.descriptionMd} aria-label={t('issueDescriptionAria')} />
              ) : (
                <p className="font-sans text-sm text-(--el-text-secondary) italic">
                  {t('noDescription')}
                </p>
              )}
            </ContentSectionCard>
            <IssueExplanation
              explanationMd={item.explanationMd}
              explanationSource={item.explanationSource}
              editHref={canEdit ? `/items/${item.identifier}/edit` : undefined}
            />
            {/* 2.4.5: the relationships section + ready/blocked banner — a left-
              column section card (per the approved mockup), after Explanation.
              2.4.9: editable here (add control + per-row remove). */}
            <RelationshipsPanel
              blockedBy={detail.blockedBy}
              blocks={detail.blocks}
              relatesTo={detail.relatesTo}
              duplicates={detail.duplicates}
              clones={detail.clones}
              readiness={detail.readiness}
              currentStatus={item.status}
              workflow={detail.workflow}
              editable={canEdit}
              currentItemId={item.id}
              identifier={item.identifier}
            />
            {/* 2.4.3: direct children (a leaf renders nothing). */}
            <ChildList items={detail.children} workflow={detail.workflow} members={members} />
            {/* 5.2.5: the Attachments panel — after Children, before Activity
              (the reserved Epic-5 slot, per the attachments mockup's panel 0;
              content-width and multi-row, so the left column — the rail is
              for scalars). */}
            <AttachmentsPanel
              workItemId={item.id}
              canCreate={attachmentCaps.canCreate}
              canDeleteAll={attachmentCaps.canDeleteAll}
              currentUserId={ctx.userId}
              initialPage={initialAttachments}
            />
            {/* 5.1.5 + 5.5.4: the completed Activity section — the All /
              Comments / History tabs (URL-driven, default Comments) in the
              slot the page reserved for Epic 5 (after Relationships and
              Children, per the activity-history mockup's panel 0). */}
            <ActivitySection
              workItemId={item.id}
              tab={activityTab}
              workflowStatuses={detail.workflow.statuses}
              comments={{
                canComment: commentCaps.canComment,
                canModerate: commentCaps.canModerate,
                currentUserId: ctx.userId,
                currentUserName: session.user.name,
                mentionCandidates: members.map((m) => ({
                  id: m.userId,
                  name: m.name,
                  email: m.email,
                })),
              }}
              initialComments={initialComments}
              initialHistory={initialHistory}
              initialAll={initialAll}
            />
          </main>

          <aside className="flex flex-col gap-4">
            <CoreFieldsPanel
              item={item}
              members={members}
              workflow={detail.workflow}
              parent={detail.parent}
              reporterIsSelf={item.reporterId === ctx.userId}
              customFields={detail.customFields}
              labelsComponents={{
                projectKey: ctx.project.identifier,
                labels: detail.labels,
                components: detail.components,
                projectComponents,
                canManageProject,
              }}
              sprints={sprints}
            />
            {/* Epic-level privacy (Story 6.14 · 6.14.7) — the project-admin
              set/unset control, EPIC-kind only. A non-admin member sees it
              read-only (design invariant #4); public-read hiding is enforced
              server-side (6.14.4). */}
            {item.kind === 'epic' ? (
              <EpicPrivacyControl
                workItemId={item.id}
                initialHidden={item.publicChildrenHidden}
                canManageProject={canManageProject}
              />
            ) : null}
            {/* The 2.4.3 parent breadcrumb lives in the header (per detail.png),
              not here. Epic 5: custom fields · attachments. */}
          </aside>
        </div>
      </div>
    </EstimationConfigProvider>
  );
}
