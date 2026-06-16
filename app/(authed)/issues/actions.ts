'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { isIssueType } from '@/lib/issues/parentRules';
import { isRelationshipKind } from '@/lib/workItems/linkRelationships';
import { parseSort } from '@/lib/issues/issueListView';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  IllegalParentTypeError,
  WorkItemError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { WorkItemLinkError } from '@/lib/workItems/linkErrors';
import type {
  CreateWorkItemLinkInput,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  ExecutorDto,
  WorkItemSummaryDto,
  TreeLevelDto,
  PagedArchivedWorkItemsDto,
} from '@/lib/dto/workItems';

// Server Actions for the create-issue surface (Subtask 2.3.3). Transport only:
// resolve the session + the ACTIVE project (the shipped shell has no
// `projects/[key]` route tree — projects are resolved from the workspace
// context, the same model 2.2.5's workflow settings use), call the ONE shipped
// service method (`workItemsService.createWorkItem`, Story 1.4 — it owns key
// allocation, initial-status seeding, the parent gate, and the create
// revision), and translate typed errors. NO business logic, NO service
// extension. The reporter is ALWAYS the session user, set here from the
// resolved context — never read from the client payload.

const ISSUES_PATH = '/issues';
const MAX_TITLE_LENGTH = 200;

/** The whitelisted fields the modal submits. Anything else on the wire (e.g. a
 *  forged `reporterId`) is dropped — only these named fields reach the service. */
export interface CreateIssueInput {
  kind: WorkItemKindDto;
  title: string;
  descriptionMd?: string | null;
  // The "why this matters" axis (Story 1.4). Optional at create time (the modal
  // exposes it as a collapsible section per design/work-items/create.png); when
  // a human types it, the service defaults explanationSource to user_authored.
  // AI drafting ("Draft with AI") is the Epic-7 planning layer.
  explanationMd?: string | null;
  priority?: WorkItemPriorityDto;
  // Accepted for forward-compat but NOT yet surfaced in the modal: the filtered
  // parent picker is 2.3.4, the assignee combobox a later subtask. Until those
  // land the modal omits them and an issue is created top-level + unassigned.
  parentId?: string | null;
  assigneeId?: string | null;
  // Work-item type + executor (Story 2.7), leaf-only. The modal sends them only
  // when a type was chosen on a leaf kind; the service enforces leaf-only and
  // seeds the executor from the type→executor default when a type arrives
  // without one (seed-if-absent). Whitelisted here so they actually reach the
  // service — omitting them silently dropped the picker's choice on create
  // (the patch/inline-edit path persisted type, but create did not).
  type?: WorkItemTypeDto | null;
  executor?: ExecutorDto | null;
  // Optional Due date (Subtask 2.3.12 — the modal's DatePicker field; finding
  // #56 "mirror Jira"). An ISO 8601 string the service stores on the work item;
  // omitted/null when no date is chosen (Due date is nullable).
  dueDate?: string | null;
  // Links to create with the issue (Subtask 2.4.10 — the modal's "Linked
  // issues" section). Each is the user-facing (relationship, target) pair; the
  // service resolves direction + writes them atomically with the item. Validated
  // here against the five relationship kinds before reaching the service.
  links?: CreateWorkItemLinkInput[];
}

export type CreateIssueResult =
  | { ok: true; id: string; identifier: string }
  | { ok: false; error: string; field?: 'parent' | 'links' };

export async function createIssueAction(input: CreateIssueInput): Promise<CreateIssueResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.noProjectForIssue') };

  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: t('actions.titleRequired') };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: t('actions.titleTooLong', { max: MAX_TITLE_LENGTH }) };
  }

  // Whitelist the pending links: keep only well-formed (relationship, target)
  // pairs (a forged relationship / empty target is dropped before the service).
  const links = (input.links ?? []).filter(
    (l): l is CreateWorkItemLinkInput => Boolean(l.targetId) && isRelationshipKind(l.relationship),
  );

  try {
    const issue = await workItemsService.createWorkItem(
      {
        projectId: ctx.projectId,
        kind: input.kind,
        title,
        descriptionMd: input.descriptionMd?.trim() ? input.descriptionMd : null,
        explanationMd: input.explanationMd?.trim() ? input.explanationMd : null,
        parentId: input.parentId ?? null,
        assigneeId: input.assigneeId ?? null,
        ...(input.priority ? { priority: input.priority } : {}),
        // Type + executor (Story 2.7), leaf-only: forward only when a type was
        // chosen, mirroring the modal's payload shape. `executor` rides along
        // (the service seeds it from the type default if absent).
        ...(input.type
          ? { type: input.type, ...(input.executor ? { executor: input.executor } : {}) }
          : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(links.length ? { links } : {}),
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId }, // reporter = session user
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, id: issue.id, identifier: issue.identifier };
  } catch (err) {
    // An illegal parent is a field-level problem — surface it inline on the
    // parent picker, not as a toast.
    if (err instanceof IllegalParentTypeError)
      return { ok: false, error: workItemErrorMessage(err, t), field: 'parent' };
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, error: t('actions.projectGone') };
    }
    // A bad pending link (cycle / cross-workspace / duplicate) aborts the whole
    // create (one transaction — the issue is NOT created) and surfaces inline on
    // the Linked-issues section. WorkItemLinkError is its OWN hierarchy (not a
    // WorkItemError), so this branch precedes the generic one below.
    if (err instanceof WorkItemLinkError) {
      return {
        ok: false,
        error: linkErrorMessage(err, t) ?? t('actions.couldNotLink'),
        field: 'links',
      };
    }
    // Any other typed work-item error (cross-project parent, assignee/reporter
    // not a member, …) surfaces as a toast with its own message.
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    throw err;
  }
}

