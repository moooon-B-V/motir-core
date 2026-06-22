import { type OrganizationRole, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import {
  AlreadyOrgMemberError,
  LastOrgOwnerError,
  OrganizationNotFoundError,
  OrgForbiddenError,
  OrgInviteeNotFoundError,
  OrgSlugCollisionError,
} from '@/lib/organizations/errors';
import {
  toCurrentOrganizationDTO,
  toOrganizationDTO,
  toOrgMemberDTO,
} from '@/lib/mappers/organizationMappers';
import type {
  CurrentOrganizationDTO,
  OrganizationDTO,
  OrgFootprintDTO,
  OrgMemberDTO,
  OrgMemberPageDTO,
} from '@/lib/dto/organizations';

// Organizations service — the business logic + access gating that makes the
// org tier real (Story 6.10, Subtask 6.10.4). The org is the ROOT tenancy tier
// (Organization → N Workspace → Project) and the billing entity; this service
// owns:
//
//   * the ACCESS GATE (resolveWorkspaceAccess) — org membership gates workspace
//     access, and an org owner/admin's role composes ABOVE the 6.4 workspace
//     MemberRole (admin-equivalent on every workspace under the org). A
//     non-org-member is denied with 404-not-403 (the cross-tenant no-leak rule).
//     This is the single shared helper the workspace-scoped guards
//     (workspacesService.assertMembership / getMemberRole / resolveActiveWorkspace)
//     and the 6.10.5 org-admin routes call — the 6.4 check is EXTENDED here, not
//     duplicated.
//   * org CRUD (create / rename) + membership management (add / remove /
//     change-role) with the asymmetric membership-direction invariant from
//     6.10.2 §5, and a last-owner guard;
//   * the cross-workspace member roster (keyset-paginated — the at-scale rule);
//   * the upward auto-join primitive (ensureOrgMembership) the workspace-add
//     flow calls so you can never be in a workspace without being in its org;
//   * resolving the active org + listing a user's orgs (for the shell switcher).
//
// 4-layer (CLAUDE.md): every write-flow is ONE prisma transaction (via the
// withOrgContext / db.$transaction wrappers); repositories are single-op; this
// service maps to DTOs before returning and throws typed errors the route layer
// (6.10.5) maps to HTTP.

const SLUG_MAX_LENGTH = 60;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RETRY_ATTEMPTS = 3;

// Default page size for the cross-workspace member roster. The caller (a route
// in 6.10.5) may pass its own `limit`; this is the fallback + a sane cap so a
// client can't request an unbounded page (defeating the at-scale rule).
const ROSTER_DEFAULT_LIMIT = 25;
const ROSTER_MAX_LIMIT = 100;

// The org-footprint summary caps the project-NAME sample (the at-scale rule,
// finding #57): the COUNTS stay exact, but only the first N names cross the
// boundary so a huge org can't return an unbounded list. A classification signal
// needs a representative handful, not every name.
const FOOTPRINT_PROJECT_NAME_CAP = 50;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  return slug || 'organization';
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

function isOrgAdminRole(role: OrganizationRole | null | undefined): boolean {
  return role === ORGANIZATION_ROLE.owner || role === ORGANIZATION_ROLE.admin;
}

/**
 * The result of the workspace access gate. `granted` is implied by a non-null
 * return (null = no access → the caller raises 404). `effectiveRole` is the
 * workspace-scoped role the actor effectively has AFTER composing the org role:
 * an org owner/admin is `owner` on EVERY workspace under the org; a plain org
 * member falls back to their stored workspace `MemberRole`.
 */
export interface WorkspaceAccess {
  organizationId: string;
  orgRole: OrganizationRole;
  /** The actor's stored workspace MemberRole, or null when they have none (an org admin spanning the workspace by role). */
  workspaceRole: string | null;
  /** The composed workspace-scoped role (org owner/admin ⇒ 'owner'). */
  effectiveRole: string;
  /** True when the org role is owner or admin (admin-equivalent across the org). */
  isOrgAdmin: boolean;
}

export const organizationsService = {
  // ── The access gate (the load-bearing helper) ──────────────────────────

  /**
   * Resolve `(userId)`'s access to `workspaceId`, composing the org tier over
   * the 6.4 workspace role. Returns null when access is DENIED — the caller
   * raises 404-not-403 so a cross-tenant workspace is indistinguishable from a
   * non-existent one (the no-leak rule). Access is granted when:
   *   - the workspace exists, AND
   *   - the actor is a member of the workspace's ORG (org membership gates
   *     workspace access — a stale workspace membership without org membership
   *     is DENIED), AND
   *   - either the actor is an org owner/admin (admin-equivalent on every
   *     workspace under the org, even with no workspace membership), OR the
   *     actor is a plain org member WITH a workspace membership in this
   *     workspace (an org member reaches only the workspaces they're explicitly
   *     added to — 6.10.2 §5).
   *
   * `tx` is optional: pass it when already inside a bound context (e.g.
   * workspacesService.resolveActiveWorkspace runs under withUserContext and the
   * candidate workspace is one the actor is a member of, so its rows are
   * RLS-visible). When omitted, the gate self-binds withWorkspaceContext so the
   * workspace + membership rows are visible under the non-bypass app role.
   */
  async resolveWorkspaceAccess(
    userId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkspaceAccess | null> {
    const run = async (t: Prisma.TransactionClient): Promise<WorkspaceAccess | null> => {
      const workspace = await workspaceRepository.findByIdInTx(workspaceId, t);
      if (!workspace) return null;

      const orgMembership = await organizationMembershipRepository.findByOrgAndUserInTx(
        workspace.organizationId,
        userId,
        t,
      );
      // Org membership gates workspace access — no org membership ⇒ denied,
      // even if a (stale) workspace membership row exists.
      if (!orgMembership) return null;

      const workspaceMembership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        userId,
        workspaceId,
        t,
      );
      const isOrgAdmin = isOrgAdminRole(orgMembership.role);

      // A plain org member reaches only workspaces they're explicitly added to.
      if (!isOrgAdmin && !workspaceMembership) return null;

      return {
        organizationId: workspace.organizationId,
        orgRole: orgMembership.role,
        workspaceRole: workspaceMembership?.role ?? null,
        // Org owner/admin composes to workspace-owner-equivalent; otherwise the
        // stored workspace role (guaranteed present in the non-admin branch).
        effectiveRole: isOrgAdmin ? ORGANIZATION_ROLE.owner : workspaceMembership!.role,
        isOrgAdmin,
      };
    };

    if (tx) return run(tx);
    return withWorkspaceContext({ userId, workspaceId }, run);
  },

  /**
   * Resolve `(userId)`'s access to an ORGANIZATION (not a workspace) — the gate
   * the org-admin-area reads (e.g. the 7.2.11 cost dashboard) reuse instead of
   * inventing a parallel check. Throws OrganizationNotFoundError (→ 404, the
   * no-leak rule) when the actor is not a member; otherwise returns their org
   * role + whether it is admin-equivalent (owner/admin). Read-only, under the
   * bound org context so the membership RLS policy admits the self-read.
   */
  async resolveOrgAccess(
    userId: string,
    organizationId: string,
  ): Promise<{ role: OrganizationRole; isOrgAdmin: boolean }> {
    return withOrgContext({ userId, organizationId }, async (tx) => {
      const role = await assertOrgMember(userId, organizationId, tx);
      return { role, isOrgAdmin: isOrgAdminRole(role) };
    });
  },

  // ── Org CRUD ────────────────────────────────────────────────────────────

  /**
   * Create a new organization with `actorUserId` as its owner, in a single
   * transaction. Slug is derived from `name` with the same suffix-retry loop as
   * workspace creation (a fresh transaction per attempt — a P2002 poisons the
   * current one). Used for the multi-org case (a user creating a second org);
   * the signup-time first org is minted by workspacesService.provisionForNewUser.
   */
  async createOrganization(input: { name: string; actorUserId: string }): Promise<OrganizationDTO> {
    const base = slugify(input.name);
    let lastAttempt = base;
    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      lastAttempt = slug;
      try {
        const org = await db.$transaction(async (tx) => {
          // §4.5 org-creation gate (8.1.11): the first org is always free; a
          // 2nd+ requires the actor to own/admin a paid (active scaled-tracker)
          // org. Inert off-cloud. Throws EntitlementExceededError otherwise.
          await entitlementsService.assertCanCreateOrganization(input.actorUserId, tx);
          const organization = await organizationRepository.create({ name: input.name, slug }, tx);
          await organizationMembershipRepository.create(
            {
              organizationId: organization.id,
              userId: input.actorUserId,
              role: ORGANIZATION_ROLE.owner,
            },
            tx,
          );
          return organization;
        });
        return toOrganizationDTO(org);
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    throw new OrgSlugCollisionError(lastAttempt);
  },

  /**
   * Rename an organization. Requires the actor to be an org owner/admin. Runs
   * inside withOrgContext so the organization RLS mutate policy (which gates
   * UPDATE on the active-org GUC) permits the write.
   */
  async renameOrganization(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
  }): Promise<OrganizationDTO> {
    const trimmed = input.name.trim();
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgAdmin(input.actorUserId, input.organizationId, tx);
        return organizationRepository.update(input.organizationId, { name: trimmed }, tx);
      },
    );
    return toOrganizationDTO(org);
  },

  // ── Membership management (asymmetric direction, 6.10.2 §5) ───────────────

  /**
   * Add a user to the ORG with an org role — and NOTHING else. Adding to the
   * org creates NO workspace membership (an org-only member in zero workspaces
   * is a valid state — e.g. a billing admin — and a plain org member reaches
   * only workspaces they're explicitly added to). The actor must be an org
   * owner/admin. Idempotency: a duplicate (organizationId, userId) raises
   * AlreadyOrgMemberError.
   */
  async addMember(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    actorUserId: string;
  }): Promise<void> {
    try {
      await withOrgContext(
        { userId: input.actorUserId, organizationId: input.organizationId },
        async (tx) => {
          await assertOrgAdmin(input.actorUserId, input.organizationId, tx);
          await organizationMembershipRepository.create(
            { organizationId: input.organizationId, userId: input.userId, role: input.role },
            tx,
          );
        },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AlreadyOrgMemberError(input.userId, input.organizationId);
      }
      throw err;
    }
  },

  /**
   * Add a member to the org BY EMAIL — the org-admin "invite to organization"
   * surface (6.10.5). Resolves the email to an EXISTING Motir user, then runs
   * the same add-to-org flow as `addMember` (org-admin gate + create + the
   * AlreadyOrgMemberError mapping). Throws OrgInviteeNotFoundError when no
   * account matches: org membership is the root tenancy tier, so an org member
   * must already be a Motir user — brand-new people join by accepting a
   * WORKSPACE invite, which auto-enrols them in that workspace's org via the
   * upward invariant (6.10.2 §5i). The email lookup is unrelated reference data
   * (no write yet), so it reads off the singleton; `addMember` owns the
   * transaction + the gate.
   */
  async addMemberByEmail(input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    actorUserId: string;
  }): Promise<void> {
    const user = await userRepository.findByEmail(input.email);
    if (!user) throw new OrgInviteeNotFoundError(input.email);
    await this.addMember({
      organizationId: input.organizationId,
      userId: user.id,
      role: input.role,
      actorUserId: input.actorUserId,
    });
  },

  /**
   * Change a member's org role. Requires the actor to be an org owner/admin.
   * Guards the last owner: demoting the only remaining owner is refused
   * (LastOrgOwnerError). The guard LOCKS the org's owner rows `FOR UPDATE`
   * before counting (assertNotLastOwner), so two concurrent demotions of a
   * 2-owner org serialize — the second blocks, re-counts after the first
   * commits, and is refused — and the org can never drop to zero owners.
   */
  async changeMemberRole(input: {
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    actorUserId: string;
  }): Promise<void> {
    await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgAdmin(input.actorUserId, input.organizationId, tx);
        if (input.role !== ORGANIZATION_ROLE.owner) {
          await assertNotLastOwner(input.organizationId, input.userId, tx);
        }
        await organizationMembershipRepository.updateRole(
          input.organizationId,
          input.userId,
          input.role,
          tx,
        );
      },
    );
  },

  /**
   * Remove a member from the org. Allowed for an org owner/admin, OR a member
   * removing themselves (self-leave). Removing from the org cascades loss of all
   * workspace access (the gate denies once the org membership is gone — 6.10.2
   * §5iii); we deliberately do NOT delete the workspace_membership rows (the
   * asymmetry: leaving a workspace doesn't drop org membership, and the gate is
   * what enforces access, not row presence). Guards the last owner — the guard
   * LOCKS the org's owner rows `FOR UPDATE` before counting (assertNotLastOwner),
   * so two concurrent removals of a 2-owner org serialize and the org can never
   * drop to zero owners. Idempotent: removing a non-member is a no-op.
   */
  async removeMember(input: {
    organizationId: string;
    userId: string;
    actorUserId: string;
  }): Promise<void> {
    await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        const isSelfLeave = input.actorUserId === input.userId;
        if (!isSelfLeave) {
          await assertOrgAdmin(input.actorUserId, input.organizationId, tx);
        }
        await assertNotLastOwner(input.organizationId, input.userId, tx);
        await organizationMembershipRepository.deleteByOrgAndUser(
          input.organizationId,
          input.userId,
          tx,
        );
      },
    );
  },

  /**
   * The UPWARD auto-join primitive (6.10.2 §5i): ensure `userId` has an
   * OrganizationMembership in `organizationId`, creating a `member`-role row if
   * absent. Idempotent (a duplicate create is swallowed). Called by the
   * workspace-add flow (workspacesService.addMember / workspace creation) INSIDE
   * its transaction so "you cannot be in a workspace without being in its org"
   * holds atomically. Takes the caller's `tx`; does not own a transaction.
   */
  async ensureOrgMembership(
    userId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const existing = await organizationMembershipRepository.findByOrgAndUserInTx(
      organizationId,
      userId,
      tx,
    );
    if (existing) return;
    try {
      await organizationMembershipRepository.create(
        { organizationId, userId, role: ORGANIZATION_ROLE.member },
        tx,
      );
    } catch (err) {
      // A concurrent add lost the race to the unique (organizationId, userId) —
      // the invariant still holds (the row now exists), so treat as a no-op.
      if (!isUniqueViolation(err)) throw err;
    }
  },

  // ── The active org + the user's orgs (the shell switcher) ─────────────────

  /** Every organization the user belongs to (for the org switcher). */
  async listUserOrganizations(userId: string): Promise<OrganizationDTO[]> {
    const orgs = await withUserContext(userId, () =>
      organizationMembershipRepository.findOrganizationsByUser(userId),
    );
    return orgs.map(toOrganizationDTO);
  },

  /**
   * Resolve the user's active organization (the preferred one if they belong to
   * it, else their first membership) plus their org role in it. Returns null
   * when the user belongs to no org. Reads under withUserContext so the
   * membership-scoped RLS policies bite on the non-bypass app role.
   */
  async resolveActiveOrganization(
    userId: string,
    preferredOrganizationId?: string | null,
  ): Promise<CurrentOrganizationDTO | null> {
    return withUserContext(userId, async (tx) => {
      if (preferredOrganizationId) {
        const pinned = await organizationMembershipRepository.findByOrgAndUserInTx(
          preferredOrganizationId,
          userId,
          tx,
        );
        if (pinned) {
          const org = await organizationRepository.findByIdInTx(preferredOrganizationId, tx);
          if (org) return toCurrentOrganizationDTO(org, pinned.role);
        }
      }
      const orgs = await organizationMembershipRepository.findOrganizationsByUser(userId);
      const first = orgs[0];
      if (!first) return null;
      const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
        first.id,
        userId,
        tx,
      );
      return membership ? toCurrentOrganizationDTO(first, membership.role) : null;
    });
  },

  // ── The cross-workspace member roster (paginated — the at-scale rule) ─────

  /**
   * One keyset-paginated page of the org's members ACROSS its workspaces: each
   * member, their org role, and which of the org's workspaces they belong to.
   * The actor must be a member of the org (a non-member raises
   * OrganizationNotFoundError → 404, the no-leak rule). NEVER loads the roster
   * whole (finding #57): `limit` is clamped to ROSTER_MAX_LIMIT and the page
   * carries a `nextCursor` for the next fetch.
   */
  async listMembers(input: {
    organizationId: string;
    actorUserId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<OrgMemberPageDTO> {
    const limit = Math.min(Math.max(input.limit ?? ROSTER_DEFAULT_LIMIT, 1), ROSTER_MAX_LIMIT);
    return withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgMember(input.actorUserId, input.organizationId, tx);

        const page = await organizationMembershipRepository.findMembersByOrgPage(
          input.organizationId,
          limit,
          input.cursor ?? null,
          tx,
        );
        const hasMore = page.length > limit;
        const rows = hasMore ? page.slice(0, limit) : page;
        const nextCursor = hasMore ? rows[rows.length - 1]!.id : null;
        const total = await organizationMembershipRepository.countByOrg(input.organizationId, tx);

        // Enrich each member with the org's workspaces they belong to. One read
        // for the org's workspaces + one for this page's memberships across them.
        const workspaces = await workspaceRepository.listByOrganization(input.organizationId, tx);
        const workspaceNameById = new Map(workspaces.map((w) => [w.id, w.name]));
        const memberships = await workspaceMembershipRepository.findByWorkspaceIdsAndUserIds(
          workspaces.map((w) => w.id),
          rows.map((r) => r.user.id),
          tx,
        );
        const workspacesByUser = new Map<string, { id: string; name: string }[]>();
        for (const m of memberships) {
          const list = workspacesByUser.get(m.userId) ?? [];
          list.push({ id: m.workspaceId, name: workspaceNameById.get(m.workspaceId) ?? '' });
          workspacesByUser.set(m.userId, list);
        }

        const members: OrgMemberDTO[] = rows.map((row) =>
          toOrgMemberDTO(row, workspacesByUser.get(row.user.id) ?? []),
        );
        return { members, nextCursor, total };
      },
    );
  },

  // ── The org footprint summary (the "how established is this org?" signal) ──

  /**
   * Summarize `(userId)`'s view of `organizationId`'s footprint — workspace /
   * project counts, a capped sample of project names, and the org-wide team
   * size — for the AI discovery classification (Subtask 7.3.45). The actor must
   * be a member of the org (a non-member raises OrganizationNotFoundError → 404,
   * the no-leak rule).
   *
   * Read AS the actor, honouring RLS exactly like the rest of this service:
   *   - `memberCount` is the ORG-WIDE team size — counted under the active-org
   *     context, where the org-membership policy admits every member's row.
   *   - `workspaces` is what the actor can see in the org — the workspace policy
   *     admits the workspaces they're a member of (no app.workspace_id is bound
   *     here, so the membership branch is the one that bites).
   *   - PROJECTS are workspace-scoped under RLS (the project policy keys strictly
   *     on `app.workspace_id`), so they're counted by ENTERING each workspace's
   *     context — one bound transaction per workspace. `projectNames` is capped
   *     (FOOTPRINT_PROJECT_NAME_CAP) while `projectCount` stays exact.
   *
   * No cross-tenant bypass: an org's footprint is summarised only from rows the
   * token's user could already read, the same posture as the read-back surface.
   */
  async summarizeOrgFootprint(input: {
    userId: string;
    organizationId: string;
  }): Promise<OrgFootprintDTO> {
    // Org-wide team size + the actor's workspaces in the org, in one bound
    // transaction. assertOrgMember gates access (404-not-403) before counting.
    const { organization, memberCount, workspaces } = await withOrgContext(
      { userId: input.userId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgMember(input.userId, input.organizationId, tx);
        const organization = await organizationRepository.findByIdInTx(input.organizationId, tx);
        if (!organization) throw new OrganizationNotFoundError(input.organizationId);
        const memberCount = await organizationMembershipRepository.countByOrg(
          input.organizationId,
          tx,
        );
        const workspaces = await workspaceRepository.listByOrganization(input.organizationId, tx);
        return { organization, memberCount, workspaces };
      },
    );

    // Projects: counted per workspace under the workspace context the project
    // RLS policy needs. The names sample is capped; the count is exact.
    let projectCount = 0;
    const projectNames: string[] = [];
    for (const workspace of workspaces) {
      const projects = await withWorkspaceContext(
        { userId: input.userId, workspaceId: workspace.id },
        (tx) => projectRepository.findByWorkspace(workspace.id, tx),
      );
      projectCount += projects.length;
      for (const project of projects) {
        if (projectNames.length < FOOTPRINT_PROJECT_NAME_CAP) projectNames.push(project.name);
      }
    }

    return {
      organization: toOrganizationDTO(organization),
      workspaceCount: workspaces.length,
      projectCount,
      projectNames,
      memberCount,
    };
  },
};

