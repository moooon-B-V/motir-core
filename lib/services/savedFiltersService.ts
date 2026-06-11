import { Prisma, type Project, type SavedFilterVisibility } from '@prisma/client';
import { db } from '@/lib/db';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import type { SavedFilterListView } from '@/lib/repositories/savedFilterRepository';
import { savedFilterStarRepository } from '@/lib/repositories/savedFilterStarRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  canChangeSavedFilterOwner,
  canCreateSavedFilter,
  canManageSavedFilter,
  canSeeSavedFilter,
  type SavedFilterProjectCapabilities,
  type SavedFilterRowFacts,
} from '@/lib/savedFilters/access';
import {
  BUILTIN_FILTERS,
  builtinFilterById,
  isBuiltinFilterId,
  type BuiltinFilterDef,
} from '@/lib/savedFilters/builtins';
import {
  SAVED_FILTER_DESCRIPTION_MAX_LENGTH,
  SAVED_FILTER_NAME_MAX_LENGTH,
  SAVED_FILTER_PAGE_MAX,
  SAVED_FILTER_PAGE_SIZE,
} from '@/lib/savedFilters/constants';
import {
  BuiltinSavedFilterImmutableError,
  InvalidSavedFilterNameError,
  InvalidSavedFilterOwnerError,
  SavedFilterForbiddenError,
  SavedFilterNameConflictError,
  SavedFilterNotFoundError,
} from '@/lib/savedFilters/errors';
import { retryOnceOnUniqueRace } from '@/lib/savedFilters/retry';
import {
  decodeFilterEnvelope,
  decodeFilterParam,
  encodeFilterEnvelope,
  type FilterAst,
} from '@/lib/filters/ast';
import { validateFilterAst } from '@/lib/filters/registry';
import { FilterValidationError, MalformedFilterError } from '@/lib/filters/errors';
import {
  toBuiltinFilterSummaryDto,
  toSavedFilterSummaryDto,
  type SavedFilterWithStars,
} from '@/lib/mappers/savedFilterMappers';
import type {
  ResolvedSavedFilterDto,
  SavedFilterAstError,
  SavedFilterDependentsDto,
  SavedFilterPageDto,
  SavedFilterSummaryDto,
} from '@/lib/dto/savedFilters';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Saved-filters service (Story 6.2 · Subtask 6.2.1) — persistence +
// permissions for the 6.1 filter substrate. Owns validation (name caps, the
// case-insensitive per-project uniqueness), the (role × visibility × action)
// permission matrix (the pure half in lib/savedFilters/access.ts), the
// built-in defaults, transactions, and DTO mapping. Routes are HTTP-only
// (CLAUDE.md).
//
// THE DURABILITY RULE (the load-bearing piece): the stored payload is the
// versioned envelope the 6.1.1 codec defines — every resolve DECODES +
// REGISTRY-VALIDATES it (`decodeFilterEnvelope` → `validateFilterAst`),
// never trust-and-compile. A malformed / future-versioned / registry-invalid
// stored envelope degrades to the typed `astError` state (never a crash); a
// stale OPEN referent inside a valid AST (deleted member / sprint / status)
// passes validation and simply matches nothing downstream — the 6.1.2
// unknown-value rule, recorded for exactly this story.
//
// Incoming criteria ride the SAME codec: writes accept the `?filter=v1:`
// PARAM STRING (the 6.1.4 builder already holds it — one codec, two
// carriers), decode it, deep-validate it, and store the envelope form.
//
// Permission hide-gates follow finding #44: a missing / cross-tenant /
// non-browsable project reads as ProjectNotFoundError (404); a filter the
// actor may not SEE reads as SavedFilterNotFoundError (404) — "you can't see
// it" is indistinguishable from "it doesn't exist". Visible-but-forbidden
// actions are SavedFilterForbiddenError (403).

interface ProjectAndCaps {
  project: Project;
  caps: SavedFilterProjectCapabilities;
}

/**
 * Resolve the project by key within the actor's workspace and compute the
 * actor's saved-filter tier — the entry gate every method runs first. A
 * missing / cross-tenant key OR a non-browsable project reads as
 * ProjectNotFoundError (404, no existence leak).
 */
