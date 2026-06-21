import { type MemberRole, Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { WORKSPACE_ROLE } from '@/lib/workspaces/roles';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { organizationsService } from '@/lib/services/organizationsService';
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
  input: { name: string; slug: string; ownerUserId: string; organizationId?: string },
  tx: Prisma.TransactionClient,
): Promise<{ workspace: Workspace; membership: WorkspaceMembership }> {
  // Story 6.10: every workspace lives under an Organization (the root tenancy
  // tier — Workspace.organizationId is non-nullable). Two creation shapes:
  //
  //   * 2nd+ workspace under an ACTIVE org (organizationId provided, 6.10.4) —
  //     the workspace nests under the existing org and the creator gets an
  //     org membership via the UPWARD invariant (you cannot be in a workspace
  //     without being in its org — 6.10.2 §5i) if they aren't one already.
  //   * a brand-new account / first workspace (no organizationId) — mints its
  //     OWN default org with the creator as org owner (an org of one / OPC),
  //     the same one-org-per-workspace shape the 6.10.3 migration backfill gives
  //     every pre-existing workspace. The org reuses the workspace's name +
  //     globally-unique slug; the caller's slug-retry loop covers an org.slug
  //     collision exactly as it covers a workspace.slug one.
  //
  // (The copy-on-create config CLONE — making a 2nd workspace open already
  // configured like the source — is its own subtask, 6.10.9, layered on top of
  // this org-aware path; not done here.)
  let organizationId = input.organizationId;
  if (organizationId) {
    await organizationsService.ensureOrgMembership(input.ownerUserId, organizationId, tx);
  } else {
    const organization = await organizationRepository.create(
      { name: input.name, slug: input.slug },
      tx,
    );
    await organizationMembershipRepository.create(
      {
        organizationId: organization.id,
        userId: input.ownerUserId,
        role: ORGANIZATION_ROLE.owner,
      },
      tx,
    );
    organizationId = organization.id;
  }
  const workspace = await workspaceRepository.create(
    { name: input.name, slug: input.slug, organizationId },
    tx,
  );
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
  /**
   * Story 6.10: when set, the workspace nests under this EXISTING organization
   * (the "create a 2nd+ workspace under the active org" path) and the creator
   * gets an org membership via the upward invariant. When omitted, a fresh
   * default org is minted with the creator as org owner (the signup / first-
   * workspace OPC path).
   */
  organizationId?: string;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  membership: WorkspaceMembership;
}

export interface EnsureDefaultWorkspaceInput {
  userId: string;
  userName: string;
}

/**
 * The resolved GLOBAL last-active context (Subtask 8.8.27) — the project the
 * user last worked in plus the workspace + org it lives under (project →
 * workspace → org). `resolveLastActiveContext` returns this when the pointer is
 * set AND the project still exists AND the user still passes the workspace
 * access gate; otherwise `null` (so the caller falls through to the
 * first-by-createdAt default).
 */