// ── Internal authorization helpers (read the actor's own membership; the
// org_membership RLS policy's userId branch admits it under the bound context) ─

async function assertOrgMember(
  userId: string,
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<OrganizationRole> {
  const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
    organizationId,
    userId,
    tx,
  );
  // Cross-tenant no-leak: a non-member sees the org as not-found, never as
  // forbidden (the 404-not-403 rule).
  if (!membership) throw new OrganizationNotFoundError(organizationId);
  return membership.role;
}

async function assertOrgAdmin(
  userId: string,
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const role = await assertOrgMember(userId, organizationId, tx);
  // The actor IS in the org (so it's visible to them) but lacks admin rights →
  // 403, distinct from the not-found gate above.
  if (!isOrgAdminRole(role)) throw new OrgForbiddenError(userId, organizationId);
}

async function assertNotLastOwner(
  organizationId: string,
  targetUserId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const target = await organizationMembershipRepository.findByOrgAndUserInTx(
    organizationId,
    targetUserId,
    tx,
  );
  // Only removing/demoting an OWNER can drop the owner count; a non-owner target
  // (or a non-member) can't, so there's nothing to guard.
  if (!target || target.role !== ORGANIZATION_ROLE.owner) return;
  // Lock the org's owner rows before counting (lock-before-read-derived-update):
  // a plain COUNT doesn't lock the rows a concurrent remove/demote mutates, so
  // two racers could both see count = 2 and both write → zero owners. The
  // FOR-UPDATE read serializes them — the second blocks, re-reads the reduced
  // owner set, and correctly hits LastOrgOwnerError.
  const owners = await organizationMembershipRepository.countOwnersByOrgForUpdate(
    organizationId,
    tx,
  );
  if (owners <= 1) throw new LastOrgOwnerError(organizationId);
}
