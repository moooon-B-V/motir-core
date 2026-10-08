import 'server-only';

import type { IdeaKind } from '@/generated/prisma/client';
import type {
  AddIdeasResultDto,
  IdeaResearchRunDto,
  StaffIdeaDto,
  StaffIdeaListDto,
  StaffIdeaTagDto,
} from '@/lib/dto/ideas';
import {
  IDEA_SLUG_MAX,
  IDEA_SLUG_PATTERN,
  isIdeaCategory,
  isIdeaKind,
} from '@/lib/ideas/categories';
import { IDEA_LIMITS } from '@/lib/ideas/limits';
import {
  IdeaNotActiveError,
  IdeaNotFoundError,
  IdeaSlugTakenError,
  IdeaTagTakenError,
  InvalidIdeaInputError,
  UnknownIdeaTagError,
  type IdeaValidationIssue,
} from '@/lib/ideas/errors';
import type {
  IdeaActor,
  IdeaEvidenceInput,
  IdeaInput,
  IdeaPatch,
  IdeaResearchRunInput,
  IdeaTagInput,
  StaffIdeaFilters,
} from '@/lib/ideas/types';
import { toIdeaResearchRunDto, toStaffIdeaDto, toStaffIdeaTagDto } from '@/lib/mappers/ideaMappers';
import { platformRoleAtLeast } from '@/lib/platform/auth';
import { withPlatformRead, withPlatformWrite } from '@/lib/platform/context';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { PRISMA_UNIQUE_VIOLATION } from '@/lib/prisma/uniqueViolation';
import {
  ideaRepository,
  type IdeaEvidenceRowInput,
  type IdeaRowUpdate,
  type IdeaWithRelations,
} from '@/lib/repositories/ideaRepository';
import { ideaResearchRunRepository } from '@/lib/repositories/ideaResearchRunRepository';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { ideaTagRepository } from '@/lib/repositories/ideaTagRepository';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The idea store's STAFF service (Story MOTIR-7662 · MOTIR-7671) — every write,
 * and the staff reads the console and the `motir-ideas` skill need.
 *
 * WHO MAY CALL IT is decided above it: the ideas gate
 * (`lib/platform/ideasGate.ts`) turns a request into an `IdeaActor` or a 404,
 * from the console session or — on `/api/platform/ideas/**` only — a staff
 * member's personal access token. ADR §2 asks every platform-scoped service
 * method to assert the gate independently; on a token request that cannot mean
 * `requirePlatformStaff` (it reads the session a token request lacks), so each
 * method re-checks the ACTOR's role against its own level instead (§2's
 * 2026-10-07 amendment).
 *
 * THE LEVELS: the three staff READS (`listForStaff`, `getForStaff`, `listTags`)
 * are `support`, so every staff role can look over the store in the console's
 * Ideas page (MOTIR-7680, design `platform-admin` § Ideas → The roles); every
 * write is `operator`, and `deleteIdea` is `superadmin`. The HTTP door asks for
 * more than the service does — `/api/platform/ideas` reads at `operator` — and
 * that is the route's choice, not this file's: a gate above may only narrow.
 *
 * EVERY WRITE IS ONE TRANSACTION WITH ITS AUDIT ROWS (`withPlatformWrite`): the
 * chain lock is taken first, the change is made, and one `idea.*` row per
 * changed thing is appended — so a failed write leaves neither the change nor a
 * row, and platform writes serialize on the lock, which is what makes the two
 * races below deterministic:
 *  - a duplicate slug across two concurrent batches: the second batch reads the
 *    first's committed slugs after the lock and is refused whole
 *    (`IdeaSlugTakenError`); the unique index backs it if anything slips past;
 *  - two concurrent retires: the conditional `UPDATE … WHERE status = 'active'`
 *    touches no row for the loser (`IdeaNotActiveError`).
 */

const LEVEL_READ = 'support' as const;
const LEVEL_WRITE = 'operator' as const;
const LEVEL_DELETE = 'superadmin' as const;

const MAX_BATCH = 20;
const MAX_REASON = 2000;
const STAFF_PAGE_DEFAULT = 50;
const STAFF_PAGE_MAX = 200;
const RUNS_DEFAULT = 10;
const RUNS_MAX = 100;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}

function assertLevel(
  actor: IdeaActor,
  level: typeof LEVEL_READ | typeof LEVEL_WRITE | typeof LEVEL_DELETE,
): void {
  if (!platformRoleAtLeast(actor.role, level)) throw new NotPlatformStaffError();
}

