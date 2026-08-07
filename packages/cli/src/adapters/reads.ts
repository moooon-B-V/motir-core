import type { SuccessBody } from '../transport.js';
import type {
  ActivityAllPage,
  CompleteSessionResult,
  DispatchAdvisory,
  DispatchPrompt,
  ExpandSubmitResult,
  ActivityComment,
  ActivityCommentThread,
  ActivityEntry,
  ActivityHistoryPage,
  ActivityPart,
  ActivityValue,
  CommentsPage,
  ProjectList,
  ProjectSummary,
  ReadyItemSummary,
  ReadyPage,
  SprintList,
  SprintSummary,
  WhoamiResult,
  WorkItemChild,
  WorkItemDetail,
  WorkItemLink,
  WorkItemSummary,
} from '../mcpClient.js';

// The READ ADAPTERS — wire shapes in, the CLI's own view models out
// (Story 11.5 · Subtask 11.5.4 — MOTIR-2212).
//
// ⚠️ THIS MODULE AND `src/transport.ts` ARE THE ONLY FILES THAT MAY SEE A
// GENERATED WIRE TYPE. That is `docs/decisions/cli-v1-client.md` Q4, and
// `tests/cli/generated-api-freshness.test.ts` enforces it over the real import
// graph rather than by review.
//
// ── Why an adapter layer exists at all ──────────────────────────────────────
// The two surfaces genuinely disagree about shape. MCP handed back a nested
// aggregate with a `parent`, an `ancestors` array of full summaries and three
// separate edge arrays; v1 hands back a flat item, a list of ancestor KEYS and
// one grouped `links` object. Both are reasonable. Neither can be swapped for
// the other in place, so something must translate — and the whole safety
// property of this story is that the something is ONE named module instead of a
// hundred small accommodations spread through `render.ts`.
//
// `render.ts` does not change. A diff on it fails this card. Every disagreement
// between the surfaces therefore has to surface HERE, where a test can see it.
//
// ── The rule these functions follow ─────────────────────────────────────────
// A view-model field with no reader is DROPPED, never fabricated from a value
// the wire did not send. This slice drops a project's `id` and `slug`, each
// verified by grep across `packages/cli/src` to have no consumer. Inventing a
// plausible-looking value would have been the easy path and would have put a lie
// one layer below every renderer.
//
// ── It grows one SLICE at a time ────────────────────────────────────────────
// It arrived with the IDENTITY mappers (11.5.4), gained the COLLECTION ones
// (11.5.21), and is completed by the detail + activity reshapes (11.5.22) —
// one module for the whole boundary, which was the point.

/**
 * The literal `?assigneeId=` takes to mean the UNASSIGNED bucket.
 *
 * Declared here because it is a WIRE value, and the boundary is this module's
 * job. The ready filter is TRI-STATE and all three states are reachable: the
 * parameter absent means any assignee, this literal means the unassigned
 * bucket, and a user id means that user. An empty value would be
 * indistinguishable from omitting it, which is why the bucket needs a name.
 */
export const UNASSIGNED = 'none';

/** `GET /api/v1/me`'s body. */
type MeBody = SuccessBody<'getMe'>;
/** `GET /api/v1/workspaces`'s body. */
type WorkspacesBody = SuccessBody<'listWorkspaces'>;
/** One page of `GET /api/v1/projects`. */
type ProjectsBody = SuccessBody<'listProjects'>;
/** One page of the ready set. */
type ReadyBody = SuccessBody<'getProjectReadySet'>;
/** One page of a project's sprints. */
type SprintsBody = SuccessBody<'listProjectSprints'>;
/** The work-item detail aggregate. */
type DetailBody = SuccessBody<'getWorkItem'>;
/** One page of the activity stream, in whichever view was asked for. */
type ActivityBody = SuccessBody<'getWorkItemActivity'>;

/** One row of a paged body, with the envelope's optional `items` resolved. */
type RowOf<B extends { items?: unknown[] }> = NonNullable<B['items']>[number];

/**
 * The rows a paged body carries.
 *
 * The generated envelope types `items` as optional because the page envelope and
 * the item schema compose through `allOf`; the server always sends it.
 */