export type ListCreateLinkCandidatesResult =
  | { ok: true; candidates: WorkItemSummaryDto[] }
  | { ok: false; error: string };

/**
 * Candidate target issues for the create modal's "Linked issues" picker
 * (Subtask 2.4.10; server-search since 6.9.2): the 6.9.1 quick-search by `query`
 * (key + title, workspace + 6.4-permission-scoped, bounded) — the Combobox
 * fetches this per keystroke, an empty / short query returns `[]`. No current
 * item to exclude (the issue isn't created yet); the modal drops already-pending
 * targets client-side. Resolves the active project server-side, like
 * createIssueAction.
 */
export async function listCreateLinkCandidatesAction(
  query: string,
): Promise<ListCreateLinkCandidatesResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: (await getErrorsTranslator())('actions.pickProjectFirst') };

  const candidates = await workItemsService.listCreateLinkCandidates(query, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return { ok: true, candidates };
}

export type ListCandidateParentsResult =
  | { ok: true; candidates: WorkItemSummaryDto[] }
  | { ok: false; error: string };

/**
 * Candidate parents for the parent picker (Subtask 2.3.4): the active project's
 * non-archived work items whose kind may legally hold a `childType`, pre-
 * filtered by the inverted kind-parent matrix so the UI can't construct an
 * illegal pair. Resolves the active project server-side (same active-project
 * model as createIssueAction); `childType` is validated against the issue-type
 * set before it reaches the service.
 */
export async function listCandidateParentsAction(
  childType: string,
): Promise<ListCandidateParentsResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.noProjectForParent') };
  if (!isIssueType(childType)) return { ok: false, error: t('actions.unknownIssueType') };

  const candidates = await workItemsService.listCandidateParents(
    ctx.projectId,
    childType,
    ctx.workspaceId,
  );
  return { ok: true, candidates };
}

// ── Lazy tree reads (Subtask 2.5.14, finding #57) ──────────────────────────
// Transport for the lazy Tree view: the client fetches ONE level on expand /
// "load more" / sort change. Resolve the session + active project, parse the
// sort through the trusted whitelist (never the client's raw value), call the
// shipped 2.5.13 read, return the level. `listChildIssues` gates the parent by
// workspace in the service (a cross-workspace/missing parent → a not-found,
// surfaced here as a benign error, never a leak).

/** `?sort=`-string in (parsed through the whitelist) + an offset for paging. */
export interface ListTreeLevelInput {
  sortParam: string;
  offset?: number;
}

export type TreeLevelResult = { ok: true; level: TreeLevelDto } | { ok: false; error: string };

export async function listRootIssuesAction(input: ListTreeLevelInput): Promise<TreeLevelResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  const level = await workItemsService.listRootIssues(
    ctx.projectId,
    { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
  return { ok: true, level };
}

export async function listChildIssuesAction(
  input: ListTreeLevelInput & { parentId: string },
): Promise<TreeLevelResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const level = await workItemsService.listChildIssues(
      input.parentId,
      { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, level };
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return { ok: false, error: 'That issue no longer exists.' };
    }
    throw err;
  }
}

// ── Archived items read (Story 2.9 · Subtask 2.9.2) ────────────────────────
// Transport for the archive-management surface (the view UI is 2.9.3): resolve
// the session + active project, call the shipped read, return the page. The
// service gates on `canBrowse` and treats a cross-workspace/missing project as
// a not-found (surfaced here as a benign error, never a leak). `page` is the
// 1-based pager position; the service clamps it to the last page.

/** 1-based page of the archived view (defaults to page 1). */
export interface ListArchivedWorkItemsInput {
  page?: number;
}

export type ListArchivedWorkItemsResult =
  | { ok: true; data: PagedArchivedWorkItemsDto }
  | { ok: false; error: string };

export async function listArchivedWorkItemsAction(
  input: ListArchivedWorkItemsInput = {},
): Promise<ListArchivedWorkItemsResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const data = await workItemsService.listArchivedWorkItems(
      ctx.projectId,
      { page: input.page },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, error: 'That project no longer exists.' };
    }
    throw err;
  }
}