/** The `inherited` reason when the caller gave none — the caller's context, stated. */
function contextReason(actor: IdeaActor, explicit?: string | null): string {
  const given = explicit?.trim();
  if (given) return given;
  return actor.credential.kind === 'token'
    ? 'Written through /api/platform/ideas with a personal access token'
    : 'Edited in the operator console';
}

function credentialMetadata(actor: IdeaActor): Prisma.InputJsonObject {
  return actor.credential.kind === 'token'
    ? { kind: 'token', apiTokenId: actor.credential.apiTokenId }
    : { kind: 'session' };
}

function auditTarget(row: { id: string; slug: string }) {
  return { targetKind: 'idea' as const, targetId: row.id, targetLabel: row.slug };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseSourceDate(value: string | null | undefined): Date | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null;
  if (!ISO_DATE.test(value)) return 'invalid';
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'invalid';
  return date;
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

function optionalText(value: string | null | undefined): string | null {
  return blank(value) ? null : value!.trim();
}

/** The shape every idea must have, checked on a new idea and on an edit's merged result. */
interface IdeaShape {
  slug: string;
  title: string;
  pitch: string;
  kind: IdeaKind;
  category: string;
  capabilities: string[];
  evidence: IdeaEvidenceInput[];
  tags: string[];
  gap: string | null;
  whyNow: string | null;
  whyMotir: string | null;
  whoElse: string | null;
}

function validateShape(shape: IdeaShape, issues: IdeaValidationIssue[]): void {
  const at = (field: string, message: string) =>
    issues.push({ slug: shape.slug || null, field, message });

  if (!IDEA_SLUG_PATTERN.test(shape.slug) || shape.slug.length > IDEA_SLUG_MAX) {
    at('slug', `must be lowercase words joined by "-", at most ${IDEA_SLUG_MAX} characters`);
  }
  if (blank(shape.title) || shape.title.length > IDEA_LIMITS.title) {
    at('title', `is required, at most ${IDEA_LIMITS.title} characters`);
  }
  if (blank(shape.pitch) || shape.pitch.length > IDEA_LIMITS.pitch) {
    at('pitch', `is required, at most ${IDEA_LIMITS.pitch} characters`);
  }
  if (!isIdeaKind(shape.kind)) at('kind', 'is not a known kind');
  if (!isIdeaCategory(shape.category)) at('category', 'is not a known category');
  for (const field of ['gap', 'whyNow', 'whyMotir', 'whoElse'] as const) {
    const value = shape[field];
    if (value !== null && value.length > IDEA_LIMITS.longText) {
      at(field, `is at most ${IDEA_LIMITS.longText} characters`);
    }
  }
  if (shape.kind === 'direction' && (shape.whyMotir !== null || shape.whoElse !== null)) {
    at('whyMotir', 'whyMotir and whoElse belong to a motir_buys idea only');
  }
  if (shape.kind === 'direction' && shape.evidence.length === 0) {
    at('evidence', 'a direction needs at least one evidence row');
  }
  if (shape.capabilities.length > IDEA_LIMITS.capabilities) {
    at('capabilities', `at most ${IDEA_LIMITS.capabilities}`);
  }
  shape.capabilities.forEach((c, i) => {
    if (blank(c) || c.length > IDEA_LIMITS.capability) {
      at(`capabilities[${i}]`, `is required, at most ${IDEA_LIMITS.capability} characters`);
    }
  });
  if (shape.tags.length > IDEA_LIMITS.tags) at('tags', `at most ${IDEA_LIMITS.tags}`);
  if (new Set(shape.tags).size !== shape.tags.length) at('tags', 'must not repeat a tag');
  if (shape.evidence.length > IDEA_LIMITS.evidence) {
    at('evidence', `at most ${IDEA_LIMITS.evidence} rows`);
  }
  shape.evidence.forEach((e, i) => {
    if (blank(e.claim) || e.claim.length > IDEA_LIMITS.claim) {
      at(`evidence[${i}].claim`, `is required, at most ${IDEA_LIMITS.claim} characters`);
    }
    if (blank(e.sourceName) || e.sourceName.length > IDEA_LIMITS.sourceName) {
      at(`evidence[${i}].sourceName`, `is required, at most ${IDEA_LIMITS.sourceName} characters`);
    }
    if (!isHttpsUrl(e.url) || e.url.length > IDEA_LIMITS.url) {
      at(`evidence[${i}].url`, 'must be an absolute https URL');
    }
    if (parseSourceDate(e.sourceDate) === 'invalid') {
      at(`evidence[${i}].sourceDate`, 'must be a real date as YYYY-MM-DD');
    }
  });
}

function toEvidenceRows(evidence: IdeaEvidenceInput[]): IdeaEvidenceRowInput[] {
  return evidence.map((e) => ({
    claim: e.claim.trim(),
    sourceName: e.sourceName.trim(),
    url: e.url.trim(),
    sourceDate: parseSourceDate(e.sourceDate) as Date | null,
  }));
}

function shapeOfInput(input: IdeaInput): IdeaShape {
  return {
    slug: input.slug,
    title: input.title,
    pitch: input.pitch,
    kind: input.kind,
    category: input.category,
    capabilities: input.capabilities ?? [],
    evidence: input.evidence ?? [],
    tags: input.tags ?? [],
    gap: optionalText(input.gap),
    whyNow: optionalText(input.whyNow),
    whyMotir: optionalText(input.whyMotir),
    whoElse: optionalText(input.whoElse),
  };
}

function shapeOfRow(row: IdeaWithRelations): IdeaShape {
  return {
    slug: row.slug,
    title: row.title,
    pitch: row.pitch,
    kind: row.kind,
    category: row.category,
    capabilities: row.capabilities,
    evidence: row.evidence.map((e) => ({
      claim: e.claim,
      sourceName: e.sourceName,
      url: e.url,
      sourceDate: e.sourceDate ? e.sourceDate.toISOString().slice(0, 10) : null,
    })),
    tags: row.tags.map((a) => a.tag.slug),
    gap: row.gap,
    whyNow: row.whyNow,
    whyMotir: row.whyMotir,
    whoElse: row.whoElse,
  };
}

/** Resolve tag slugs to ids, or refuse naming every unknown one. */
async function resolveTagIds(
  slugs: string[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, string>> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return new Map();
  const found = await ideaTagRepository.findBySlugs(unique, tx);
  const bySlug = new Map(found.map((t) => [t.slug, t.id]));
  const unknown = unique.filter((s) => !bySlug.has(s)).sort();
  if (unknown.length > 0) throw new UnknownIdeaTagError(unknown);
  return bySlug;
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.length > MAX_REASON) {
    throw new InvalidIdeaInputError([
      { slug: null, field: 'reason', message: `is required, at most ${MAX_REASON} characters` },
    ]);
  }
  return trimmed;
}

interface StaffCursor {
  addedAt: Date;
  id: string;
}

function encodeCursor(row: { addedAt: Date; id: string }): string {
  return Buffer.from(`${row.addedAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): StaffCursor | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const addedAt = new Date(iso ?? '');
  if (!id || Number.isNaN(addedAt.getTime())) {
    throw new InvalidIdeaInputError([
      { slug: null, field: 'cursor', message: 'is not a cursor this API issued' },
    ]);
  }
  return { addedAt, id };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export const ideasAdminService = {
  /**
   * Add a batch of ideas — all of them or none. Refuses the whole batch on any
   * invalid idea, any unknown tag, or any slug already in the store or repeated
   * inside the batch (naming every one). One `idea.add` row per idea.
   */
  async addIdeas(
    actor: IdeaActor,
    ideas: IdeaInput[],
    reason?: string | null,
  ): Promise<AddIdeasResultDto> {
    assertLevel(actor, LEVEL_WRITE);
    if (ideas.length === 0 || ideas.length > MAX_BATCH) {
      throw new InvalidIdeaInputError([
        { slug: null, field: 'ideas', message: `a batch holds 1 to ${MAX_BATCH} ideas` },
      ]);
    }
    const shapes = ideas.map(shapeOfInput);
    const issues: IdeaValidationIssue[] = [];
    shapes.forEach((shape) => validateShape(shape, issues));
    if (issues.length > 0) throw new InvalidIdeaInputError(issues);

    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const shape of shapes) {
      if (seen.has(shape.slug)) repeated.add(shape.slug);
      seen.add(shape.slug);
    }
    const auditReason = contextReason(actor, reason);
    const credential = credentialMetadata(actor);

    try {
      return await withPlatformWrite(actor, async (tx, record) => {
        const taken = new Set([
          ...repeated,
          ...(await ideaRepository.existingSlugs([...seen], tx)),
        ]);
        if (taken.size > 0) throw new IdeaSlugTakenError([...taken].sort());
        const tagIds = await resolveTagIds(
          shapes.flatMap((s) => s.tags),
          tx,
        );

        const slugs: string[] = [];
        for (const shape of shapes) {
          const row = await ideaRepository.create(
            {
              slug: shape.slug,
              title: shape.title.trim(),
              pitch: shape.pitch.trim(),
              kind: shape.kind,
              category: shape.category as IdeaWithRelations['category'],
              capabilities: shape.capabilities.map((c) => c.trim()),
              gap: shape.gap,
              whyNow: shape.whyNow,
              whyMotir: shape.whyMotir,
              whoElse: shape.whoElse,
            },
            toEvidenceRows(shape.evidence),
            shape.tags.map((t) => tagIds.get(t)!),
            tx,
          );
          await record({
            action: 'idea.add',
            ...auditTarget(row),
            reason: auditReason,
            metadata: { credential, kind: row.kind, category: row.category, title: row.title },
          });
          slugs.push(row.slug);
        }
        return { slugs };
      });
    } catch (err) {
      // A slug committed between our read and our insert — impossible while
      // platform writes serialize on the chain lock, but the index is the
      // backstop and its answer must stay typed.
      if (isUniqueViolation(err)) {
        throw new IdeaSlugTakenError([...seen].sort());
      }
      throw err;
    }
  },

  /**
   * A sparse edit of an idea of any status. Evidence and tags, when given,
   * replace the lists wholesale; `reviewed: true` stamps `lastReviewedAt`. The
   * merged result must still satisfy every rule a new idea does. One
   * `idea.update` row naming the changed fields.
   */
  async updateIdea(actor: IdeaActor, slug: string, patch: IdeaPatch): Promise<StaffIdeaDto> {
    assertLevel(actor, LEVEL_WRITE);
    const auditReason = contextReason(actor, patch.reason);
    const credential = credentialMetadata(actor);

    return withPlatformWrite(actor, async (tx, record) => {
      const current = await ideaRepository.findBySlugInTx(slug, tx);
      if (!current) throw new IdeaNotFoundError(slug);

      const update: IdeaRowUpdate = {};
      const changed: string[] = [];
      if (patch.title !== undefined) {
        update.title = patch.title.trim();
        changed.push('title');
      }
      if (patch.pitch !== undefined) {
        update.pitch = patch.pitch.trim();
        changed.push('pitch');
      }
      if (patch.kind !== undefined) {
        update.kind = patch.kind;
        changed.push('kind');
      }
      if (patch.category !== undefined) {
        update.category = patch.category;
        changed.push('category');
      }
      if (patch.capabilities !== undefined) {
        update.capabilities = patch.capabilities.map((c) => c.trim());
        changed.push('capabilities');
      }
      for (const field of ['gap', 'whyNow', 'whyMotir', 'whoElse'] as const) {
        if (patch[field] !== undefined) {
          update[field] = optionalText(patch[field]);
          changed.push(field);
        }
      }
      if (patch.evidence !== undefined) changed.push('evidence');
      if (patch.tags !== undefined) changed.push('tags');
      if (patch.reviewed) {
        update.lastReviewedAt = new Date();
        changed.push('lastReviewedAt');
      }
      if (changed.length === 0) {
        throw new InvalidIdeaInputError([{ slug, field: 'patch', message: 'changes nothing' }]);
      }

      const merged: IdeaShape = {
        ...shapeOfRow(current),
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.pitch !== undefined ? { pitch: update.pitch } : {}),
        ...(update.kind !== undefined ? { kind: update.kind } : {}),
        ...(update.category !== undefined ? { category: update.category } : {}),
        ...(update.capabilities !== undefined ? { capabilities: update.capabilities } : {}),
        ...(update.gap !== undefined ? { gap: update.gap } : {}),
        ...(update.whyNow !== undefined ? { whyNow: update.whyNow } : {}),
        ...(update.whyMotir !== undefined ? { whyMotir: update.whyMotir } : {}),
        ...(update.whoElse !== undefined ? { whoElse: update.whoElse } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      };
      const issues: IdeaValidationIssue[] = [];
      validateShape(merged, issues);
      if (issues.length > 0) throw new InvalidIdeaInputError(issues);

      if (patch.evidence !== undefined) update.evidence = toEvidenceRows(patch.evidence);
      if (patch.tags !== undefined) {
        const tagIds = await resolveTagIds(patch.tags, tx);
        update.tagIds = patch.tags.map((t) => tagIds.get(t)!);
      }

      const row = await ideaRepository.updateBySlug(slug, update, tx);
      await record({
        action: 'idea.update',
        ...auditTarget(row),
        reason: auditReason,
        metadata: { credential, fields: changed },
      });
      return toStaffIdeaDto(row);
    });
  },

  /** Retire an active idea with a stated reason; it leaves every public read. */
  async retireIdea(actor: IdeaActor, slug: string, reason: string): Promise<StaffIdeaDto> {
    assertLevel(actor, LEVEL_WRITE);
    const stated = requireReason(reason);
    const credential = credentialMetadata(actor);

    return withPlatformWrite(actor, async (tx, record) => {
      const touched = await ideaRepository.retireBySlug(slug, stated, new Date(), tx);
      const row = await ideaRepository.findBySlugInTx(slug, tx);
      if (!row) throw new IdeaNotFoundError(slug);
      if (touched === 0) throw new IdeaNotActiveError(slug);
      await record({
        action: 'idea.retire',
        ...auditTarget(row),
        reason: stated,
        metadata: { credential, title: row.title },
      });
      return toStaffIdeaDto(row);
    });
  },

  /**
   * Hard-delete an idea — a superadmin's correction of a mistake, re-checked
   * here and not only at the route. The audit row keeps the slug and title,
   * because it outlives the idea.
   */
  async deleteIdea(actor: IdeaActor, slug: string, reason: string): Promise<void> {
    assertLevel(actor, LEVEL_DELETE);
    const stated = requireReason(reason);
    const credential = credentialMetadata(actor);

    await withPlatformWrite(actor, async (tx, record) => {
      const row = await ideaRepository.findBySlugInTx(slug, tx);
      if (!row) throw new IdeaNotFoundError(slug);
      await ideaRepository.deleteById(row.id, tx);
      await record({
        action: 'idea.delete',
        ...auditTarget(row),
        reason: stated,
        metadata: { credential, slug: row.slug, title: row.title, status: row.status },
      });
    });
  },

  /** Add a vocabulary tag. A new tag needs a stated reason — its description. */
  async addTag(actor: IdeaActor, input: IdeaTagInput): Promise<StaffIdeaTagDto> {
    assertLevel(actor, LEVEL_WRITE);
    const slug = input.slug?.trim() ?? '';
    const label = input.label?.trim() ?? '';
    const description = input.description?.trim() ?? '';
    const issues: IdeaValidationIssue[] = [];
    if (!IDEA_SLUG_PATTERN.test(slug) || slug.length > IDEA_SLUG_MAX) {
      issues.push({
        slug: slug || null,
        field: 'slug',
        message: 'must be lowercase words joined by "-"',
      });
    }
    if (label.length === 0 || label.length > IDEA_LIMITS.tagLabel) {
      issues.push({
        slug: slug || null,
        field: 'label',
        message: `is required, at most ${IDEA_LIMITS.tagLabel} characters`,
      });
    }
    if (description.length === 0 || description.length > IDEA_LIMITS.tagDescription) {
      issues.push({
        slug: slug || null,
        field: 'description',
        message: `a new tag needs a stated reason, at most ${IDEA_LIMITS.tagDescription} characters`,
      });
    }
    if (issues.length > 0) throw new InvalidIdeaInputError(issues);
    const credential = credentialMetadata(actor);

    try {
      return await withPlatformWrite(actor, async (tx, record) => {
        if ((await ideaTagRepository.findBySlugs([slug], tx)).length > 0) {
          throw new IdeaTagTakenError(slug);
        }
        const tag = await ideaTagRepository.create({ slug, label, description }, tx);
        await record({
          action: 'idea.tag_add',
          targetKind: 'idea',
          targetId: tag.id,
          targetLabel: `tag:${tag.slug}`,
          reason: description,
          metadata: { credential, slug: tag.slug, label: tag.label },
        });
        return { slug: tag.slug, label: tag.label, description: tag.description, count: 0 };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new IdeaTagTakenError(slug);
      throw err;
    }
  },

  /** Record one research run of the `motir-ideas` skill. */
  async recordResearchRun(
    actor: IdeaActor,
    input: IdeaResearchRunInput,
  ): Promise<IdeaResearchRunDto> {
    assertLevel(actor, LEVEL_WRITE);
    const issues: IdeaValidationIssue[] = [];
    const areas = (input.areasCovered ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
    if (areas.length > IDEA_LIMITS.areas) {
      issues.push({ slug: null, field: 'areasCovered', message: `at most ${IDEA_LIMITS.areas}` });
    }
    for (const field of ['addedCount', 'retiredCount'] as const) {
      const value = input[field];
      if (!Number.isInteger(value) || value < 0) {
        issues.push({ slug: null, field, message: 'must be a non-negative integer' });
      }
    }
    if (blank(input.reportMd) || input.reportMd.length > IDEA_LIMITS.reportMd) {
      issues.push({
        slug: null,
        field: 'reportMd',
        message: `is required, at most ${IDEA_LIMITS.reportMd} characters`,
      });
    }
    if (issues.length > 0) throw new InvalidIdeaInputError(issues);
    const credential = credentialMetadata(actor);

    return withPlatformWrite(actor, async (tx, record) => {
      const run = await ideaResearchRunRepository.create(
        {
          actorUserId: actor.userId,
          areasCovered: areas,
          addedCount: input.addedCount,
          retiredCount: input.retiredCount,
          reportMd: input.reportMd,
        },
        tx,
      );
      await record({
        action: 'idea.research_run',
        targetKind: 'idea',
        targetId: run.id,
        targetLabel: 'research run',
        reason: contextReason(actor),
        metadata: {
          credential,
          areasCovered: areas,
          addedCount: run.addedCount,
          retiredCount: run.retiredCount,
        },
      });
      return toIdeaResearchRunDto(run);
    });
  },

  /** The most recent research runs, newest first. */
  async listResearchRuns(actor: IdeaActor, limit?: number): Promise<IdeaResearchRunDto[]> {
    assertLevel(actor, LEVEL_WRITE);
    const rows = await ideaResearchRunRepository.listRecent(
      clampLimit(limit, RUNS_DEFAULT, RUNS_MAX),
    );
    return rows.map(toIdeaResearchRunDto);
  },

  /** Ideas of every status (unless one is named), newest first, keyset-paged. */
  async listForStaff(actor: IdeaActor, filters: StaffIdeaFilters = {}): Promise<StaffIdeaListDto> {
    assertLevel(actor, LEVEL_READ);
    const limit = clampLimit(filters.limit, STAFF_PAGE_DEFAULT, STAFF_PAGE_MAX);
    const rows = await ideaRepository.findAllForStaff({
      status: filters.status,
      kind: filters.kind,
      category: filters.category,
      tag: filters.tag?.trim() || undefined,
      q: filters.q?.trim().slice(0, 200) || undefined,
      after: decodeCursor(filters.cursor),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toStaffIdeaDto),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  },

  /** One idea of any status. */
  async getForStaff(actor: IdeaActor, slug: string): Promise<StaffIdeaDto> {
    assertLevel(actor, LEVEL_READ);
    const row = await ideaRepository.findBySlugForStaff(slug);
    if (!row) throw new IdeaNotFoundError(slug);
    return toStaffIdeaDto(row);
  },

  /**
   * Who retired an idea — the console's Retired box names them (design
   * `platform-admin` § Ideas, Panel 8c). `StaffIdeaDto` carries the reason and
   * the date but no actor, so this reads the idea's newest `idea.retire` row.
   * The audit log is a platform table, so the read runs in a platform context
   * and is itself audited `estate.read` on the idea, the way `lastStop` reads
   * the fleet's. Null for an active idea (no read is made) and for a retire
   * with no row behind it.
   */
  async retiredBy(
    actor: IdeaActor,
    idea: Pick<StaffIdeaDto, 'id' | 'slug' | 'status'>,
  ): Promise<string | null> {
    assertLevel(actor, LEVEL_READ);
    if (idea.status !== 'retired') return null;
    const row = await withPlatformRead(
      actor,
      { action: 'estate.read', ...auditTarget(idea) },
      (tx) =>
        platformAuditLogRepository.findLatestByTargetAndAction('idea', idea.id, 'idea.retire', tx),
    );
    return row?.actor?.name || row?.actor?.email || null;
  },

  /** The whole tag vocabulary, with how many ideas of any status carry each tag. */
  async listTags(actor: IdeaActor): Promise<StaffIdeaTagDto[]> {
    assertLevel(actor, LEVEL_READ);
    const rows = await ideaTagRepository.listAll();
    return rows.map(toStaffIdeaTagDto);
  },
};
