import type {
  Executor,
  Prisma,
  User,
  Workspace,
  WorkItem,
  WorkItemKind,
  WorkItemLink,
  WorkItemLinkKind,
  WorkItemType,
} from '@prisma/client';
import { db } from '@/lib/db';
import { keyForAppend } from '@/lib/workItems/positioning';
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
  /** Optional leaf work TYPE (Story 2.7) — seed it to exercise type-aware reads
   *  (e.g. the roadmap manual/human chip, MOTIR-1642). */
  type?: WorkItemType | null;
  /** Optional executor — pair with `type` to seed a human-gated leaf. */
  executor?: Executor | null;
}

/**
 * The `position` a seeded row must get: a VALID, project-globally-unique
 * fractional-index key (`lib/workItems/positioning.ts`), appended after the
 * highest key the project currently holds so the chain ascends in creation
 * order. This is the same thing `scripts/plan-seed/seed.ts:396-412` does, for
 * the same two reasons — read that comment; it is the one that learned this
 * first.
 *
 * ⚠️ **NEVER write a zero-padded number here** (`String(key).padStart(6, '0')`,
 * the shape this fixture used until MOTIR-2196). A padded number like
 * `"000001"` has head `'0'`, which `generateKeyBetween` REJECTS
 * (`invalid order key head: 0`) — so the next create through the real service
 * that appends after such a row throws a raw `Error`, `classifyApiV1Error`
 * does not recognise it, and the caller gets a bare 500 with no `code`. It is
 * scoped to SIBLINGS, so it stayed dormant for as long as every suite that
 * created through the API happened to create a CHILD of the seeded row; when
 * it fires, it fires in a suite whose subject is something else entirely.
 *
 * ⚠️ **And the chain is GLOBAL per project, not per parent** — deliberately
 * wider than the product's own append (which is sibling-scoped). A board
 * column orders cards by `position` ACROSS parents, so two rows must never
 * share a key: dropping a card between two equal-keyed neighbours calls
 * `keyBetween(k, k)`, which throws `prev >= next` → a different 500. A single
 * ascending chain keeps every key distinct (matching the ordering the old
 * padded key had) while staying valid, and siblings are still created
 * consecutively, so each parent's children sort correctly under the tree.
 */
export async function nextTestPosition(
  projectId: string,
  tx?: Prisma.TransactionClient,
): Promise<string> {
  const client = tx ?? db;
  const last = await client.workItem.findFirst({
    where: { projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return keyForAppend(last?.position ?? null);
}

/**
 * Create a work item the way the service does: allocate the per-project key
 * inside a transaction, mint a real fractional-index `position`, derive the
 * identifier, and insert the row — all through the repository (which surfaces
 * the DB triggers as typed errors).
 *
 * The position is minted by {@link nextTestPosition}; read its warning before
 * changing how this row's `position` is written.
 */
export async function createTestWorkItem(
  fx: WorkItemFixture,
  input: CreateTestWorkItemInput,
): Promise<WorkItem> {
  return db.$transaction(async (tx) => {
    const key = await projectRepository.allocateWorkItemNumber(fx.projectId, tx);
    const parentId = input.parentId ?? null;
    return workItemRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        parentId,
        kind: input.kind,
        type: input.type ?? null,
        executor: input.executor ?? null,
        key,
        identifier: `${fx.projectIdentifier}-${key}`,
        title: input.title,
        reporterId: fx.ownerId,
        position: await nextTestPosition(fx.projectId, tx),
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
