import { Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { toCurrentWorkspaceDTO } from '@/lib/mappers/workspaceMappers';
import type { CurrentWorkspaceDTO } from '@/lib/dto/workspaces';
import { AlreadyMemberError, NotAMemberError, SlugCollisionError } from '@/lib/workspaces/errors';

// Workspaces service — business logic for the Workspace and
// WorkspaceMembership entities.
//
// `createWorkspace` is the canonical multi-row write: it inserts a
// Workspace AND an owner WorkspaceMembership atomically, and retries on
// slug collisions. `addMember` / `removeMember` exist so the invite
// flow (workspaceInvitesService) and the future settings UI (1.2.6)
// have a single business-logic entry point instead of poking the
// membership repo directly.
//
// `ensureDefaultWorkspace` (Subtask 1.2.4) is the self-heal backstop for
// the auto-create-on-signup flow: the Better-Auth signup hook is
// best-effort (it runs AFTER the user-insert transaction commits — see
// lib/auth/index.ts), so a signed-in user can transiently have zero
// workspaces. The workspace-context resolver calls this on a zero-
// membership read; it is idempotent and concurrency-safe.

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
  const membership = await workspaceMembershipRepository.create(
    { userId: input.ownerUserId, workspaceId: workspace.id, role: 'member' },
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
   */
  async removeMember(input: {
    userId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembership | null> {
    return db.$transaction(async (tx) => {
      return workspaceMembershipRepository.deleteByUserAndWorkspace(
        input.userId,
        input.workspaceId,
        tx,
      );
    });
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
};