async function resolveProjectAndCaps(
  projectKey: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<ProjectAndCaps> {
  const key = projectKey.trim().toUpperCase();
  const project = await projectRepository.findByIdentifier(ctx.workspaceId, key, tx);
  if (!project) throw new ProjectNotFoundError(projectKey);
  const caps = await projectAccessService.getSavedFilterCapabilities(project.id, ctx, tx);
  if (!caps.canBrowse) throw new ProjectNotFoundError(projectKey);
  return { project, caps };
}

function rowFacts(row: { ownerId: string; visibility: SavedFilterVisibility }, userId: string) {
  return { isOwner: row.ownerId === userId, visibility: row.visibility } as SavedFilterRowFacts;
}

/**
 * Read one row under the SEE gate: it must exist, belong to this project,
 * and sit inside the actor's visibility — anything else is the 404. Returns
 * the star-decorated row (the DTO read).
 */
async function getVisibleFilter(
  filterId: string,
  { project, caps }: ProjectAndCaps,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<SavedFilterWithStars> {
  const row = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
  if (!row || row.projectId !== project.id) throw new SavedFilterNotFoundError(filterId);
  if (!canSeeSavedFilter(caps, rowFacts(row, ctx.userId))) {
    throw new SavedFilterNotFoundError(filterId);
  }
  return row;
}

/** Validate + normalize a display name (trimmed, non-empty, capped). */
function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new InvalidSavedFilterNameError('A saved filter name must not be empty.');
  }
  if (name.length > SAVED_FILTER_NAME_MAX_LENGTH) {
    throw new InvalidSavedFilterNameError(
      `A saved filter name is at most ${SAVED_FILTER_NAME_MAX_LENGTH} characters.`,
    );
  }
  return name;
}

/** Validate + normalize an optional description (trimmed; empty → null). */
function normalizeDescription(raw: string | null | undefined): string | null {
  const description = raw?.trim() ?? '';
  if (description.length === 0) return null;
  if (description.length > SAVED_FILTER_DESCRIPTION_MAX_LENGTH) {
    throw new InvalidSavedFilterNameError(
      `A saved filter description is at most ${SAVED_FILTER_DESCRIPTION_MAX_LENGTH} characters.`,
    );
  }
  return description;
}

/**
 * Decode + deep-validate an incoming `?filter=v1:` param string into an AST
 * (the write-side half of the one-codec rule). Throws the lib/filters typed
 * errors (→ 422) — an invalid INCOMING filter is a rejection, unlike a
 * stored envelope gone stale, which degrades on read.
 */
function parseIncomingFilterParam(filterParam: string): FilterAst {
  const decoded = decodeFilterParam(filterParam);
  if (!decoded.ok) throw new MalformedFilterError(`${decoded.reason}: ${decoded.detail}`);
  validateFilterAst(decoded.ast);
  return decoded.ast;
}

/** Decode + deep-validate a STORED envelope into the typed recoverable pair
 * (`ast` xor `astError`) — the read-side half. NEVER throws. */
function resolveStoredEnvelope(envelope: unknown): {
  ast: FilterAst | null;
  astError: SavedFilterAstError | null;
} {
  const decoded = decodeFilterEnvelope(envelope);
  if (!decoded.ok) return { ast: null, astError: decoded };
  try {
    validateFilterAst(decoded.ast);
  } catch (err) {
    if (err instanceof FilterValidationError) {
      return { ast: null, astError: { ok: false, reason: 'invalid', detail: err.message } };
    }
    throw err;
  }
  return { ast: decoded.ast, astError: null };
}

/** The project's done-CATEGORY status keys — the per-resolve input the
 * Open/Done built-ins compile against (read fresh, never stored). */
async function doneStatusKeys(project: Project, ctx: ServiceContext): Promise<string[]> {
  const statuses = await workflowsRepository.findStatuses(project.id, ctx.workspaceId);
  return statuses.filter((s) => s.category === 'done').map((s) => s.key);
}

function resolveBuiltin(
  def: BuiltinFilterDef,
  keys: string[],
  caps: SavedFilterProjectCapabilities,
  ctx: ServiceContext,
): ResolvedSavedFilterDto {
  const ast = def.build({ userId: ctx.userId, doneStatusKeys: keys });
  // Built-ins compile to registry-valid ASTs by construction (the totality
  // test enumerates them); validate anyway — defence in depth, same as the
  // stored path.
  validateFilterAst(ast);
  return {
    filter: toBuiltinFilterSummaryDto(def),
    ast,
    astError: null,
    capabilities: {
      canManage: false,
      canDelete: false,
      canChangeOwner: false,
      canShare: caps.canShare,
    },
  };
}

