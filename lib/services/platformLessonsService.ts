import 'server-only';

import {
  editPlatformLesson,
  getPlatformLesson,
  listPlatformLessons,
  promotePlatformLesson,
  setPlatformLessonEnabled,
  type PlatformLessonEditPatch,
  type RawPlatformLesson,
  type RawPlatformLessonWrite,
} from '@/lib/ai/motirAiClient';
import type {
  PlatformLessonDetailDTO,
  PlatformLessonEditInput,
  PlatformLessonListDTO,
  PlatformLessonListFilters,
} from '@/lib/dto/platformLessons';
import {
  isLessonCurateRow,
  tenantNameKey,
  toPlatformLessonDetailDTO,
  toPlatformLessonHistoryEntryDTO,
  toPlatformLessonRowDTO,
  type TenantNameMap,
} from '@/lib/mappers/platformLessonMappers';
import {
  platformRoleAtLeast,
  requirePlatformStaff,
  type PlatformPrincipal,
} from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import { PlatformLessonInvalidError, PlatformLessonUnchangedError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { platformEstateRepository } from '@/lib/repositories/platformEstateRepository';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The platform PLANNING LESSONS console — Story MOTIR-1408 · MOTIR-1411, the
 * core half of motir-ai's `/v1/admin/lessons` (MOTIR-1410). Design:
 * `platform-admin/design-notes.md` § AMENDMENT 2026-10-02 — Planning lessons.
 *
 * Every staff role reads; `operator` edits and switches; `superadmin` promotes.
 * No Prisma here: the lessons are motir-ai's, and core's part is the audit trail
 * and the names behind the tenant ids.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE READS ARE AUDITED, unlike the planning-model page's
 * ---------------------------------------------------------------------------
 * A tenant lesson is customer text, so loading a list page or opening a detail
 * is a cross-tenant read and writes one `estate.read` row. The remote read runs
 * FIRST, outside the transaction: a transaction is never held across a network
 * call, and a read motir-ai could not answer showed nobody anything, so it
 * leaves no row.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THE WRITES: the remote call runs INSIDE the audited transaction
 * ---------------------------------------------------------------------------
 * motir-ai writes no audit row; it answers each write's from → to record and
 * core appends it (the planner-model split). `withPlatformRead` writes the row
 * as its first statement, so the from → to is computed from a read made just
 * before, and a refusal thrown by motir-ai — or its `audit: null` no-op, which
 * this service turns into `PlatformLessonUnchangedError` — rolls the row back.
 * The one residual case is the planner-model one: motir-ai applies the change
 * and core's commit then fails; it is logged with both values.
 */

const PAGE_SIZE = 50;
/** The Organisation filter's options: the newest orgs, the tenants lookup's read. */
const ORG_OPTIONS = 200;
/** "Changes by staff" — this lesson's rows only, newest first. */
const HISTORY_LIMIT = 50;

type EditableField = 'title' | 'why' | 'howToApply' | 'categories';

async function resolveNames(
  lessons: RawPlatformLesson[],
  tx: Prisma.TransactionClient,
): Promise<TenantNameMap> {
  const tenants = lessons.map((l) => l.tenant).filter((t) => t !== null);
  const names = await platformEstateRepository.findTenantNames(
    {
      organizationIds: [...new Set(tenants.map((t) => t.coreOrganizationId))],
      workspaceIds: [...new Set(tenants.map((t) => t.coreWorkspaceId))],
      projectIds: [...new Set(tenants.map((t) => t.coreProjectId))],
    },
    tx,
  );
  return new Map(names.map((n) => [tenantNameKey(n.kind, n.id), n.name]));
}

function cleanCategories(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/** The fields an edit actually moves, as `{ before, after }` and the patch to send. */
function diffEdit(current: RawPlatformLesson, input: PlatformLessonEditInput) {
  const before: Partial<Record<EditableField, unknown>> = {};
  const after: Partial<Record<EditableField, unknown>> = {};
  const patch: PlatformLessonEditPatch = {};
  for (const field of ['title', 'why', 'howToApply'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    const next = value.trim();
    if (next.length === 0) throw new PlatformLessonInvalidError(`${field} cannot be blank`);
    if (next === current[field]) continue;
    before[field] = current[field];
    after[field] = next;
    patch[field] = next;
  }
  if (input.categories !== undefined) {
    const next = cleanCategories(input.categories);
    const now = current.categories ?? [];
    if (next.length !== now.length || next.some((c, i) => c !== now[i])) {
      before.categories = now;
      after.categories = next;
      patch.categories = next;
    }
  }
  return { before, after, patch };
}

/**
 * Run one remote curate write inside the audited transaction, and log the case
 * where motir-ai applied it but core's row did not commit.
 */
async function auditedWrite(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry,
  lessonId: string,
  write: () => Promise<RawPlatformLessonWrite>,
): Promise<RawPlatformLessonWrite> {
  let applied: RawPlatformLessonWrite | null = null;
  try {
    return await withPlatformRead(principal, entry, async () => {
      const written = await write();
      // Someone got there first: motir-ai changed nothing, so the trail must
      // not claim a change — throwing here rolls the row back.
      if (!written.audit) throw new PlatformLessonUnchangedError(lessonId);
      applied = written;
      return written;
    });
  } catch (err) {
    if (applied) {
      const { audit } = applied as RawPlatformLessonWrite;
      console.error(
        `[platform-lessons] motir-ai applied ${entry.action} to lesson ${lessonId} by ` +
          `${principal.userId}, but the audit row did not commit`,
        JSON.stringify({ before: audit?.before, after: audit?.after }),
        err,
      );
    }
    throw err;
  }
}

function baseEntry(
  action: 'ai.lesson.edit' | 'ai.lesson.enable' | 'ai.lesson.disable' | 'ai.lesson.promote',
  lesson: RawPlatformLesson,
  reason: string,
) {
  return {
    action,
    targetKind: 'platform' as const,
    targetId: lesson.id,
    targetLabel: lesson.title,
    ...(lesson.tenant ? { organizationId: lesson.tenant.coreOrganizationId } : {}),
    reason,
  };
}

export const platformLessonsService = {
  /**
   * One page of every tenant's lessons and the global corpus, newest first.
   *
   * @throws NotPlatformStaffError for a non-staff caller.
   * @throws MotirAiError when motir-ai cannot answer — the page shows its error card.
   */
  async list(
    principal: PlatformPrincipal,
    filters: PlatformLessonListFilters,
  ): Promise<PlatformLessonListDTO> {
    await requirePlatformStaff('support');
    const page = await listPlatformLessons({
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.scope ? { scope: filters.scope } : {}),
      ...(filters.mistakeType ? { mistakeType: filters.mistakeType } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.enabled !== undefined ? { enabled: filters.enabled } : {}),
      ...(filters.organizationId ? { coreOrganizationId: filters.organizationId } : {}),
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
      limit: PAGE_SIZE,
    });
    const entry: PlatformAuditEntry = {
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'planning lessons',
    };
    return withPlatformRead(principal, entry, async (tx) => {
      const [names, orgs] = await Promise.all([
        resolveNames(page.lessons, tx),
        platformOrganizationRepository.searchOrganizations('', ORG_OPTIONS, tx),
      ]);
      // A filtered-on org that has aged out of the newest-N still needs a label.
      const missing =
        filters.organizationId && !orgs.some((o) => o.id === filters.organizationId)
          ? await platformOrganizationRepository.findOrganizationsByIds(
              [filters.organizationId],
              tx,
            )
          : [];
      const categories = cleanCategories([
        ...page.lessons.flatMap((l) => l.categories ?? []),
        ...(filters.category ? [filters.category] : []),
      ]).sort((a, b) => a.localeCompare(b));
      return {
        rows: page.lessons.map((l) => toPlatformLessonRowDTO(l, names)),
        nextCursor: page.nextCursor,
        retentionDays: page.retentionDays,
        organizations: [...orgs, ...missing]
          .map((o) => ({ id: o.id, name: o.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        categories,
      };
    });
  },

  /**
   * One lesson in full, with its newest occurrences and the staff changes made
   * to it.
   *
   * @throws PlatformLessonNotFoundError when motir-ai has no such lesson (the page 404s).
   * @throws MotirAiError when motir-ai cannot answer.
   */
  async get(principal: PlatformPrincipal, lessonId: string): Promise<PlatformLessonDetailDTO> {
    await requirePlatformStaff('support');
    const lesson = await getPlatformLesson(lessonId);
    const entry: PlatformAuditEntry = {
      action: 'estate.read',
      targetKind: 'platform',
      targetId: lesson.id,
      targetLabel: lesson.title,
      ...(lesson.tenant ? { organizationId: lesson.tenant.coreOrganizationId } : {}),
    };
    const { names, trail } = await withPlatformRead(principal, entry, async (tx) => ({
      names: await resolveNames([lesson], tx),
      trail: (
        await platformAuditLogRepository.listByTarget('platform', lesson.id, HISTORY_LIMIT, tx)
      ).filter(isLessonCurateRow),
    }));
    const users = await userRepository.findByIds([...new Set(trail.map((r) => r.actorUserId))]);
    return toPlatformLessonDetailDTO(
      lesson,
      names,
      trail.map((row) => toPlatformLessonHistoryEntryDTO(row, users)),
      {
        canEdit: platformRoleAtLeast(principal.role, 'operator'),
        canPromote: platformRoleAtLeast(principal.role, 'superadmin'),
      },
      lesson.retentionDays ?? 0,
    );
  },

  /**
   * Edit a lesson's title, why, how-to-apply or categories (`operator`).
   *
   * @throws NotPlatformStaffError below `operator`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlatformLessonInvalidError for a blanked field.
   * @throws PlatformLessonUnchangedError when nothing would move.
   * @throws PlatformLessonNotFoundError / MotirAiError from motir-ai.
   */
  async edit(
    principal: PlatformPrincipal,
    lessonId: string,
    input: PlatformLessonEditInput,
    reason: string,
  ): Promise<void> {
    await requirePlatformStaff('operator');
    assertReasonSatisfied({ action: 'ai.lesson.edit', targetKind: 'platform', reason });
    const current = await getPlatformLesson(lessonId);
    const { before, after, patch } = diffEdit(current, input);
    if (Object.keys(patch).length === 0) throw new PlatformLessonUnchangedError(lessonId);
    await auditedWrite(
      principal,
      {
        ...baseEntry('ai.lesson.edit', current, reason),
        metadata: { lessonId, before, after } as NonNullable<PlatformAuditEntry['metadata']>,
      },
      lessonId,
      () => editPlatformLesson(lessonId, patch, principal.userId),
    );
  },

  /**
   * Switch a lesson's injection on or off (`operator`).
   *
   * @throws NotPlatformStaffError below `operator`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlatformLessonUnchangedError when it is already there.
   * @throws PlatformLessonNotFoundError / MotirAiError from motir-ai.
   */
  async setEnabled(
    principal: PlatformPrincipal,
    lessonId: string,
    enabled: boolean,
    reason: string,
  ): Promise<void> {
    await requirePlatformStaff('operator');
    const action = enabled ? 'ai.lesson.enable' : 'ai.lesson.disable';
    assertReasonSatisfied({ action, targetKind: 'platform', reason });
    const current = await getPlatformLesson(lessonId);
    if (current.enabled === enabled) throw new PlatformLessonUnchangedError(lessonId);
    await auditedWrite(
      principal,
      {
        ...baseEntry(action, current, reason),
        metadata: { lessonId, before: { enabled: !enabled }, after: { enabled } },
      },
      lessonId,
      () => setPlatformLessonEnabled(lessonId, enabled, principal.userId),
    );
  },

  /**
   * Promote a lesson to the global corpus, or to global planning craft
   * (`superadmin` — it puts one customer's words in front of every planner).
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws PlatformLessonInvalidError for a target that is not one of the two.
   * @throws PlatformLessonUnchangedError when the lesson already holds that target.
   * @throws PlatformLessonNotFoundError / MotirAiError from motir-ai.
   */
  async promote(
    principal: PlatformPrincipal,
    lessonId: string,
    to: string,
    reason: string,
  ): Promise<void> {
    await requirePlatformStaff('superadmin');
    if (to !== 'global' && to !== 'planning_craft') {
      throw new PlatformLessonInvalidError(`"${to}" is not a promotion target`);
    }
    assertReasonSatisfied({ action: 'ai.lesson.promote', targetKind: 'platform', reason });
    const current = await getPlatformLesson(lessonId);
    const nextType = to === 'planning_craft' ? 'planning_craft' : current.mistakeType;
    if (current.scope === 'global' && current.mistakeType === nextType) {
      throw new PlatformLessonUnchangedError(lessonId);
    }
    await auditedWrite(
      principal,
      {
        ...baseEntry('ai.lesson.promote', current, reason),
        metadata: {
          lessonId,
          before: {
            scope: current.scope,
            mistakeType: current.mistakeType,
            ...(current.tenant ? { tenant: { ...current.tenant } } : {}),
          },
          after: { scope: 'global', mistakeType: nextType },
        },
      },
      lessonId,
      () => promotePlatformLesson(lessonId, to, principal.userId),
    );
  },
};
