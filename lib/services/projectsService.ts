import { Prisma, type Project } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectKeyAliasRepository } from '@/lib/repositories/projectKeyAliasRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { NotAMemberError } from '@/lib/workspaces/errors';
import {
  AliasNotFoundError,
  IdentifierCollisionError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAvatarError,
  InvalidIdentifierError,
  InvalidProjectNameError,
  ProjectNotFoundError,
  ProjectWorkspaceMismatchError,
} from '@/lib/projects/errors';
import { isValidAvatarColor, isValidAvatarIcon } from '@/lib/projects/avatar';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import { workflowsService } from '@/lib/services/workflowsService';
import { boardsService } from '@/lib/services/boardsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ProjectDTO } from '@/lib/dto/projects';

// Projects service — business logic for the Project entity. Owns all
// $transaction calls, the membership gate, identifier/slug derivation +
// collision-retry, and DTO mapping. Mirrors workspacesService: each retry
// opens a FRESH transaction because a P2002 poisons the current one.
//
// Subtask 1.3.2 adds:
//   * getActiveProject(userId, workspaceId) — resolves the member's
//     activeProjectId, falls back to the workspace's first non-archived
//     project, returns a DTO or null.
//   * RLS-aware writes — every project-scoped write (create/rename/archive/
//     setActiveProject/list) now runs inside withWorkspaceContext so the
//     project RLS policy added in 20260529202445_add_project_rls permits
//     the operation under the non-bypass prodect_app role. The membership
//     assertion stays as the application-layer gate (defense in depth: the
//     assertion gives a typed NotAMemberError, the RLS policy is the
//     structural backstop). Under the dev/CI superuser role (BYPASSRLS) the
//     withWorkspaceContext wrapper is a behavioral no-op, so the existing
//     1.3.1 counter test stays green without modification.

// ── Identifier derivation rule ──────────────────────────────────────────
// The identifier is a 3-5 char, uppercase, workspace-unique handle that
// prefixes work-item keys (e.g. "PROD-42"). Rule:
//   1. Uppercase the name and strip everything that isn't A-Z or 0-9.
//   2. Take the first 5 of those characters as the base.
//   3. If fewer than 3 remain (short or symbol-only names), right-pad with
//      'X' up to 3 chars so the identifier is always at least 3 chars
//      ("X" → "XXX", "Hi" → "HIX", "A1" → "A1X").
//   4. Empty after stripping (e.g. "!!!") falls back to "PRJ".
// On a workspace-unique collision we append a numeric suffix to the base,
// keeping the whole thing within 5 chars by trimming the base as needed
// ("PROD" → "PROD1" … "PROD9" → "PRO10" …).
const IDENTIFIER_MIN_LENGTH = 3;
const IDENTIFIER_MAX_LENGTH = 5;
const IDENTIFIER_FALLBACK = 'PRJ';
const SLUG_MAX_LENGTH = 60;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RETRY_ATTEMPTS = 5;

function deriveIdentifierBase(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0) return IDENTIFIER_FALLBACK;
  const base = cleaned.slice(0, IDENTIFIER_MAX_LENGTH);
  return base.padEnd(IDENTIFIER_MIN_LENGTH, 'X');
}

// Normalize a caller-supplied identifier the same way (uppercase, strip,
// clamp to 3-5 chars) so an explicit identifier still obeys the column's
// shape contract.
function normalizeIdentifier(identifier: string): string {
  const cleaned = identifier.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0) return IDENTIFIER_FALLBACK;
  return cleaned.slice(0, IDENTIFIER_MAX_LENGTH).padEnd(IDENTIFIER_MIN_LENGTH, 'X');
}

// STRICT key-shape guard for an EXPLICIT key change (Story 6.8 `changeKey`),
// distinct from `normalizeIdentifier` above: the create path COERCES a derived
// or caller-supplied identifier into shape (pad/clamp), but an admin renaming
// the key must be REJECTED on a malformed value rather than silently mutated —
// renaming every issue to a key the admin never typed is a surprising,
// hard-to-undo change (Jira likewise rejects a malformed key — rung 1). The
// shape is the shipped column contract: 3–5 chars, uppercase A–Z / 0–9.
const IDENTIFIER_SHAPE = /^[A-Z0-9]{3,5}$/;
function isValidIdentifierShape(identifier: string): boolean {
  return IDENTIFIER_SHAPE.test(identifier);
}

