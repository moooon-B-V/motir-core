import { Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { WORKSPACE_ROLE } from '@/lib/workspaces/roles';
import {
  AlreadyMemberError,
  LastMemberError,
  NotAMemberError,
  SlugCollisionError,
} from '@/lib/workspaces/errors';
import {
  toCurrentWorkspaceDTO,
  toWorkspaceMemberDTO,
  toWorkspaceSummaryDTO,
} from '@/lib/mappers/workspaceMappers';
import type {
  CurrentWorkspaceDTO,
  WorkspaceMemberDTO,
  WorkspaceSummaryDTO,
} from '@/lib/dto/workspaces';

// Workspaces service — business logic for the Workspace and
// WorkspaceMembership entities.
//
// `createWorkspace` is the canonical multi-row write: it inserts a
// Workspace AND an owner WorkspaceMembership atomically, and retries on
// slug collisions. `addMember` / `removeMember` exist so the invite
// flow (workspaceInvitesService) and the settings UI (1.2.6) have a
// single business-logic entry point instead of poking the membership
// repo directly.
//
// `ensureDefaultWorkspace` (Subtask 1.2.4) is the self-heal backstop for
// the auto-create-on-signup flow: the Better-Auth signup hook is
// best-effort (it runs AFTER the user-insert transaction commits — see
// lib/auth/index.ts), so a signed-in user can transiently have zero
// workspaces. The workspace-context resolver calls this on a zero-
// membership read; it is idempotent and concurrency-safe.
//
// The 1.2.6 settings surface adds `renameWorkspace`, `deleteWorkspace`,
// `listMembers`, and `getWorkspaceSummary`, plus a last-member guard on
// `removeMember`. Those workspace-scoped operations run inside
// withWorkspaceContext so the workspace / workspace_membership RLS
// policies see the per-transaction GUCs (app.user_id / app.workspace_id).

const SLUG_MAX_LENGTH = 60;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RETRY_ATTEMPTS = 3;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  return slug || 'workspace';
}

function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i++) {
    out += SLUG_SUFFIX_ALPHABET[Math.floor(Math.random() * SLUG_SUFFIX_ALPHABET.length)];
  }
  return out;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Insert a Workspace + its owner WorkspaceMembership through the given
// transaction client. The slug-collision retry loop lives in the callers
// (each retry needs a FRESH transaction — a P2002 poisons the current one,
// so we can't just catch-and-continue inside a single `tx`).
async function insertWorkspaceWithOwner(
  input: { name: string; slug: string; ownerUserId: string },
  tx: Prisma.TransactionClient,
): Promise<{ workspace: Workspace; membership: WorkspaceMembership }> {
  const workspace = await workspaceRepository.create({ name: input.name, slug: input.slug }, tx);
  // The workspace creator is its OWNER — the privileged tier the 1.6.5 operator
  // dashboard's replay gate keys off. Invited members default to `member`
  // (workspacesService.addMember). This is what the function name has always
  // promised; Story 1.2 wrote `member` here as a single-role shortcut, corrected
  // now — see lib/workspaces/roles.ts (PRODECT_FINDINGS #36).
  const membership = await workspaceMembershipRepository.create(
    { userId: input.ownerUserId, workspaceId: workspace.id, role: WORKSPACE_ROLE.owner },
    tx,
  );
  return { workspace, membership };
}

export interface CreateWorkspaceInput {
  name: string;
  ownerUserId: string;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  membership: WorkspaceMembership;
}

export interface EnsureDefaultWorkspaceInput {
  userId: string;
  userName: string;
}

