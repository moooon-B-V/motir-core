import { Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
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

export interface CreateWorkspaceInput {
  name: string;
  ownerUserId: string;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  membership: WorkspaceMembership;
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
          const workspace = await workspaceRepository.create({ name: input.name, slug }, tx);
          const membership = await workspaceMembershipRepository.create(
            { userId: input.ownerUserId, workspaceId: workspace.id, role: 'member' },
            tx,
          );
          return { workspace, membership };
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
