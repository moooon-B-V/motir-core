import { Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';
import { AlreadyMemberError, SlugCollisionError } from './errors';

// Workspaces repo. Direct-DB primitives for the application layers landing
// in 1.2.4 (auto-workspace-on-signup hook), 1.2.5 (invite endpoints), and
// 1.2.6 (switcher + settings UI). RLS policies + the workspace-context
// middleware land in 1.2.3 — until then, these helpers run without a
// session GUC and see all rows; tests rely on that to assert cascade /
// uniqueness behavior directly.

const SLUG_MAX_LENGTH = 60;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RETRY_ATTEMPTS = 3;

/**
 * Normalize a workspace name into a URL-safe slug. Lowercases, replaces any
 * run of non-[a-z0-9] characters with a single hyphen, trims leading and
 * trailing hyphens, and truncates to 60 chars (leaving room for the suffix
 * on collision). Pure function — no DB access.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  // Empty-string guard: a name like "!!!" would otherwise produce an empty
  // slug and immediately collide with any other empty-slugged workspace.
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

/**
 * Create a workspace and its owner-membership in a single transaction.
 * The slug is derived from `name`; if that base slug collides on the unique
 * index, we retry with a random 4-char suffix appended. After 3 collisions
 * (which would require astronomically bad luck after the first suffix
 * attempt) we throw SlugCollisionError so the caller can surface a typed
 * failure rather than a generic Prisma error.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const base = slugify(input.name);
  let lastAttempt = base;

  for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    lastAttempt = slug;
    try {
      return await db.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
          data: { name: input.name, slug },
        });
        const membership = await tx.workspaceMembership.create({
          data: {
            userId: input.ownerUserId,
            workspaceId: workspace.id,
            role: 'member',
          },
        });
        return { workspace, membership };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Could be the workspace.slug collision (retry) or the membership
        // unique on (userId, workspaceId) — the latter can't happen here
        // because workspace.id is freshly minted, so any P2002 on this
        // transaction is the slug. Retry.
        continue;
      }
      throw err;
    }
  }

  throw new SlugCollisionError(lastAttempt);
}

export interface AddMemberInput {
  userId: string;
  workspaceId: string;
  role?: string;
}

export async function addMember(input: AddMemberInput): Promise<WorkspaceMembership> {
  try {
    return await db.workspaceMembership.create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        role: input.role ?? 'member',
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AlreadyMemberError(input.userId, input.workspaceId);
    }
    throw err;
  }
}

export interface RemoveMemberInput {
  userId: string;
  workspaceId: string;
}

/**
 * Returns the deleted membership row, or null if no matching row existed.
 * Distinct from throwing — callers (the settings UI's Leave/Remove flows)
 * treat "already gone" as a no-op rather than an error.
 */
export async function removeMember(input: RemoveMemberInput): Promise<WorkspaceMembership | null> {
  try {
    return await db.workspaceMembership.delete({
      where: {
        userId_workspaceId: {
          userId: input.userId,
          workspaceId: input.workspaceId,
        },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return null;
    }
    throw err;
  }
}

/**
 * Workspaces the user belongs to, ordered by membership.createdAt asc (so
 * the auto-created default workspace from 1.2.4 lands first when 1.2.6's
 * switcher renders the list).
 */
export async function findUserWorkspaces(userId: string): Promise<Workspace[]> {
  const memberships = await db.workspaceMembership.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: { workspace: true },
  });
  return memberships.map((m) => m.workspace);
}

export async function findMembership(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembership | null> {
  return db.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
}