export const workspacesService = {
  /**
   * Create a workspace and its owner-membership in a single transaction.
   * The slug is derived from `name`; if that base slug collides on the
   * unique index, we retry with a random 4-char suffix appended. After
   * 3 collisions (which would require astronomically bad luck after the
   * first suffix attempt) we throw SlugCollisionError so the caller
   * surfaces a typed failure rather than a generic Prisma error.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const base = slugify(input.name);
    let lastAttempt = base;

    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      lastAttempt = slug;
      try {
        return await db.$transaction(async (tx) => {
          return insertWorkspaceWithOwner(
            { name: input.name, slug, ownerUserId: input.ownerUserId },
            tx,
          );
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Can only be the workspace.slug collision (workspace.id was
          // freshly minted, so the membership unique can't fire here).
          continue;
        }
        throw err;
      }
    }
    throw new SlugCollisionError(lastAttempt);
  },

  /**
   * Idempotent self-heal: guarantee the user has at least one workspace,
   * returning their active (first) one. Backstops the best-effort signup
   * hook, which is NOT atomic with the user insert (it runs as a queued
   * after-transaction hook in better-auth 1.6.11 — see lib/auth/index.ts),
   * so a committed user can transiently have zero workspaces.
   *
   * Concurrency: two parallel first-requests (e.g. two browser tabs right
   * after signup) must not each create a default workspace. We serialize
   * on a `SELECT ... FOR UPDATE` lock of the user row inside the same
   * transaction as the membership count + create: the second caller blocks
   * on the lock, then re-reads a non-zero count and returns the first
   * caller's workspace instead of inserting a duplicate.
   *
   * Each slug-collision retry opens a fresh transaction because a P2002
   * poisons the current one. The lock is re-acquired on every attempt; the
   * count re-check inside the lock keeps it idempotent across retries too.
   */
  async ensureDefaultWorkspace(input: EnsureDefaultWorkspaceInput): Promise<CreateWorkspaceResult> {
    const name = `${input.userName}'s Workspace`;
    const base = slugify(name);
    let lastAttempt = base;

    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      lastAttempt = slug;
      try {
        const result = await db.$transaction(async (tx) => {
          await userRepository.lockById(input.userId, tx);

          const existingCount = await workspaceMembershipRepository.countByUser(input.userId, tx);
          if (existingCount > 0) {
            const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(
              input.userId,
              tx,
            );
            // existingCount > 0 guarantees a row; the non-null assertion is
            // safe inside the same FOR-UPDATE-locked transaction.
            const { workspace, ...membership } = first!;
            return { workspace, membership };
          }

          return insertWorkspaceWithOwner({ name, slug, ownerUserId: input.userId }, tx);
        });
        return result;
      } catch (err) {
        if (isUniqueViolation(err)) {
          continue;
        }
        throw err;
      }
    }
    throw new SlugCollisionError(lastAttempt);
  },

  /**
   * Resolve the user's active workspace (cookie-pinned if they belong to
   * it, else their first membership) and return it as the
   * GET /api/workspaces/current DTO. Returns null when the user has no
   * memberships — the route turns that into a 404. Read-only, so the reads
   * run in one $transaction purely for snapshot consistency between the
   * membership lookup and its workspace.
   */
  async getActiveWorkspace(
    userId: string,
    preferredWorkspaceId: string | null,
  ): Promise<CurrentWorkspaceDTO | null> {
    return db.$transaction(async (tx) => {
      if (preferredWorkspaceId) {
        const pinned = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
          userId,
          preferredWorkspaceId,
          tx,
        );
        if (pinned) {
          const { workspace, ...membership } = pinned;
          return toCurrentWorkspaceDTO(workspace, membership);
        }
      }

      const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx);
      if (!first) return null;
      const { workspace, ...membership } = first;
      return toCurrentWorkspaceDTO(workspace, membership);
    });
  },

  /**
   * Resolve which workspace a request acts within, returning just its id.
   * This is the business logic behind the workspace-context resolver
   * (lib/workspaces/middleware.ts); the resolver now only parses the
   * session + cookie and delegates here.
   *
   * Resolution order:
   *   1. cookie-pinned workspace, IF the user has a membership in it;
   *   2. otherwise the user's first membership (createdAt asc — the
   *      auto-created default from Subtask 1.2.4 lands first);
   *   3. zero memberships → self-heal via ensureDefaultWorkspace and
   *      return the workspace it guarantees.
   *
   * The membership reads run inside withUserContext so the `app.user_id`
   * GUC is bound first and the RLS membership policies bite even on a
   * non-superuser connection. The self-heal runs OUTSIDE that transaction
   * because ensureDefaultWorkspace owns its own transaction (with a
   * FOR UPDATE lock on the user row); nesting it would deadlock on the
   * same connection.
   *
   * `userName` seeds the default workspace name on the self-heal path;
   * when the caller has no session object on hand it is read off the user
   * row before backfilling.
   */
  async resolveActiveWorkspace(
    userId: string,
    cookieWorkspaceId: string | null,
    userName?: string,
  ): Promise<string | null> {
    const existing = await withUserContext(userId, async (tx) => {
      if (cookieWorkspaceId) {
        const pinned = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
          userId,
          cookieWorkspaceId,
          tx,
        );
        if (pinned) return pinned.workspaceId;
      }
      const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx);
      return first?.workspaceId ?? null;
    });

    if (existing) return existing;

    const name = userName ?? (await userRepository.findById(userId))?.name ?? 'My';
    const { workspace } = await this.ensureDefaultWorkspace({ userId, userName: name });
    return workspace.id;
  },

  async findMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    return workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
  },

  async listUserWorkspaces(userId: string): Promise<Workspace[]> {
    return workspaceMembershipRepository.findWorkspacesByUser(userId);
  },

  /**
   * Add a member to a workspace. Throws AlreadyMemberError when the
   * unique (userId, workspaceId) constraint fires. Wraps the single
   * write in a transaction so the error-translation point stays
   * consistent with the rest of the service surface.
   */
  async addMember(input: {
    userId: string;
    workspaceId: string;
    role?: string;
  }): Promise<WorkspaceMembership> {
    try {
      return await db.$transaction(async (tx) => {
        return workspaceMembershipRepository.create(
          {
            userId: input.userId,
            workspaceId: input.workspaceId,
            role: input.role ?? 'member',
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AlreadyMemberError(input.userId, input.workspaceId);
      }
      throw err;
    }
  },

  /**
   * Remove a member. Returns the deleted row or null if the user
   * wasn't a member to begin with (idempotent Leave / Remove).
   *
   * Enforces the last-member guard: if the target is the only remaining
   * membership, throws LastMemberError instead of deleting — a workspace
   * with zero members is unreachable and undeletable through the UI, so
   * the last member must use Delete, not Leave. The count and the delete
   * run in one transaction (countByWorkspace + delete both take `tx`) so
   * two concurrent leaves can't both observe count > 1 and orphan the
   * workspace.
   *
   * Runs inside withWorkspaceContext so the count read and the delete
   * both see the workspace_membership RLS GUCs. The actor must be a
   * member of `workspaceId` — callers build the WorkspaceContext from a
   * resolved membership, but we keep the workspace-scoped GUC honest by
   * counting only rows the policy exposes.
   */
  async removeMember(input: {
    userId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembership | null> {
    return withWorkspaceContext({ userId: input.userId, workspaceId: input.workspaceId }, (tx) =>
      workspacesService.removeMemberInTx(input, tx),
    );
  },

  async removeMemberInTx(
    input: { userId: string; workspaceId: string },
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership | null> {
    const existing = await workspaceMembershipRepository.findByUserAndWorkspace(
      input.userId,
      input.workspaceId,
    );
    // Not a member → idempotent no-op (matches the prior contract).
    if (!existing) return null;

    const memberCount = await workspaceMembershipRepository.countByWorkspace(input.workspaceId, tx);
    if (memberCount <= 1) {
      throw new LastMemberError(input.workspaceId);
    }

    return workspaceMembershipRepository.deleteByUserAndWorkspace(
      input.userId,
      input.workspaceId,
      tx,
    );
  },

  /**
   * Rename a workspace. Any member can rename (single-role v1). Asserts
   * membership, then updates the name inside a workspace-scoped
   * transaction so the workspace RLS policy permits the write. The slug
   * is intentionally NOT regenerated — slugs are stable identifiers; a
   * later Subtask can add slug editing if a URL-facing surface needs it.
   */
  async renameWorkspace(input: {
    workspaceId: string;
    actorUserId: string;
    name: string;
  }): Promise<WorkspaceSummaryDTO> {
    await workspacesService.assertMembership(input.actorUserId, input.workspaceId);
    const trimmed = input.name.trim();
    const workspace = await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      (tx) => workspaceRepository.update(input.workspaceId, { name: trimmed }, tx),
    );
    return toWorkspaceSummaryDTO(workspace);
  },

  /**
   * Delete a workspace and (via onDelete: Cascade) every child row —
   * memberships now, workspace-scoped data from later Stories later.
   * Asserts membership first, then deletes inside a workspace-scoped
   * transaction so the workspace RLS policy permits the delete.
   */
  async deleteWorkspace(input: { workspaceId: string; actorUserId: string }): Promise<void> {
    await workspacesService.assertMembership(input.actorUserId, input.workspaceId);
    await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      (tx) => workspaceRepository.delete(input.workspaceId, tx),
    );
  },

  /**
   * Fetch a single workspace as a summary DTO, or null if the actor is
   * not a member (or the workspace doesn't exist). Asserts membership
   * first so a non-member can't read a workspace by id — this is the
   * application-layer tenant gate; RLS is the structural backstop. Used
   * by the settings page header / cards.
   */
  async getWorkspaceSummary(
    workspaceId: string,
    actorUserId: string,
  ): Promise<WorkspaceSummaryDTO | null> {
    const membership = await workspaceMembershipRepository.findByUserAndWorkspace(
      actorUserId,
      workspaceId,
    );
    if (!membership) return null;
    const workspace = await workspaceRepository.findById(workspaceId);
    return workspace ? toWorkspaceSummaryDTO(workspace) : null;
  },

  /**
   * List the members of a workspace as DTOs for the settings Members
   * card. Reads inside withWorkspaceContext so the workspace_membership
   * RLS policy exposes the rows (it keys off the per-transaction GUCs).
   */
  async listMembers(workspaceId: string, actorUserId: string): Promise<WorkspaceMemberDTO[]> {
    const rows = await withWorkspaceContext({ userId: actorUserId, workspaceId }, (tx) =>
      workspaceMembershipRepository.findMembersByWorkspace(workspaceId, tx),
    );
    return rows.map(toWorkspaceMemberDTO);
  },

  /**
   * Asserts the user is a member of the workspace, throwing
   * NotAMemberError otherwise. Convenience for route handlers that
   * want to gate on membership without writing a null-check by hand.
   */
  async assertMembership(userId: string, workspaceId: string): Promise<void> {
    const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
    if (!m) throw new NotAMemberError(userId, workspaceId);
  },

  /**
   * The user's role in the workspace (`owner` | `member`), or null if they
   * aren't a member. Read-only — used by surfaces that gate an action on the
   * privileged tier (e.g. the 1.6.5 dashboard's owner-only Replay button).
   * Returns the raw stored string so callers compare via lib/workspaces/roles.
   */
  async getMemberRole(userId: string, workspaceId: string): Promise<string | null> {
    // Read inside withWorkspaceContext so the membership_visible RLS policy
    // admits the row under the non-bypass prodect_app role (a db-singleton read
    // with no GUC bound returns NULL → would mis-gate every owner as a member
    // in production). Mirrors listMembers.
    const m = await withWorkspaceContext({ userId, workspaceId }, (tx) =>
      workspaceMembershipRepository.findByUserAndWorkspaceInTx(userId, workspaceId, tx),
    );
    return m?.role ?? null;
  },
};