export interface LastActiveContext {
  projectId: string;
  workspaceId: string;
  organizationId: string;
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
            {
              name: input.name,
              slug,
              ownerUserId: input.ownerUserId,
              organizationId: input.organizationId,
            },
            tx,
          );
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A slug collision — on either organization.slug or workspace.slug
          // (Story 6.10 reuses the same slug for the auto-created org). The ids
          // were freshly minted, so the membership uniques can't fire here.
          // Retry with a new suffixed slug.
          continue;
        }
        throw err;
      }
    }
    throw new SlugCollisionError(lastAttempt);
  },

  /**
   * Provision a brand-new account's tenancy (Story 6.10.4, the
   * progressive-disclosure / auto-provision principle): an organization (an org
   * of one — OPC) + a default workspace + the owner memberships for both, all in
   * ONE transaction. This is the named entry the signup/onboarding hook calls so
   * every account is an org of one from day one and there is never a tier-less
   * user; it delegates to `createWorkspace` (no `organizationId` → the
   * mint-own-org branch), which already does the atomic org+workspace+memberships
   * insert with the slug-collision retry. The org name defaults from the user and
   * is renameable later (organizationsService.renameOrganization).
   */
  async provisionForNewUser(input: EnsureDefaultWorkspaceInput): Promise<CreateWorkspaceResult> {
    return workspacesService.createWorkspace({
      name: `${input.userName}'s Workspace`,
      ownerUserId: input.userId,
    });
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
   *   1. cookie-pinned workspace, IF the user has a membership in it AND it
   *      passes the org access gate;
   *   2. otherwise the user's first membership (createdAt asc — the
   *      auto-created default from Subtask 1.2.4 lands first) that passes the
   *      org access gate;
   *   3. zero ACCESSIBLE memberships → self-heal via ensureDefaultWorkspace and
   *      return the workspace it guarantees.
   *
   * Story 6.10.4: a candidate must clear the ORG gate
   * (organizationsService.resolveWorkspaceAccess) — org membership gates
   * workspace access, so a stale workspace membership whose org membership was
   * revoked no longer resolves as the active workspace. The gate is passed the
   * withUserContext `tx`; the candidate is always a workspace the user is a
   * member of, so its rows are RLS-visible under the bound user GUC.
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
        if (
          pinned &&
          (await organizationsService.resolveWorkspaceAccess(userId, pinned.workspaceId, tx))
        ) {
          return pinned.workspaceId;
        }
      }
      // No valid cookie pin. Before the first-by-createdAt default, try the
      // user's GLOBAL last-active project (Subtask 8.8.27): land them back in
      // the workspace of the project they last worked in (cross-device,
      // account-keyed — the Linear "last visited context" standard). The
      // resolver re-checks the access gate, so a since-revoked membership or an
      // archived/deleted project falls through cleanly to the default below.
      const lastActive = await this.resolveLastActiveContext(userId, tx);
      if (lastActive) return lastActive.workspaceId;

      const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx);
      if (
        first &&
        (await organizationsService.resolveWorkspaceAccess(userId, first.workspaceId, tx))
      ) {
        return first.workspaceId;
      }
      return null;
    });

    if (existing) return existing;

    const name = userName ?? (await userRepository.findById(userId))?.name ?? 'My';
    const { workspace } = await this.ensureDefaultWorkspace({ userId, userName: name });
    return workspace.id;
  },

  /**
   * Record the user's GLOBAL last-active project (Subtask 8.8.27) — the landing
   * target a fresh session/device resolves to. A single-row last-writer-wins
   * overwrite of `User.lastActiveProjectId`: no read-then-write and no external
   * side effects, so it needs no `FOR UPDATE` (concurrent switches simply settle
   * on whichever commits last — the intended "most recent"). Wrapped in a plain
   * transaction per the one-method-one-transaction rule (no tenant GUC needed —
   * the write is keyed by the user's own id, mirroring `usersService.updateProfile`).
   *
   * The write call sites (the project / workspace / org switch points) are wired
   * in Subtask 8.8.28; this slice ships the method + its unit coverage.
   */
  async recordLastActiveProject(userId: string, projectId: string): Promise<void> {
    await db.$transaction((tx) => userRepository.setLastActiveProject(userId, projectId, tx));
  },

  /**
   * Resolve the user's GLOBAL last-active context (Subtask 8.8.27): the project
   * pointer plus the workspace + org it derives (project → workspace → org).
   * Returns `null` — so the caller falls through to its default — when the
   * pointer is unset, the project no longer exists, or the user no longer passes
   * the workspace access gate (a revoked membership, a cross-org move). A pure
   * read: no writes, no side effects.
   *
   * Takes `tx` because the canonical caller (`resolveActiveWorkspace`) already
   * runs under `withUserContext`, and the access-gate re-check
   * (`organizationsService.resolveWorkspaceAccess`) reuses that bound
   * transaction so the membership rows are RLS-visible in the same snapshot.
   */
  async resolveLastActiveContext(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LastActiveContext | null> {
    const user = await userRepository.findById(userId, tx);
    if (!user?.lastActiveProjectId) return null;

    const project = await projectRepository.findById(user.lastActiveProjectId, tx);
    if (!project) return null;

    const access = await organizationsService.resolveWorkspaceAccess(
      userId,
      project.workspaceId,
      tx,
    );
    if (!access) return null;

    return {
      projectId: project.id,
      workspaceId: project.workspaceId,
      organizationId: access.organizationId,
    };
  },

  async findMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    return workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
  },

  async listUserWorkspaces(userId: string): Promise<Workspace[]> {
    return workspaceMembershipRepository.findWorkspacesByUser(userId);
  },

  /**
   * Add a member to a workspace. Throws AlreadyMemberError when the
   * unique (userId, workspaceId) constraint fires. Wraps the writes in one
   * transaction so the error-translation point stays consistent and the
   * upward auto-join is atomic with the workspace-membership insert.
   *
   * Story 6.10.4 — the UPWARD membership invariant (6.10.2 §5i): you cannot be
   * in a workspace without being in its org, so adding a user to a workspace
   * also ensures their OrganizationMembership (role `member`) in that
   * workspace's org, in the SAME transaction. This is what keeps the org access
   * gate satisfied for every workspace member (an invite-accept that adds a
   * cross-org user to a workspace auto-enrols them in the org).
   */
  async addMember(input: {
    userId: string;
    workspaceId: string;
    role?: MemberRole;
  }): Promise<WorkspaceMembership> {
    try {
      return await db.$transaction(async (tx) => {
        const membership = await workspaceMembershipRepository.create(
          {
            userId: input.userId,
            workspaceId: input.workspaceId,
            role: input.role ?? 'member',
          },
          tx,
        );
        // Upward auto-join: the create succeeded, so the workspace exists; bring
        // the user into its org if they aren't a member already.
        const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
        if (workspace) {
          await organizationsService.ensureOrgMembership(
            input.userId,
            workspace.organizationId,
            tx,
          );
        }
        return membership;
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
   * the last member must use Delete, not Leave. The guard LOCKS the
   * workspace's membership rows `FOR UPDATE` before counting
   * (countByWorkspaceForUpdate), all in one transaction, so two concurrent
   * leaves of a 2-member workspace serialize — the second blocks, re-counts
   * after the first commits, and is refused — and the workspace can never be
   * orphaned (the lock-before-read-derived-update rule; mirrors the org
   * last-owner guard).
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

    // Lock the workspace's membership rows before counting so two concurrent
    // leaves serialize (lock-before-read-derived-update) — a plain COUNT would
    // let both observe count > 1 and both delete, orphaning the workspace.
    const memberCount = await workspaceMembershipRepository.countByWorkspaceForUpdate(
      input.workspaceId,
      tx,
    );
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
   * Asserts the user can ACCESS the workspace, throwing NotAMemberError
   * otherwise. Convenience for route handlers that want to gate without writing
   * a null-check by hand.
   *
   * Story 6.10.4: this now goes through the ORG access gate
   * (organizationsService.resolveWorkspaceAccess), so "access" means org
   * membership gates workspace access AND an org owner/admin reaches every
   * workspace under the org (composed above the 6.4 workspace role). A user with
   * a stale workspace membership but no org membership is DENIED. The gate
   * self-binds withWorkspaceContext so the rows are RLS-visible.
   */
  async assertMembership(userId: string, workspaceId: string): Promise<void> {
    const access = await organizationsService.resolveWorkspaceAccess(userId, workspaceId);
    if (!access) throw new NotAMemberError(userId, workspaceId);
  },

  /**
   * The user's EFFECTIVE workspace role (`owner` | `member`), or null if they
   * have no access. Read-only — used by surfaces that gate an action on the
   * privileged tier (e.g. the 1.6.5 dashboard's owner-only Replay button).
   *
   * Story 6.10.4: the role composes the org tier above the 6.4 workspace role —
   * an org owner/admin reports `owner` on every workspace under the org even
   * with no workspace membership; a plain org member reports their stored
   * workspace role; a non-org-member (no access) reports null. Callers compare
   * via lib/workspaces/roles.
   */
  async getMemberRole(userId: string, workspaceId: string): Promise<string | null> {
    const access = await organizationsService.resolveWorkspaceAccess(userId, workspaceId);
    return access?.effectiveRole ?? null;
  },
};
