'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { isIssueType } from '@/lib/issues/parentRules';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { IllegalParentTypeError, WorkItemError } from '@/lib/workItems/errors';
import type { WorkItemKindDto, WorkItemPriorityDto, WorkItemSummaryDto } from '@/lib/dto/workItems';

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
  priority?: WorkItemPriorityDto;
  // Accepted for forward-compat but NOT yet surfaced in the modal: the filtered
  // parent picker is 2.3.4, the assignee combobox a later subtask. Until those
  // land the modal omits them and an issue is created top-level + unassigned.
  parentId?: string | null;
  assigneeId?: string | null;
}

export type CreateIssueResult =
  | { ok: true; id: string; identifier: string }
  | { ok: false; error: string; field?: 'parent' };

export async function createIssueAction(input: CreateIssueInput): Promise<CreateIssueResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'Pick or create a project before adding an issue.' };

  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: 'Give the issue a title.' };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` };
  }

  try {
    const issue = await workItemsService.createWorkItem(
      {
        projectId: ctx.projectId,
        kind: input.kind,
        title,
        descriptionMd: input.descriptionMd?.trim() ? input.descriptionMd : null,
        parentId: input.parentId ?? null,
        assigneeId: input.assigneeId ?? null,
        ...(input.priority ? { priority: input.priority } : {}),
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId }, // reporter = session user
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, id: issue.id, identifier: issue.identifier };
  } catch (err) {
    // An illegal parent is a field-level problem — surface it inline on the
    // parent picker, not as a toast.
    if (err instanceof IllegalParentTypeError)
      return { ok: false, error: err.message, field: 'parent' };
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, error: 'That project no longer exists.' };
    }
    // Any other typed work-item error (cross-project parent, assignee/reporter
    // not a member, …) surfaces as a toast with its own message.
    if (err instanceof WorkItemError) return { ok: false, error: err.message };
    throw err;
  }
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
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'Pick or create a project before choosing a parent.' };
  if (!isIssueType(childType)) return { ok: false, error: 'Unknown issue type.' };

  const candidates = await workItemsService.listCandidateParents(
    ctx.projectId,
    childType,
    ctx.workspaceId,
  );
  return { ok: true, candidates };
}
