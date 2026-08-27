import { Suspense } from 'react';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Archive } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { estimationService } from '@/lib/services/estimationService';
import { componentsService } from '@/lib/services/componentsService';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import type { IssueType } from '@/lib/issues/parentRules';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemPlanEntrance } from '@/components/planning/WorkItemPlanEntrance';
import { EmptyState } from '@/components/ui/EmptyState';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { WorkItemTitle } from '@/components/markdown/WorkItemTitle';
import { parseWorkItemRefs } from '@/lib/mentions/workItemRefs';
import { Pill } from '@/components/ui/Pill';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { ArchivedBanner } from './_components/ArchivedBanner';
import { CoreFieldsPanel } from './_components/CoreFieldsPanel';
import { WorkItemDetailActions } from './_components/WorkItemDetailActions';
import { EpicPrivacyControl } from './_components/EpicPrivacyControl';
import { WatchControl } from './_components/WatchControl';
import { ContentSectionCard } from './_components/ContentSectionCard';
import { readLateSections } from './_components/lateReads';
import {
  LateUpperSections,
  LateLowerSections,
  LateUpperFallback,
  LateLowerFallback,
} from './_components/LateSections';
import { IssueExplanation } from './_components/IssueExplanation';
import { ParentBreadcrumb } from './_components/ParentBreadcrumb';
import { ChildList } from './_components/ChildList';
import { ChildPanel } from './_components/ChildPanel';
import { RelationshipsPanel } from './_components/RelationshipsPanel';
import { IssueQuickViewController } from '../_components/IssueQuickViewController';
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

  // The actor's PERMISSION SET (MOTIR-2473) — ONE round trip feeding three
  // affordance decisions that used to be two booleans and a private admin check:
  //
  //   * `canEdit` (`work_item:edit`) — a read-only actor sees NO edit
  //     affordances: the "Edit" link is hidden and the edit route is blocked
  //     (edit/page.tsx). Inline field controls render disabled (6.4.6).
  //   * `canArchive` (`work_item:archive`) — the ⋯ menu's Archive / Restore rows
  //     and the delete dialog's "Archive instead" escape-hatch (MOTIR-3629).
  //     A MEMBER holds this and not `work_item:delete`, which is the split the
  //     comment below used to describe as an unfixable 403.
  //   * `canDelete` (`work_item:delete`) — the ⋯ menu's Delete row alone.
  //     NOT the same people as `canEdit`: a member holds edit and not delete.
  //     ⚠️ It used to gate Archive too, on the reading that "a member holds edit
  //     and not delete, so the Archive row it used to offer them was an
  //     affordance that 403'd" — a correct diagnosis whose only available remedy
  //     was to hide Archive from every member, because one key spanned the
  //     reversible hide and the irreversible subtree destroy. MOTIR-3629 split
  //     the key instead, so the row is offered to exactly the actors the service
  //     admits.
  //   * `canManageProject` (`project:administer`) — the epic-privacy control.
  const held = await projectAccessService.getPermissions(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const canEdit = held.has('work_item:edit');
  const canArchive = held.has('work_item:archive');
  const canDelete = held.has('work_item:delete');
  const canManageProject = held.has('project:administer');

  // The Activity tab (Story 5.5 · 5.5.4): URL-driven via `?activity=`
  // (default Comments — the Jira default); the server fetches ONLY the
  // active tab's first cursor page (finding #57 — the other tabs fetch when
  // switched to, via a URL replace that re-renders this page). Read BEFORE the
  // group below because it selects which of the three reads that group runs;
  // `searchParams` is Next's own promise, not a round trip.
  const activityTab = parseActivityTab((await searchParams).activity);

  // ── EVERY REMAINING READ, CONCURRENTLY (Subtask MOTIR-3435) ───────────────
  //
  // This page used to await 29 times, almost all of them in sequence, before it
  // returned a single element — which is what a reader pays when they paste a
  // key into the address bar and watch the PREVIOUS page for as long as the SUM
  // of those reads takes. Everything below is independent of everything else
  // once `ctx`, `detail`, `item` and `held` exist, so the page's wait is now the
  // SLOWEST single read rather than their total.
  //
  // ⚠️ THE GATE ABOVE IS DELIBERATELY NOT IN HERE, and must never be moved in.
  // `getSession` → `getActiveProject` → `getIssueDetail` → `getPermissions` stay
  // sequential and ahead of this, because they decide whether this actor may see
  // the item AT ALL: a browse denial and a missing item are the same 404 (no
  // existence leak), a retired project key 308-redirects, and `held` decides
  // whether edit affordances render. Parallelising a page whose first job is to
  // decide whether you may look at it is exactly how a hidden item becomes
  // visible for a frame. `tests/components/item-detail-reads.test.tsx` asserts
  // the ordering and this group's membership rather than leaving it to a
  // reviewer to notice.
  //
  // ⚠️ A CONDITIONAL READ STAYS CONDITIONAL. Skipping a query is cheaper than
  // parallelising one, so `acceptance*` still runs only for a story at
  // in_review / done, and `rollupForParent` only when the item has children —
  // the ternaries are inside the group, not replaced by it.
  //
  // Each `try` that used to wrap a read is now inside its own arm, so a section
  // whose read fails still degrades to its own ErrorState + retry instead of
  // rejecting the whole group.
  // ── THE LATE STACK'S READS, STARTED BUT NOT AWAITED (Subtask MOTIR-3436) ──
  //
  // `design/work-items/design-notes.md` § *The item page at ARRIVAL, and while
  // it STREAMS* allocates every region to a tier. The THIRD tier — Development,
  // Acceptance, Design result, Attachments, Activity — is everything below the
  // fold, and this page no longer waits for any of it: the promise is created
  // here and awaited inside the two `<Suspense>` boundaries below, which share
  // it so they flush together and the reader sees ONE settle rather than five
  // arrivals. `_components/lateReads.ts` carries the reads verbatim.
  const lateReads = readLateSections({
    itemId: item.id,
    itemType: item.type,
    itemStatus: item.status,
    itemKind: item.kind,
    projectId: ctx.projectId,
    ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    fullCtx: ctx,
    activityTab,
    canEdit,
  });

  // ── TIER TWO: what the reader came for, awaited before the first flush ─────
  //
  // The title, both prose bodies, the children list and the core-fields rail.
  // Still ONE round trip rather than eight, and still conditional where it was:
  // `rollupForParent` only when the item has children.
  //
  // ⚠️ THE ROLL-UP stays here rather than moving to its component's lazy path.
  // The tier table calls it "late, IN PLACE", and `ParentRollupBadge` does ship
  // that path — but it renders NOTHING while pending, so the slot is not
  // reserved and its neighbours shift when it fills, which is what the in-place
  // rule exists to prevent. This group already has the figure at no marginal
  // cost, so it is cheaper to not be late at all.
  const [
    members,
    sprints,
    deliveryView,
    projectComponents,
    estimationConfig,
    parentRollup,
    locale,
    workItemRefs,
  ] = await Promise.all([
    // Members back the inline assignee picker + reporter display, and the
    // Activity section's mention candidates. Assignable users are scoped by
    // access level (6.4.6): private → project members.
    assignableMembersService.list({
      projectId: ctx.projectId,
      accessLevel: ctx.project.accessLevel,
      ctx: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    }),
    // Sprints (Subtask 2.4.14) back the inline Sprint field's picker + the ⋯
    // menu's "Add to active sprint" quick action.
    sprintsService.listByProject(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    // Per-repository DELIVERY (Story MOTIR-2725 · MOTIR-2415). TIER TWO because
    // the rail's Repositories card renders it — the Development section below
    // uses the same value, passed down rather than read twice.
    // The rail's glyph AND the Development section's rows, from ONE call
    // (MOTIR-3660): `getDeliveryView` returns the repository set already amended
    // by the delivery set, plus the set itself. Combining them at the host is
    // what let this page and the quick view disagree (MOTIR-3036), so neither
    // does it.
    workItemsService.getDeliveryView(item.id, item.targetRepos, ctx),
    // The project taxonomy behind the rail's Components picker (Story 5.4 ·
    // Subtask 5.4.8) — browse-gated, name-ordered, admin-bounded (finding #57).
    componentsService.listComponents(ctx.project.identifier, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    // The project estimation config (Subtask 4.3.4) — the rail's inline
    // story-points EstimateBadge reads the scale deck from it via context.
    estimationService.getEstimationConfig(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    // Epic/parent subtree roll-up (Subtask 4.3.5) — one bounded recursive-CTE
    // aggregate, ONLY when the item has children. A leaf shows none.
    detail.children.length > 0
      ? estimationService.rollupForParent(item.id, {
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        })
      : null,
    getLocale() as Promise<Locale>,
    // Work-item references (Story 5.8 · 5.8.6) — every `[KEY](motir:<id>)` in
    // the description / explanation and every bare `MOTIR-N` in the title,
    // resolved to its LIVE summary so the body chips render live and open the
    // peek. TIER TWO because the prose bodies are, and a chip that arrives
    // after its paragraph is a reflow inside text the reader is already reading.
    workItemsService.resolveReferenceSummaries(
      parseWorkItemRefs(
        [item.title, item.descriptionMd, item.explanationMd].filter(Boolean).join('\n'),
        ctx.project.identifier,
      ),
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    ),
  ]);

  const activeSprint = sprints.find((s) => s.state === 'active') ?? null;

  // Archived state (Story 2.9 · Subtask 2.9.6) — an archived item's detail page
  // renders (the read doesn't filter `archivedAt`), so it gets a top-of-main
  // banner + an eyebrow chip as the archived-state signal. The WHEN is formatted
  // server-side (locale-aware, the same `formatDate` the 2.9.3 list view uses);
  // the WHO rides `detail.archivedBy` (latest `'archived'` revision).
  const isArchived = item.archivedAt != null;
  // The item's status CATEGORY (bug MOTIR-2084) — resolved through the workflow
  // the detail bundle already carries, the same lookup `CoreFieldsPanel` does for
  // the Sprint field's empty label. The category, never the `'done'` KEY: this
  // project's workflow already has two done-category statuses (Done, Cancelled)
  // and a project may define more.
  const statusCategory =
    detail.workflow.statuses.find((s) => s.key === item.status)?.category ?? null;
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
            {/* data-testid: the header identifier is asserted by several E2E
              journeys; the bare text is no longer unique on the page (the
              Development empty-state copy also names the key — MOTIR-1579). */}
            <span
              data-testid="item-identifier"
              className="text-(--el-text-muted) font-mono text-sm"
            >
              {item.identifier}
            </span>
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
              {/* MOTIR-910: the per-item Plan / Re-plan door — FIRST in the
                right cluster, before Watch / ⋯ (the plan-replan-entrance
                mockup's panel-1 placement). Plan when the item has no children
                yet, Re-plan when it does. BOTH whether it renders and which face
                it wears are the entrance's own call (`planEntranceFace`,
                MOTIR-2084 + MOTIR-2097) — this page just hands over the item
                state: the actor's capability, the archived flag (MOTIR-2050),
                the terminal status category, and the kind + children/description
                the face is picked from. */}
              <WorkItemPlanEntrance
                itemKey={item.identifier}
                hasChildren={detail.children.length > 0}
                kind={item.kind}
                hasDescription={(item.descriptionMd ?? '').trim().length > 0}
                canPlan={canEdit}
                archived={isArchived}
                statusCategory={statusCategory}
              />
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
                on canEdit, Archive + Delete on canDelete. 2.9.11: on an archived
                item the menu swaps Archive→Restore and Delete… opens the
                archived confirm. */}
              <WorkItemDetailActions
                itemId={item.id}
                identifier={item.identifier}
                title={item.title}
                canEdit={canEdit}
                canArchive={canArchive}
                canDelete={canDelete}
                archived={isArchived}
                activeSprintId={activeSprint?.id ?? null}
                activeSprintName={activeSprint?.name ?? null}
                inActiveSprint={activeSprint != null && item.sprintId === activeSprint.id}
              />
            </div>
          </div>
          <h1 className="text-(--el-text) font-serif text-2xl font-semibold">
            <WorkItemTitle
              title={item.title}
              projectIdentifier={ctx.project.identifier}
              workItemRefs={workItemRefs}
            />
          </h1>
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
                <MarkdownView
                  value={item.descriptionMd}
                  aria-label={t('issueDescriptionAria')}
                  workItemRefs={workItemRefs}
                />
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
              workItemRefs={workItemRefs}
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
              // MOTIR-2050: the page already knows the archived state (the banner
              // above renders off it) — pass it down so the readiness badge is
              // suppressed too, instead of contradicting the banner.
              archived={isArchived}
              workflow={detail.workflow}
              editable={canEdit}
              currentItemId={item.id}
              identifier={item.identifier}
            />
            {/* 7.10.11 (MOTIR-1579): the Development section — linked PRs with
              PR/CI state, per design/github Panel 5a: a ContentSectionCard after
              Relationships (the linkage cluster), same shared body as the peek.
              7.10.14 (MOTIR-1596): the explicit-link affordance — the "+ Link
              pull request" door (header) + inline picker (body) share state via
              the provider; gated on canEdit (a read-only actor sees no door and
              the caption drops the "or linked by hand" clause). The peek stays
              read-only (no door). */}
            {/* THE LATE STACK, upper half — Development · Acceptance · Design
              result (Subtask MOTIR-3436). Both halves await the SAME
              `lateReads` promise, so they resolve in one tick and the page
              settles ONCE for the whole stack, as the design decided. They are
              two boundaries only because `ChildPanel` below is TIER TWO and the
              page renders it between them. */}
            <Suspense fallback={<LateUpperFallback />}>
              <LateUpperSections
                reads={lateReads}
                itemId={item.id}
                itemIdentifier={item.identifier}
                canEdit={canEdit}
                repoDelivery={deliveryView.repos}
                deliveries={deliveryView.deliveries}
              />
            </Suspense>
            <ChildPanel
              count={detail.children.length}
              itemId={item.id}
              itemIdentifier={item.identifier}
              projectKey={ctx.project.identifier}
            >
              <ChildList items={detail.children} workflow={detail.workflow} members={members} />
            </ChildPanel>
            {/* 5.2.5: the Attachments panel — after Children, before Activity
              (the reserved Epic-5 slot, per the attachments mockup's panel 0;
              content-width and multi-row, so the left column — the rail is
              for scalars). */}
            {/* THE LATE STACK, lower half — Attachments · Activity. KEYED on the
              activity tab so switching `?activity=` re-shows the fallback
              instead of freezing on the previous tab's content (the shipped
              `/items` pattern). */}
            <Suspense key={activityTab} fallback={<LateLowerFallback />}>
              <LateLowerSections
                reads={lateReads}
                itemId={item.id}
                currentUserId={ctx.userId}
                currentUserName={session.user.name}
                workflowStatuses={detail.workflow.statuses}
                mentionCandidates={members.map((m) => ({
                  id: m.userId,
                  name: m.name,
                  email: m.email,
                }))}
                activityTab={activityTab}
              />
            </Suspense>
          </main>

          <aside className="flex flex-col gap-4">
            <CoreFieldsPanel
              item={item}
              members={members}
              workflow={detail.workflow}
              parent={detail.parent}
              reporterIsSelf={item.reporterId === ctx.userId}
              customFields={detail.customFields}
              repoDelivery={deliveryView.repos}
              deliveries={deliveryView.deliveries}
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
      {/* The shared quick-view (peek) modal — driven by `?peek=<identifier>`.
        Mounted here so the RelationshipsPanel rows can open a linked item in
        the same peek used on the list/board/ready surfaces (8.8.31), without
        navigating away from this detail page. */}
      <IssueQuickViewController />
    </EstimationConfigProvider>
  );
}