// Module-private sentinel: the create-path identifier the loop is about to use
// is RESERVED by a project_key_alias (Story 6.8 — a new project must not take a
// retired key). Thrown inside the create transaction so the existing
// catch-and-re-suffix path advances to the next candidate, exactly as it does
// for a P2002 unique violation. Never escapes the service.
class ReservedIdentifierSentinel extends Error {}

// Append a numeric suffix while staying within IDENTIFIER_MAX_LENGTH by
// trimming the base end as the suffix grows.
function identifierWithSuffix(base: string, suffix: number): string {
  const suffixStr = String(suffix);
  const keep = Math.max(1, IDENTIFIER_MAX_LENGTH - suffixStr.length);
  return `${base.slice(0, keep)}${suffixStr}`;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  return slug || 'project';
}

function randomSlugSuffix(): string {
  let out = '';
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i++) {
    out += SLUG_SUFFIX_ALPHABET[Math.floor(Math.random() * SLUG_SUFFIX_ALPHABET.length)];
  }
  return out;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface CreateProjectInput {
  workspaceId: string;
  actorUserId: string;
  name: string;
  identifier?: string;
}

export const projectsService = {
  /**
   * Create a project in a workspace. Asserts the actor is a member, derives
   * a workspace-unique 3-5-char uppercase identifier + a slug from the name
   * (or normalizes a caller-supplied identifier), and inserts in one
   * transaction. On a unique-violation we re-suffix BOTH fields and retry
   * in a FRESH transaction — a P2002 poisons the current one, so we can't
   * catch-and-continue inside a single `tx`. After RETRY_ATTEMPTS we throw
   * IdentifierCollisionError. Returns a DTO, never a raw Prisma row.
   *
   * Why re-suffix BOTH fields on every retry rather than just the colliding
   * one: Prisma 7's `P2002.meta.target` is `undefined` against Postgres 16
   * on the project table (PRODECT_FINDINGS #15), so we can't reliably tell
   * which unique index fired. Unconditionally advancing both is the
   * durable correctness fix — identifier monotonicity is preserved by the
   * `attempt + 1` numeric suffix; slug gets a fresh random suffix per
   * retry. Trade-off: a slug-only collision wastes one identifier suffix
   * value (PROD → PROD1) even though PROD was actually fine. Acceptable —
   * identifier suffixes are cheap and human-readable.
   */
  async createProject(input: CreateProjectInput): Promise<ProjectDTO> {
    await projectsService.assertMembership(input.actorUserId, input.workspaceId);

    const trimmedName = input.name.trim();
    const identifierBase = input.identifier
      ? normalizeIdentifier(input.identifier)
      : deriveIdentifierBase(trimmedName);
    const slugBase = slugify(trimmedName);

    let identifier = identifierBase;
    let slug = slugBase;
    let lastIdentifier = identifier;

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      lastIdentifier = identifier;
      try {
        // The INSERT must happen INSIDE withWorkspaceContext so the project
        // RLS policy's WITH CHECK passes (it requires the new row's
        // workspaceId to equal the active-workspace GUC). Each retry opens
        // a FRESH withWorkspaceContext transaction — a P2002 poisons the
        // current one, so we can't catch-and-continue inside a single tx.
        const project = await withWorkspaceContext(
          { userId: input.actorUserId, workspaceId: input.workspaceId },
          async (tx) => {
            // Reserved-key guard (Story 6.8): a new project must not take a key
            // reserved by another project's retired-key alias. The alias table is
            // a SEPARATE table from `project`, so a reserved key does NOT trip the
            // project's unique index — it needs an explicit check. Throwing the
            // sentinel rolls back this attempt and re-suffixes in the catch,
            // exactly like a P2002 (nothing has been written yet).
            const reserved = await projectKeyAliasRepository.findByWorkspaceAndIdentifier(
              input.workspaceId,
              identifier,
              tx,
            );
            if (reserved) throw new ReservedIdentifierSentinel();
            const created = await projectRepository.create(
              { workspaceId: input.workspaceId, name: trimmedName, slug, identifier },
              tx,
            );
            // Seed the default status workflow in the SAME transaction (Subtask
            // 2.2.2): a project either has its workflow or doesn't exist. A
            // P2002 on identifier/slug rolls back the project AND its seed; the
            // next retry re-seeds in a fresh transaction.
            await workflowsService.seedDefaultWorkflow(created.id, input.workspaceId, tx);
            // Then seed the default Kanban board (Subtask 3.1.2) in the SAME
            // transaction — it reads the statuses just written above to project
            // one column per status, so it MUST run after the workflow seed and
            // within the same tx (the statuses aren't visible outside it yet).
            await boardsService.seedDefaultBoard(created.id, input.workspaceId, tx);
            return created;
          },
        );
        return toProjectDTO(project);
      } catch (err) {
        // A P2002 (live identifier/slug collision) OR a reserved-alias hit both
        // mean "this candidate is taken" — re-suffix BOTH fields and retry in a
        // fresh transaction (see method docstring).
        if (isUniqueViolation(err) || err instanceof ReservedIdentifierSentinel) {
          identifier = identifierWithSuffix(identifierBase, attempt + 1);
          slug = `${slugBase}-${randomSlugSuffix()}`;
          continue;
        }
        throw err;
      }
    }
    throw new IdentifierCollisionError(lastIdentifier);
  },

  /**
   * Rename a project. Asserts membership, updates the name in a
   * transaction. Slug + identifier are stable (not regenerated) — they are
   * durable handles that work-item keys and URLs depend on.
   */
  async renameProject(input: {
    projectId: string;
    workspaceId: string;
    actorUserId: string;
    name: string;
  }): Promise<ProjectDTO> {
    await projectsService.assertMembership(input.actorUserId, input.workspaceId);
    const trimmed = input.name.trim();
    // The cross-workspace guard (assertProjectInWorkspace) and the UPDATE
    // both run inside withWorkspaceContext so (a) the project RLS policy
    // exposes the row to the read under prodect_app, and (b) the UPDATE's
    // WITH CHECK predicate is satisfied by the same workspace GUC.
    const project = await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        await projectsService.assertProjectInWorkspaceInTx(input.projectId, input.workspaceId, tx);
        return projectRepository.update(input.projectId, { name: trimmed }, tx);
      },
    );
    return toProjectDTO(project);
  },

  /**
   * Soft-delete (archive) a project. Asserts membership, stamps archivedAt
   * in a transaction. Never hard-deletes — work-item history (Story 1.4)
   * survives the archive.
   *
   * Also clears the ACTOR's own `activeProjectId` pointer when it referenced
   * the just-archived project (PRODECT_FINDINGS #29 + the gap #16 logged in
   * the 1.3.2 tests). This is what makes the archived-active states coherent
   * across members:
   *   - The actor who archived "moves on" — their pointer drops to null and
   *     `getActiveProject` recovers to the next non-archived project (or the
   *     empty state when none remain). This preserves the silent-fallback
   *     behaviour the 1.3.4 projects-flow already relies on.
   *   - OTHER members who had the same project pinned keep their pointer, so
   *     `getActiveProject` surfaces it for them with the "Archived" pill
   *     (#29.2) until they switch — rather than silently swapping it out.
   * Done in the SAME transaction as the archive so the row can't be left
   * pointing at a project that was archived a moment earlier.
   */
  async archiveProject(input: {
    projectId: string;
    workspaceId: string;
    actorUserId: string;
  }): Promise<void> {
    await projectsService.assertMembership(input.actorUserId, input.workspaceId);
    await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        await projectsService.assertProjectInWorkspaceInTx(input.projectId, input.workspaceId, tx);
        await projectRepository.archive(input.projectId, tx);

        const membership = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
          input.actorUserId,
          input.workspaceId,
          tx,
        );
        if (membership?.activeProjectId === input.projectId) {
          await workspaceMembershipRepository.setActiveProject(
            input.actorUserId,
            input.workspaceId,
            null,
            tx,
          );
        }
      },
    );
  },

  /**
   * List the non-archived projects in a workspace the actor may BROWSE, as DTOs.
   * Asserts the actor is a member first — the application-layer tenant gate (RLS
   * is the structural backstop, landing in 1.3.2). Then applies the Story 6.4
   * project-access gate (Subtask 6.4.6): a `private` project the actor isn't a
   * member of is filtered OUT, so the switcher / nav / command palette only ever
   * lists projects the actor can actually open (no shown-then-denied). Workspace
   * owner/admin keep every project; the filter resolves roles in one batch (no
   * N+1) inside the same workspace transaction.
   */
  async listProjects(workspaceId: string, actorUserId: string): Promise<ProjectDTO[]> {
    await projectsService.assertMembership(actorUserId, workspaceId);
    const browsable = await withWorkspaceContext(
      { userId: actorUserId, workspaceId },
      async (tx) => {
        const projects = await projectRepository.findByWorkspace(workspaceId, tx);
        return projectAccessService.filterBrowsable(
          projects,
          { userId: actorUserId, workspaceId },
          tx,
        );
      },
    );
    return browsable.map((project) => toProjectDTO(project));
  },

  /**
   * Set the user's active project within a workspace (or clear it with
   * null). Asserts membership and that the project belongs to the
   * workspace, then updates the membership row in a transaction.
   */
  async setActiveProject(input: {
    userId: string;
    workspaceId: string;
    projectId: string | null;
  }): Promise<void> {
    await projectsService.assertMembership(input.userId, input.workspaceId);
    await withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        if (input.projectId !== null) {
          await projectsService.assertProjectInWorkspaceInTx(
            input.projectId,
            input.workspaceId,
            tx,
          );
        }
        return workspaceMembershipRepository.setActiveProject(
          input.userId,
          input.workspaceId,
          input.projectId,
          tx,
        );
      },
    );
  },

  /**
   * Asserts the user is a member of the workspace, throwing NotAMemberError
   * otherwise. Reuses the workspaces-domain error rather than duplicating a
   * project-specific one.
   */
  async assertMembership(userId: string, workspaceId: string): Promise<void> {
    const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
    if (!m) throw new NotAMemberError(userId, workspaceId);
  },

  /**
   * Asserts the project exists and belongs to the given workspace. Guards
   * cross-workspace writes (a member of workspace A can't rename/archive a
   * project that lives in workspace B). Returns the Project for callers
   * that want it. Uses the `db` singleton — only safe under the BYPASSRLS
   * dev role; the in-tx variant below is what production code paths use.
   */
  async assertProjectInWorkspace(projectId: string, workspaceId: string): Promise<Project> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.workspaceId !== workspaceId) {
      throw new ProjectWorkspaceMismatchError(projectId, workspaceId);
    }
    return project;
  },

  /**
   * Resolve a project by its `PROD`-style `identifier` ("key") within the
   * actor's workspace — the lookup the agent-dispatch endpoints (`GET
   * /api/ready` 7.0.4, `POST /api/ready/next` 7.0.5) use to turn a stable
   * `?projectKey=PROD` into a `projectId` the work-items service can scope on.
   *
   * No existence leak (PRODECT_FINDINGS #26). Scoping the read to
   * `ctx.workspaceId` makes "no such project" and "a project that exists in
   * ANOTHER workspace" indistinguishable — both return null here and throw the
   * SAME `ProjectNotFoundError`, which the route maps to 404 (never a 403 that
   * would confirm a cross-tenant key exists). This deliberately differs from
   * `assertProjectInWorkspace`, whose `ProjectWorkspaceMismatchError` is for
   * INTERNAL callers that already hold a trusted id; `getByKey` takes
   * caller-supplied input off the wire, so it must not distinguish the cases.
   *
   * The `key` is upper-cased before lookup: identifiers are canonical
   * uppercase (the derivation rule above), so a CLI passing `prod` resolves
   * the same project as `PROD` — friendlier for the BYOK consumer, and never
   * ambiguous because two identifiers can't differ only by case under the
   * unique constraint.
   *
   * RLS-aware: the read runs inside `withWorkspaceContext` so the project RLS
   * policy exposes the row under the non-bypass prodect_app role (the wrapper
   * binds the workspace GUC the policy keys on); under the dev/CI BYPASSRLS
   * role the wrapper is a behavioural no-op.
   */
  async getByKey(key: string, ctx: WorkspaceContext): Promise<ProjectDTO> {
    const identifier = key.trim().toUpperCase();
    const project = await withWorkspaceContext(ctx, async (tx) => {
      const found = await projectRepository.findByIdentifier(ctx.workspaceId, identifier, tx);
      if (!found) throw new ProjectNotFoundError(key);
      // Project access gate (6.4.3): a non-browser (a non-member of a private
      // project) gets ProjectAccessDeniedError('browse') → 404, indistinguishable
      // from a missing project (no existence leak, same as the not-found above).
      // Gated inside the tx so the membership reads share the RLS workspace GUC.
      await projectAccessService.assertCanBrowse(found.id, ctx, tx);
      return found;
    });
    return toProjectDTO(project);
  },

  /**
   * In-transaction variant of assertProjectInWorkspace. Production-correct:
   * the read happens through the supplied `tx`, so under the non-bypass
   * prodect_app role the project RLS policy gates the row using the same
   * workspace GUC bound by the enclosing withWorkspaceContext. (The
   * non-tx variant above queries via `db` and would return NULL on an
   * RLS-enabled connection without the GUC — only the BYPASSRLS dev role
   * makes it work.)
   */
  async assertProjectInWorkspaceInTx(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    const project = await projectRepository.findById(projectId, tx);
    if (!project) throw new ProjectNotFoundError(projectId);
    if (project.workspaceId !== workspaceId) {
      throw new ProjectWorkspaceMismatchError(projectId, workspaceId);
    }
    return project;
  },

  /**
   * Resolve the user's active project within a workspace. Returns a
   * ProjectDTO (or null when no resolvable project exists). Resolution
   * order:
   *
   *   1. The membership row's `activeProjectId` pointer — IF it's still set
   *      and the project still exists in this workspace. Per PRODECT_FINDINGS
   *      #29.2 we now ACCEPT an archived pinned project here and surface it
   *      (the DTO carries `archivedAt`) so the shell can flag it with an
   *      "Archived" pill, rather than silently swapping the user onto a
   *      different project. The actor who archives a project has their own
   *      pointer cleared by `archiveProject`, so this branch only surfaces an
   *      archived project for OTHER members who still had it pinned.
   *   2. Recovery — the pointer is null (never set / cleared on archive) or
   *      stale (points at a hard-deleted or cross-workspace project) while
   *      ≥1 non-archived project exists. PRODECT_FINDINGS #29.3: auto-select
   *      the first non-archived project (createdAt asc — same ordering as the
   *      switcher), PERSIST it back onto the membership row so the pointer
   *      self-heals, and — when the pointer was set-but-unresolvable (a real
   *      inconsistency, not merely unset) — log a structured warning so we
   *      can measure how often it fires in production.
   *   3. null — no resolvable pinned project AND no non-archived projects
   *      (a fresh workspace, or one whose every project is archived).
   *
   * Reads + the recovery write run inside withWorkspaceContext so the project
   * RLS policy exposes rows (and the membership UPDATE's WITH CHECK passes)
   * under the non-bypass prodect_app role; under the dev BYPASSRLS role the
   * wrapper is a behavioral no-op. Threading the membership read through the
   * same transaction keeps the resolver atomic: the pointer and the project
   * it names are read in the same snapshot, so a concurrent setActiveProject
   * can't shear the result.
   */
  async getActiveProject(userId: string, workspaceId: string): Promise<ProjectDTO | null> {
    return withWorkspaceContext({ userId, workspaceId }, async (tx) => {
      const membership = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
        userId,
        workspaceId,
        tx,
      );
      if (!membership) return null;

      if (membership.activeProjectId) {
        const pinned = await projectRepository.findById(membership.activeProjectId, tx);
        // Accept the pinned project whether archived or not (#29.2): an
        // archived active project is surfaced (with archivedAt set) so the
        // shell shows the "Archived" pill. Only a genuinely unresolvable
        // pointer — hard-deleted (the FK's onDelete: SetNull would have
        // nulled it, but belt + suspenders) or cross-workspace — falls
        // through to recovery below.
        if (pinned && pinned.workspaceId === workspaceId) {
          return toProjectDTO(pinned);
        }
      }

      // No resolvable pinned project. Recover to the first non-archived
      // project if one exists (#29.3), persisting it so the pointer heals.
      const projects = await projectRepository.findByWorkspace(workspaceId, tx);
      const first = projects[0];
      if (!first) return null;

      if (membership.activeProjectId) {
        // The pointer was SET but didn't resolve — a real inconsistency
        // (deleted / cross-workspace). Worth a warning so we can watch it.
        console.warn(
          '[projectsService.getActiveProject] active-project pointer unresolvable; auto-recovering',
          {
            userId,
            workspaceId,
            staleProjectId: membership.activeProjectId,
            recoveredProjectId: first.id,
          },
        );
      }
      await workspaceMembershipRepository.setActiveProject(userId, workspaceId, first.id, tx);
      return toProjectDTO(first);
    });
  },

  // ── Story 6.8 — edit project details + change project key ──────────────────
  // All three write methods are PROJECT-ADMIN gated (the 6.4.3 capability, via
  // projectAccessService.assertCanManage: a non-browser reads as
  // ProjectNotFoundError → 404 so the project stays hidden; a browser who is not
  // an admin → NotProjectAdminError → 403). The project is resolved by its
  // workspace-scoped key INSIDE the transaction (one method = one transaction)
  // so the gate read and the write share a snapshot, and a key naming a project
  // in ANOTHER workspace is indistinguishable from a missing one (no existence
  // leak — same shape as getByKey / projectMembersService).

  /**
   * Read a project's details (the editable Details surface, Story 6.8.4) — the
   * DTO WITH `previousKeys` loaded. BROWSE-gated (assertCanBrowse): anyone who
   * can see the project reads its details; the read-only-for-non-admins
   * rendering is the UI's concern (6.4.6 grammar). Separate from `getByKey`
   * (which the agent-dispatch endpoints use) precisely so the hot key-resolution
   * path keeps its single project-row fetch with no alias join.
   */
  async getDetails(key: string, ctx: WorkspaceContext): Promise<ProjectDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(key, ctx.workspaceId, tx);
      await projectAccessService.assertCanBrowse(project.id, ctx, tx);
      const aliases = await projectKeyAliasRepository.findManyByProject(project.id, tx);
      return toProjectDTO(project, aliases);
    });
  },

  /**
   * Update a project's name and/or avatar (Story 6.8). Admin-gated. `name` is
   * trimmed + non-empty; the `slug` is NOT regenerated — it is a create-time
   * artifact no URL consumes (recorded decision), so a rename keeps every
   * existing slug-addressed link working. Avatar icon/colour are validated
   * against the preset registry (lib/projects/avatar.ts); `null` clears a field
   * back to the shipped mono-identifier rendering; an absent field is left
   * untouched. Returns the DTO with `previousKeys` (the details-surface shape).
   */
  async updateDetails(input: {
    key: string;
    ctx: WorkspaceContext;
    name?: string;
    avatarIcon?: string | null;
    avatarColor?: string | null;
  }): Promise<ProjectDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(input.key, input.ctx.workspaceId, tx);
      await projectAccessService.assertCanManage(project.id, input.ctx, tx);

      const data: { name?: string; avatarIcon?: string | null; avatarColor?: string | null } = {};
      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (!trimmed) throw new InvalidProjectNameError();
        data.name = trimmed;
      }
      if (input.avatarIcon !== undefined) {
        if (input.avatarIcon !== null && !isValidAvatarIcon(input.avatarIcon)) {
          throw new InvalidAvatarError('icon', input.avatarIcon);
        }
        data.avatarIcon = input.avatarIcon;
      }
      if (input.avatarColor !== undefined) {
        if (input.avatarColor !== null && !isValidAvatarColor(input.avatarColor)) {
          throw new InvalidAvatarError('color', input.avatarColor);
        }
        data.avatarColor = input.avatarColor;
      }

      const updated = await projectRepository.update(project.id, data, tx);
      const aliases = await projectKeyAliasRepository.findManyByProject(project.id, tx);
      return toProjectDTO(updated, aliases);
    });
  },

  /**
   * Change a project's key (identifier) mid-project, Jira-faithfully (Story
   * 6.8). Admin-gated. ONE transaction:
   *   1. resolve + admin-gate the project by its CURRENT key;
   *   2. FOR-UPDATE lock the project row (the lock-before-read-derived-update
   *      rule) so a concurrent rename OR issue creation serializes on it, then
   *      RE-READ the identifier under the lock (the committed-current value);
   *   3. no-op guard (new == current → IdentifierUnchangedError);
   *   4. collision guards across ONE key namespace — a LIVE identifier of
   *      another project → IdentifierTakenError; an ALIAS of another project →
   *      IdentifierReservedError; the project's OWN alias → RECLAIM (delete that
   *      alias row so the key goes live again — the verified revert path);
   *   5. a SINGLE bulk `UPDATE work_item SET identifier = <new>-<key>` (the
   *      identifier is derived data — no per-row loop, no revision rows, the
   *      `key` number untouched); this IS the "re-index", synchronous + atomic;
   *   6. record the OLD key as an alias (reserve it — old links keep working);
   *   7. set `project.identifier` to the new key.
   * The new key is validated STRICTLY (rejected, not coerced — see
   * isValidIdentifierShape). Returns the DTO with `previousKeys`.
   */
  async changeKey(input: {
    key: string;
    newKey: string;
    ctx: WorkspaceContext;
  }): Promise<ProjectDTO> {
    const requested = input.newKey.trim().toUpperCase();
    if (!isValidIdentifierShape(requested)) throw new InvalidIdentifierError(input.newKey);
    const { workspaceId } = input.ctx;

    return withWorkspaceContext(input.ctx, async (tx) => {
      const resolved = await resolveProjectByKeyInTx(input.key, workspaceId, tx);
      await projectAccessService.assertCanManage(resolved.id, input.ctx, tx);

      // Serialize on the project row, then re-read the current key under the
      // lock — a concurrent rename committed between the resolve and the lock is
      // now visible, and a concurrent issue creation (whose allocateWorkItemNumber
      // UPDATEs this same row) blocks until we commit.
      await projectRepository.lockById(resolved.id, tx);
      const locked = await projectRepository.findById(resolved.id, tx);
      if (!locked) throw new ProjectNotFoundError(input.key);
      const current = locked.identifier;

      if (requested === current) throw new IdentifierUnchangedError(current);

      // Collision guard across the single (live identifiers ∪ aliases) namespace.
      const liveOther = await projectRepository.findByIdentifier(workspaceId, requested, tx);
      if (liveOther && liveOther.id !== resolved.id) throw new IdentifierTakenError(requested);

      const alias = await projectKeyAliasRepository.findByWorkspaceAndIdentifier(
        workspaceId,
        requested,
        tx,
      );
      if (alias) {
        if (alias.projectId !== resolved.id) throw new IdentifierReservedError(requested);
        // Reclaiming the project's OWN previous key — delete that alias so the
        // key becomes live again (the verified Jira revert path).
        await projectKeyAliasRepository.deleteByWorkspaceAndIdentifier(workspaceId, requested, tx);
      }

      // The bulk rewrite (one statement) + reserve the old key + set the new key.
      await workItemRepository.rewriteIdentifiersForProject(resolved.id, requested, tx);
      await projectKeyAliasRepository.create(
        { workspaceId, projectId: resolved.id, identifier: current },
        tx,
      );
      const updated = await projectRepository.updateIdentifier(resolved.id, requested, tx);

      const aliases = await projectKeyAliasRepository.findManyByProject(resolved.id, tx);
      return toProjectDTO(updated, aliases);
    });
  },

  /**
   * Release a retired key (Story 6.8 — the Jira Cloud "Previous project keys"
   * remove): delete one of the project's alias rows, un-reserving the key (it
   * becomes available to other projects) and BREAKING its old links (they 404
   * thereafter — the verified mirror consequence). Admin-gated. A key that is
   * not one of THIS project's aliases → AliasNotFoundError (404). Returns the
   * DTO with the remaining `previousKeys`.
   */
  async releaseAlias(input: {
    key: string;
    alias: string;
    ctx: WorkspaceContext;
  }): Promise<ProjectDTO> {
    const aliasKey = input.alias.trim().toUpperCase();
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectByKeyInTx(input.key, input.ctx.workspaceId, tx);
      await projectAccessService.assertCanManage(project.id, input.ctx, tx);

      const removed = await projectKeyAliasRepository.deleteByProjectAndIdentifier(
        project.id,
        aliasKey,
        tx,
      );
      if (removed === 0) throw new AliasNotFoundError(aliasKey);

      const fresh = await projectRepository.findById(project.id, tx);
      const aliases = await projectKeyAliasRepository.findManyByProject(project.id, tx);
      return toProjectDTO(fresh ?? project, aliases);
    });
  },
};

/**
 * Resolve a project by its workspace-scoped key inside a transaction, throwing
 * ProjectNotFoundError when no LIVE project carries it (no existence leak — a
 * key in another workspace, or a key that is only an ALIAS, is indistinguishable
 * from a missing project; alias-aware resolution is Subtask 6.8.2's job, not the
 * admin write path's). Mirrors projectMembersService.resolveProjectInTx.
 */
async function resolveProjectByKeyInTx(
  key: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<Project> {
  const identifier = key.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(workspaceId, identifier, tx);
  if (!project) throw new ProjectNotFoundError(key);
  return project;
}