function rowsOf<B extends { items?: unknown[] }>(body: B): RowOf<B>[] {
  return (body.items ?? []) as RowOf<B>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `whoami` — the token's user, plus the ONE workspace it is bound to.
 *
 * Two reads rather than one, because v1 splits them: `/me` names the workspace
 * by id and `/workspaces` describes it. The workspace is found BY THAT ID and
 * not assumed to be the first row — a user belongs to as many workspaces as they
 * belong to, and the token is bound to exactly one of them.
 *
 * `null` when the bound workspace is not in the list, which is the answer the
 * MCP tool gave too: a client that cannot see the workspace renders no
 * workspace, rather than a wrong one.
 */
export function toWhoami(me: MeBody, workspaces: WorkspacesBody): WhoamiResult {
  const bound = rowsOf(workspaces).find((workspace) => workspace.id === me.workspaceId);
  return {
    user: { id: me.user.id, name: me.user.name, email: me.user.email },
    workspace: bound ? { id: bound.id, name: bound.name, slug: bound.slug } : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One project row.
 *
 * `id` and `slug` are DROPPED, not sourced: no file in `packages/cli/src` reads
 * either, and both are deliberately absent from the v1 project resource — `id`
 * by ADR §7, `slug` because nothing addresses a project by it. Carrying a
 * made-up value forward would freeze two dead fields into the CLI's contract.
 */
export function toProjectSummary(project: RowOf<ProjectsBody>): ProjectSummary {
  return { key: project.key, name: project.name, accessLevel: project.accessLevel };
}

/** A whole project list, assembled from every page the caller walked. */
export function toProjectList(pages: readonly ProjectsBody[]): ProjectList {
  const projects: ProjectSummary[] = [];
  for (const page of pages) projects.push(...rowsOf(page).map(toProjectSummary));
  return { projects };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ready set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One page of the ready set.
 *
 * The ORDER is the server's — the dispatch rank `(type asc, priority desc, key
 * asc)` — and passes through untouched. A client that re-sorted here would be
 * re-deriving the decision the ready endpoint exists to own.
 *
 * `assignee` is the minimal actor object MOTIR-2279 put on the row. The view
 * model's optional `dependencies` is always present from a v1 server: the wire
 * block is total, two arrays, empty rather than missing.
 */
export function toReadyPage(body: ReadyBody): ReadyPage {
  const items: ReadyItemSummary[] = rowsOf(body).map((row) => ({
    key: row.key,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    assignee: row.assignee === null ? null : { id: row.assignee.id, name: row.assignee.name },
    dependencies: {
      blockedBy: row.dependencies.blockedBy.map((edge) => ({ ...edge })),
      blocks: row.dependencies.blocks.map((edge) => ({ ...edge })),
    },
  }));
  // ⚠️ The cursor is OPAQUE and collection-scoped: echoed, never parsed, never
  // handed to another collection's read.
  return { items, nextCursor: body.nextCursor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprints
// ─────────────────────────────────────────────────────────────────────────────

/** One sprint row — a field-for-field carry; the two shapes agree. */
export function toSprintSummary(sprint: RowOf<SprintsBody>): SprintSummary {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    goal: sprint.goal,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    sequence: sprint.sequence,
    issueCount: sprint.issueCount,
    // Passed THROUGH, never defaulted: null means "never activated", and a
    // `?? 0` here would report a scope-lock baseline that was never taken.
    committedPoints: sprint.committedPoints,
    committedIssueCount: sprint.committedIssueCount,
  };
}

/** A whole sprint list, assembled from every page the caller walked. */
export function toSprintList(pages: readonly SprintsBody[]): SprintList {
  const sprints: SprintSummary[] = [];
  for (const page of pages) sprints.push(...rowsOf(page).map(toSprintSummary));
  return { sprints };
}

// ─────────────────────────────────────────────────────────────────────────────
// The work-item detail aggregate — the sharpest reshape
// ─────────────────────────────────────────────────────────────────────────────

/** A v1 work-item REFERENCE as the CLI's summary shape. */
function toSummary(ref: {
  key: string;
  kind: string;
  title: string;
  status: string;
}): WorkItemSummary {
  return { identifier: ref.key, kind: ref.kind, title: ref.title, status: ref.status };
}

/**
 * The detail aggregate.
 *
 * Three reshapes, each recorded where it happens:
 *
 * • `ancestorKeys` → `ancestors`. The wire sends keys; `renderLineage` reads
 *   `.identifier` and nothing else, so the view model's element type narrowed to
 *   `{ identifier }` rather than this function inventing a kind/title/status.
 * • `links` (five groups of refs) → the three arrays the CLI declares. `linkId`
 *   is gone from the view model — nothing read it, and v1 does not publish it.
 * • `readiness.blockedByAncestorKey` + `…Title` → one `{ identifier, title }`.
 *   The two are null together on the wire, so the object is null or complete.
 */
export function toWorkItemDetail(body: DetailBody): WorkItemDetail {
  const children: WorkItemChild[] = body.children.map((child) => ({
    ...toSummary(child),
    dependencies: {
      blockedBy: child.dependencies.blockedBy.map((edge) => ({ ...edge })),
      blocks: child.dependencies.blocks.map((edge) => ({ ...edge })),
    },
  }));

  const link = (ref: Parameters<typeof toSummary>[0]): WorkItemLink => ({ item: toSummary(ref) });
  const ancestorKey = body.readiness.blockedByAncestorKey;

  return {
    item: {
      identifier: body.key,
      kind: body.kind,
      title: body.title,
      status: body.status,
      priority: body.priority,
      assigneeId: body.assigneeId,
      type: body.type,
      executor: body.executor,
      storyPoints: body.storyPoints,
      estimateMinutes: body.estimateMinutes,
      targetRepo: body.targetRepo,
      sprintId: body.sprintId,
      descriptionMd: body.descriptionMd,
    },
    ancestors: body.ancestorKeys.map((key) => ({ identifier: key })),
    children,
    blockedBy: body.links.blockedBy.map(link),
    blocks: body.links.blocks.map(link),
    relatesTo: body.links.relatesTo.map(link),
    readiness: {
      ready: body.readiness.ready,
      openBlockers: body.readiness.openBlockers.map(toSummary),
      blockedByAncestor:
        ancestorKey === null
          ? null
          : { identifier: ancestorKey, title: body.readiness.blockedByAncestorTitle ?? '' },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The activity stream
// ─────────────────────────────────────────────────────────────────────────────

/** One wire activity entry, whichever arm of the union it is. */
type WireEntry = RowOf<ActivityBody>;
/** The `comment` arm's payload. */
type WireCommentThread = Extract<WireEntry, { type: 'comment' }>['comment'];
/** The `change` arm's payload. */
type WireChange = Extract<WireEntry, { type: 'change' }>['change'];
/** One wire activity VALUE. */
type WireValue = Extract<WireChange['parts'][number], { kind: 'field' }>['from'];

/**
 * One resolved value inside a history entry.
 *
 * The CLI's `ActivityValue` is deliberately LOOSER than the wire's closed union
 * — `type` a `string` with optional members — because the CLI is published to
 * npm on its own release train and routinely meets a server NEWER than itself.
 * `activityValueText`'s default branch has to stay REACHABLE; a faithful
 * re-narrowing here would make it unreachable-by-type and turn an unfamiliar
 * value into a crash instead of a generic rendering.
 *
 * The one RENAME: the wire's `workItemKey` becomes `identifier`, which is what
 * `render.ts:850` reads.
 */
function toActivityValue(value: WireValue): ActivityValue {
  switch (value.type) {
    case 'text':
      return { type: 'text', text: value.text };
    case 'status':
      return { type: 'status', key: value.key, label: value.label };
    case 'user':
      return { type: 'user', userId: value.userId, name: value.name };
    case 'date':
      return { type: 'date', date: value.date };
    case 'sprint':
      return { type: 'sprint', sprintId: value.sprintId, name: value.name };
    case 'issue':
      return { type: 'issue', identifier: value.workItemKey };
    default:
      return { type: value.type };
  }
}

/** One renderable piece of a history entry. */
function toActivityPart(part: WireChange['parts'][number]): ActivityPart {
  switch (part.kind) {
    case 'field':
      return {
        kind: 'field',
        field: part.field,
        from: toActivityValue(part.from),
        to: toActivityValue(part.to),
      };
    case 'fieldEdited':
      return { kind: 'fieldEdited', field: part.field };
    case 'link':
      return {
        kind: 'link',
        op: part.op,
        linkKind: part.linkKind,
        target: toActivityValue(part.target),
      };
    case 'collection':
      return { kind: 'collection', field: part.field, op: part.op, items: [...part.items] };
    case 'commentDeleted':
      return {
        kind: 'commentDeleted',
        author: toActivityValue(part.author),
        replyCount: part.replyCount,
      };
    case 'generic':
      return { kind: 'generic', key: part.key, from: part.from, to: part.to };
    default:
      // `created` / `archived` / `unarchived` carry nothing but their kind, and
      // so does any kind a newer server invents.
      return { kind: part.kind };
  }
}

/** One CHANGE-trail entry. */
function toActivityEntry(change: WireChange): ActivityEntry {
  return {
    id: change.id,
    changeKind: change.changeKind,
    changedAt: change.changedAt,
    actor: { userId: change.actor.userId, name: change.actor.name },
    parts: change.parts.map(toActivityPart),
  };
}

/** One comment, without its replies. */
function toComment(comment: Omit<WireCommentThread, 'replies'>): ActivityComment {
  return {
    id: comment.id,
    author: { id: comment.author.id, name: comment.author.name },
    bodyMd: comment.bodyMd,
    editedAt: comment.editedAt,
    createdAt: comment.createdAt,
  };
}

/** A root comment with its single-level replies. */
function toCommentThread(thread: WireCommentThread): ActivityCommentThread {
  return { ...toComment(thread), replies: thread.replies.map(toComment) };
}

/**
 * The merged `all` page.
 *
 * `totalComments` / `totalChanges` are what MOTIR-2320 put on the wire, and they
 * are why that card exists: `renderActivityStream`'s footer derives "44 more
 * comments, 16 more changes" as `total − shown`, which the page's own item
 * counts cannot supply. They are nullable on the wire because the NARROW views
 * do not count both sources; on THIS view the server always sends both.
 */
export function toActivityAllPage(body: ActivityBody): ActivityAllPage {
  return {
    entries: rowsOf(body).map((entry) =>
      entry.type === 'comment'
        ? ({ type: 'comment', thread: toCommentThread(entry.comment) } as const)
        : ({ type: 'history', entry: toActivityEntry(entry.change) } as const),
    ),
    nextCursor: body.nextCursor,
    totalComments: body.totalComments ?? 0,
    totalChanges: body.totalChanges ?? 0,
  };
}

/**
 * The `comments` page.
 *
 * `order` is not on the wire and does not need to be: it is what the CLI ITSELF
 * asked for, so echoing the requested value (or this view's shipped default,
 * `asc`) reports the direction the page was actually read in without inventing a
 * fact the server never stated.
 */
export function toCommentsPage(body: ActivityBody, order: 'asc' | 'desc'): CommentsPage {
  const threads = rowsOf(body)
    .filter((entry): entry is Extract<WireEntry, { type: 'comment' }> => entry.type === 'comment')
    .map((entry) => toCommentThread(entry.comment));
  return { threads, nextCursor: body.nextCursor, totalCount: body.totalCount, order };
}

/** The `history` page. */
export function toActivityHistoryPage(body: ActivityBody): ActivityHistoryPage {
  const entries = rowsOf(body)
    .filter((entry): entry is Extract<WireEntry, { type: 'change' }> => entry.type === 'change')
    .map((entry) => toActivityEntry(entry.change));
  return { entries, nextCursor: body.nextCursor, totalCount: body.totalCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// The dispatch + session operations (Subtask 11.5.5 — MOTIR-2213)
// ─────────────────────────────────────────────────────────────────────────────

/** The assembled dispatch prompt. */
type PromptBody = SuccessBody<'getWorkItemDispatchPrompt'>;
/** The bulk session close-out. */
type CloseOutBody = SuccessBody<'completeSession'>;
/** The planner job handle an expansion submit returns. */
type JobHandleBody = SuccessBody<'submitWorkItemExpansion'>;

/**
 * The dispatch prompt.
 *
 * `targetRepoCloneUrl` and `targetRepoDefaultBranch` are DROPPED: nothing in
 * `packages/cli/src` reads either, and a view-model field with no reader is not
 * carried over. `resolveDispatchTarget` routes on `targetRepo` alone.
 *
 * ⚠️ `advisories` is re-shaped by PASSING THROUGH, deliberately. The wire's
 * union is open — `severity` is a bare string, and ADR §8 documents it as
 * open-ended — so a build that has never heard of a severity must hand the
 * object to `renderDispatchAdvisories` intact and let its fall-through print
 * nothing. Narrowing here would turn a forward-compatible client into one that
 * drops, or crashes on, the next advisory type someone adds.
 */
export function toDispatchPrompt(body: PromptBody): DispatchPrompt {
  return {
    key: body.key,
    prompt: body.prompt,
    targetRepo: body.targetRepo,
    workflowMode: body.workflowMode,
    sessionBranch: body.sessionBranch,
    advisories: body.advisories as DispatchAdvisory[],
  };
}

/**
 * The bulk close-out result.
 *
 * The per-item outcomes are reported VERBATIM — the client never re-derives one.
 * A partial close (some items done, others refused with a reason) is a real
 * answer the server computed transactionally, not a failure to smooth over.
 */
export function toCompleteSessionResult(body: CloseOutBody): CompleteSessionResult {
  return {
    sessionBranch: body.sessionBranch,
    results: body.results.map((result) => ({
      key: result.key,
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    })),
  };
}

/**
 * The planner job handle.
 *
 * `statusUrl` is dropped for the reason the prompt's two extra fields are: no
 * reader. The CLI submits and returns; `motir auto --include-planning` never
 * polls, because what comes back is a plan a human must approve.
 */
export function toExpandSubmitResult(body: JobHandleBody): ExpandSubmitResult {
  return { jobId: body.jobId, planId: body.planId };
}