export interface CreateSavedFilterInput {
  name: string;
  description?: string | null;
  visibility: SavedFilterVisibility;
  /** The `?filter=v1:` param string the builder holds (one codec, two carriers). */
  filterParam: string;
}

export interface UpdateSavedFilterInput {
  name?: string;
  description?: string | null;
  visibility?: SavedFilterVisibility;
  /** Overwrite-save of the criteria (the owner's "Save"). */
  filterParam?: string;
}

export interface ListSavedFiltersInput {
  view?: SavedFilterListView;
  q?: string;
  cursor?: string;
  limit?: number;
}

export const savedFiltersService = {
  /**
   * Create a saved filter from the builder's current state ("Save as").
   * Visibility `private` needs only browse (viewers included — filters are a
   * read-layer construct); `project` needs the share tier (role ≥ member).
   * Names are case-insensitively unique per project — a clash is the typed
   * 409: the pre-check catches the serial case, and a concurrent race trips
   * the `@@unique` backstop, re-runs once ({@link retryOnceOnUniqueRace}),
   * and lands on the pre-check's typed conflict.
   */
  async create(
    projectKey: string,
    input: CreateSavedFilterInput,
    ctx: ServiceContext,
  ): Promise<SavedFilterSummaryDto> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const ast = parseIncomingFilterParam(input.filterParam);

    return retryOnceOnUniqueRace(() =>
      db.$transaction(async (tx) => {
        const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
        if (!canCreateSavedFilter(pc.caps, input.visibility)) {
          throw new SavedFilterForbiddenError('share');
        }
        const clash = await savedFilterRepository.findByNameLower(
          pc.project.id,
          name.toLowerCase(),
          tx,
        );
        if (clash) throw new SavedFilterNameConflictError(name);
        const created = await savedFilterRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId: pc.project.id,
            ownerId: ctx.userId,
            name,
            nameLower: name.toLowerCase(),
            description,
            visibility: input.visibility,
            astEnvelope: encodeFilterEnvelope(ast) as unknown as Prisma.InputJsonValue,
          },
          tx,
        );
        const row = await savedFilterRepository.findByIdWithStars(created.id, ctx.userId, tx);
        // The row was created in this transaction; the re-read cannot miss.
        return toSavedFilterSummaryDto(row as SavedFilterWithStars);
      }),
    );
  },

  /**
   * One page of the project's filters, name-ordered, server-searched
   * (case-insensitive name substring), cursor-paged and bounded (finding
   * #57). The visibility predicate is constant across views: project-shared
   * rows + the actor's own + (admin tier) others' private rows. `view`
   * slices it — `mine` / `project` / `starred` for the directory tabs; `all`
   * is the directory default AND the dropdown read (each row carries
   * `starredByMe` + owner, so the dropdown groups client-side from one
   * read). The built-in defaults ride along on `all` (constants, `q`-filtered
   * so the dropdown search covers them; never paginated).
   */
  async list(
    projectKey: string,
    input: ListSavedFiltersInput,
    ctx: ServiceContext,
  ): Promise<SavedFilterPageDto> {
    const pc = await resolveProjectAndCaps(projectKey, ctx);
    const view = input.view ?? 'all';
    const take = Math.min(
      Math.max(input.limit ?? SAVED_FILTER_PAGE_SIZE, 1),
      SAVED_FILTER_PAGE_MAX,
    );
    const listArgs = {
      projectId: pc.project.id,
      actorUserId: ctx.userId,
      actorIsAdmin: pc.caps.isAdmin,
      view,
      q: input.q,
    };
    const rows = await savedFilterRepository.listPage({
      ...listArgs,
      cursor: input.cursor,
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const total = await savedFilterRepository.countVisible(listArgs);

    const q = input.q?.trim().toLowerCase() ?? '';
    const builtins =
      view === 'all'
        ? BUILTIN_FILTERS.filter((b) => b.name.toLowerCase().includes(q)).map(
            toBuiltinFilterSummaryDto,
          )
        : [];

    return {
      items: page.map(toSavedFilterSummaryDto),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      total,
      builtins,
    };
  },

  /**
   * THE Story 6.3 data-source contract (and the 6.2.3 apply read): resolve a
   * filter id — a row id or a `builtin:<slug>` — to its decoded +
   * registry-validated AST plus metadata and the actor's capabilities.
   *
   * Durability: the stored envelope is decoded and deep-validated on EVERY
   * resolve (never trust-and-compile). A malformed / future-versioned /
   * registry-invalid envelope returns `ast: null` + the typed `astError`
   * (the consumer renders the designed degraded state — the verified Cloud
   * "filter could not be retrieved" behaviour); it never throws. A returned
   * non-null `ast` is guaranteed registry-valid; consumers hand it to the
   * work-item read paths (`workItemRepository` compiles it, re-validating in
   * depth), where a stale OPEN referent (deleted member / sprint / status)
   * matches nothing per the 6.1.2 unknown-value rule. A consumer holding a
   * DELETED filter id gets the 404 — its designed "filter missing" state.
   *
   * Built-ins resolve through the same read: their ASTs are computed per
   * call (current user, the project's CURRENT done-category status keys) and
   * are never persisted, so they cannot go stale.
   */
  async resolve(
    projectKey: string,
    filterId: string,
    ctx: ServiceContext,
  ): Promise<ResolvedSavedFilterDto> {
    const pc = await resolveProjectAndCaps(projectKey, ctx);

    if (isBuiltinFilterId(filterId)) {
      const def = builtinFilterById(filterId);
      if (!def) throw new SavedFilterNotFoundError(filterId);
      return resolveBuiltin(def, await doneStatusKeys(pc.project, ctx), pc.caps, ctx);
    }

    const row = await getVisibleFilter(filterId, pc, ctx);
    const facts = rowFacts(row, ctx.userId);
    const manage = canManageSavedFilter(pc.caps, facts);
    return {
      filter: toSavedFilterSummaryDto(row),
      ...resolveStoredEnvelope(row.astEnvelope),
      capabilities: {
        canManage: manage,
        canDelete: manage,
        canChangeOwner: canChangeSavedFilterOwner(pc.caps, facts),
        canShare: pc.caps.canShare,
      },
    };
  },

  /**
   * Update name / description / visibility / criteria (the owner's
   * overwrite-"Save", the directory's rename + edit-details + visibility
   * actions). Owner or — on project-shared filters — the admin tier; flipping
   * TO `project` additionally needs the share tier. The row is `FOR UPDATE`
   * locked before the permission re-read (the lock-before-read-derived-update
   * rule) so concurrent writers serialize.
   */
  async update(
    projectKey: string,
    filterId: string,
    input: UpdateSavedFilterInput,
    ctx: ServiceContext,
  ): Promise<SavedFilterSummaryDto> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    const name = input.name === undefined ? undefined : normalizeName(input.name);
    const description =
      input.description === undefined ? undefined : normalizeDescription(input.description);
    const ast =
      input.filterParam === undefined ? undefined : parseIncomingFilterParam(input.filterParam);

    return retryOnceOnUniqueRace(() =>
      db.$transaction(async (tx) => {
        const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
        await savedFilterRepository.lockById(filterId, tx);
        const row = await getVisibleFilter(filterId, pc, ctx, tx);
        const facts = rowFacts(row, ctx.userId);
        if (!canManageSavedFilter(pc.caps, facts)) {
          throw new SavedFilterForbiddenError('update');
        }
        if (
          input.visibility === 'project' &&
          row.visibility !== 'project' &&
          !canCreateSavedFilter(pc.caps, 'project')
        ) {
          throw new SavedFilterForbiddenError('share');
        }
        if (name !== undefined && name.toLowerCase() !== row.nameLower) {
          const clash = await savedFilterRepository.findByNameLower(
            pc.project.id,
            name.toLowerCase(),
            tx,
          );
          if (clash && clash.id !== filterId) throw new SavedFilterNameConflictError(name);
        }
        await savedFilterRepository.update(
          filterId,
          {
            ...(name !== undefined ? { name, nameLower: name.toLowerCase() } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(ast !== undefined
              ? { astEnvelope: encodeFilterEnvelope(ast) as unknown as Prisma.InputJsonValue }
              : {}),
          },
          tx,
        );
        const updated = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
        return toSavedFilterSummaryDto(updated as SavedFilterWithStars);
      }),
    );
  },

  /**
   * Change a project-shared filter's owner — the admin tier only (the
   * mirror's "admins can change owner of any shared filter", project-sized).
   * The new owner must be able to BROWSE the project (otherwise the filter
   * would become invisible to its own owner).
   */
  async changeOwner(
    projectKey: string,
    filterId: string,
    newOwnerId: string,
    ctx: ServiceContext,
  ): Promise<SavedFilterSummaryDto> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    return db.$transaction(async (tx) => {
      const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
      await savedFilterRepository.lockById(filterId, tx);
      const row = await getVisibleFilter(filterId, pc, ctx, tx);
      if (!canChangeSavedFilterOwner(pc.caps, rowFacts(row, ctx.userId))) {
        throw new SavedFilterForbiddenError('change-owner');
      }
      // A missing user and a user who can't browse are the same rejection —
      // getCapabilities resolves a null workspace membership to all-false.
      const target = await projectAccessService.getCapabilities(
        pc.project.id,
        { userId: newOwnerId, workspaceId: ctx.workspaceId },
        tx,
      );
      if (!target.canBrowse) throw new InvalidSavedFilterOwnerError(newOwnerId);
      await savedFilterRepository.update(filterId, { ownerId: newOwnerId }, tx);
      const updated = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
      return toSavedFilterSummaryDto(updated as SavedFilterWithStars);
    });
  },

  /**
   * Delete — owner or (on project-shared filters) the admin tier. Stars die
   * with the row (FK Cascade); 6.2.5 subscriptions FK-cascade the same way,
   * so the whole removal is one transaction. The UI warns FIRST via
   * {@link savedFiltersService.getDependents} (the Cloud-style dialog).
   */
  async delete(projectKey: string, filterId: string, ctx: ServiceContext): Promise<void> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    await db.$transaction(async (tx) => {
      const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
      await savedFilterRepository.lockById(filterId, tx);
      const row = await getVisibleFilter(filterId, pc, ctx, tx);
      if (!canManageSavedFilter(pc.caps, rowFacts(row, ctx.userId))) {
        throw new SavedFilterForbiddenError('delete');
      }
      await savedFilterRepository.delete(filterId, tx);
    });
  },

  /**
   * Enumerate what a delete would take with it — the read behind the
   * Cloud-style warning ("N subscriptions will be removed"). THE SEAM:
   * subscriptions land in 6.2.5 (their count joins in here); Story 6.3
   * widget usages join in by FK later. Both are additive to the DTO, so the
   * 6.2.2-designed dialog wires against this read today.
   */
  async getDependents(
    projectKey: string,
    filterId: string,
    ctx: ServiceContext,
  ): Promise<SavedFilterDependentsDto> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    const pc = await resolveProjectAndCaps(projectKey, ctx);
    await getVisibleFilter(filterId, pc, ctx);
    return { subscriptionCount: 0 };
  },

  /**
   * Star a visible filter — any browser, viewers included (the read-layer
   * rule); idempotent: a re-star finds the existing row and no-ops, and the
   * concurrent first-star race re-runs ONCE in a fresh transaction (the
   * `retryOnceOnUniqueRace` pattern — a P2002 poisons its transaction, so
   * the loser cannot just swallow it in place). Built-ins are not starrable
   * (no row to FK — the immutability rule; if the 6.2.2 design decides
   * otherwise, that's a recorded extension needing its own carrier).
   */
  async star(
    projectKey: string,
    filterId: string,
    ctx: ServiceContext,
  ): Promise<SavedFilterSummaryDto> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    return retryOnceOnUniqueRace(() =>
      db.$transaction(async (tx) => {
        const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
        const row = await getVisibleFilter(filterId, pc, ctx, tx);
        const existing = await savedFilterStarRepository.findByFilterAndUser(
          row.id,
          ctx.userId,
          tx,
        );
        if (!existing) {
          await savedFilterStarRepository.create({ savedFilterId: row.id, userId: ctx.userId }, tx);
        }
        const updated = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
        return toSavedFilterSummaryDto(updated as SavedFilterWithStars);
      }),
    );
  },

  /** Unstar — idempotent (unstarring a never-starred filter is a no-op). */
  async unstar(
    projectKey: string,
    filterId: string,
    ctx: ServiceContext,
  ): Promise<SavedFilterSummaryDto> {
    if (isBuiltinFilterId(filterId)) throw new BuiltinSavedFilterImmutableError();
    return db.$transaction(async (tx) => {
      const pc = await resolveProjectAndCaps(projectKey, ctx, tx);
      const row = await getVisibleFilter(filterId, pc, ctx, tx);
      await savedFilterStarRepository.deleteByFilterAndUser(row.id, ctx.userId, tx);
      const updated = await savedFilterRepository.findByIdWithStars(filterId, ctx.userId, tx);
      return toSavedFilterSummaryDto(updated as SavedFilterWithStars);
    });
  },
};
