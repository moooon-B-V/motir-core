import type {
  User,
  Workspace,
  WorkItem,
  WorkItemKind,
  WorkItemLink,
  WorkItemLinkKind,
} from '@prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkspace } from './workspaceFixtures';
import { createTestProject } from './projectFixtures';

// Shared test fixtures — work items + links, and the bundled top-level
// fixture every work-item test starts from (Subtask 1.4.7).
//
// Before 1.4.7 each of the four work-item test files (repository /
// link-repository / service / revisions) carried its own near-identical
// `makeFixture` + `createWorkItem` + `createLink` trio. They're unified here
// so the suite has ONE source of truth and 1.4.8's Story-level E2E can build
// on the same primitives. Everything runs against the REAL Postgres (no
// mocks) through the repository edge — `createTestWorkItem` reproduces the
// allocate-key-then-create dance the service performs, which lets a test
// drive the DB triggers directly (the "trigger fires regardless of path"
// angle) without going through workItemsService.

/**
 * The bundle returned by {@link makeWorkItemFixture}: a user + workspace +
 * project plus the flattened ids and a ready-to-use ServiceContext. The shape
 * is a deliberate superset of the two historical `makeFixture` return shapes —
 * the repository tests destructured `{ owner, workspace, project }`, the
 * service/revision tests destructured `{ ownerId, workspaceId, projectId, ctx }`
 * — so both styles work unchanged against the unified fixture.
 */
export interface WorkItemFixture {
  owner: User;
  workspace: Workspace;
  project: ProjectDTO;
  ownerId: string;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  ctx: ServiceContext;
}

export interface MakeWorkItemFixtureOptions {
  /** Workspace name (default 'Acme'). */
  name?: string;
  /** Project identifier prefix (default 'PROD' → items read as PROD-1, …). */
  identifier?: string;
}

/**
 * Build the standard work-item test substrate: a fresh user owning a fresh
 * workspace containing a fresh project. The default identifier 'PROD' keeps
 * item identifiers reading as PROD-1, PROD-2, … (several assertions depend on
 * that). Pass `name` + `identifier` when a test needs two independent tenants
 * (e.g. the cross-workspace link case).
 */
export async function makeWorkItemFixture(
  opts: MakeWorkItemFixtureOptions = {},
): Promise<WorkItemFixture> {
  const { workspace, owner } = await createTestWorkspace({ name: opts.name ?? 'Acme' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    identifier: opts.identifier ?? 'PROD',
  });
  return {
    owner,
    workspace,
    project,
    ownerId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ctx: { userId: owner.id, workspaceId: workspace.id },
  };
}

export interface CreateTestWorkItemInput {
  kind: WorkItemKind;
  title: string;
  parentId?: string | null;
}

/**
 * Create a work item the way the service does: allocate the per-project key
 * inside a transaction, derive the identifier, and insert the row — all
 * through the repository (which surfaces the DB triggers as typed errors).
 * `position` is a zero-padded key string: lexicographically stable and
 * sufficient for the structural-trigger tests, which never assert ordering.
 * (Tests that DO care about fractional ordering drive workItemsService, whose
 * createWorkItem mints real fractional positions.)
 */
export async function createTestWorkItem(
  fx: WorkItemFixture,
  input: CreateTestWorkItemInput,
): Promise<WorkItem> {
  return db.$transaction(async (tx) => {
    const key = await projectRepository.allocateWorkItemNumber(fx.projectId, tx);
    return workItemRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        parentId: input.parentId ?? null,
        kind: input.kind,
        key,
        identifier: `${fx.projectIdentifier}-${key}`,
        title: input.title,
        reporterId: fx.ownerId,
        position: String(key).padStart(6, '0'),
      },
      tx,
    );
  });
}

export interface CreateTestLinkInput {
  workspaceId: string;
  fromId: string;
  toId: string;
  kind: WorkItemLinkKind;
  createdById: string;
}

/**
 * One-shot link create — wraps the required-`tx` repository call in a
 * transaction the way the service layer does. Returns the inserted row (or
 * throws the typed trigger error the repository edge translates).
 */
export async function createTestLink(input: CreateTestLinkInput): Promise<WorkItemLink> {
  return db.$transaction((tx) =>
    workItemLinkRepository.create(
      {
        workspaceId: input.workspaceId,
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        createdById: input.createdById,
      },
      tx,
    ),
  );
}
