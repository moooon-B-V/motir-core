import type { PlatformAuditLog, User } from '@/generated/prisma/client';
import type { RawPlatformLesson, RawPlatformLessonDetail } from '@/lib/ai/motirAiClient';
import type {
  PlatformLessonChangeDTO,
  PlatformLessonDetailDTO,
  PlatformLessonHistoryEntryDTO,
  PlatformLessonInjectionState,
  PlatformLessonOwnerDTO,
  PlatformLessonRowDTO,
} from '@/lib/dto/platformLessons';

/** Core names for the ids motir-ai's rows carry, keyed `<kind>:<id>`. */
export type TenantNameMap = Map<string, string>;

export function tenantNameKey(kind: 'organization' | 'workspace' | 'project', id: string) {
  return `${kind}:${id}`;
}

function injectionState(lesson: RawPlatformLesson): PlatformLessonInjectionState {
  if (lesson.injected) return 'injected';
  // `disabled` wins over `not_recurred` upstream; anything else not-injected is
  // the window's doing.
  return lesson.injectionBlock === 'disabled' || !lesson.enabled ? 'off' : 'resting';
}

function toOwner(lesson: RawPlatformLesson, names: TenantNameMap): PlatformLessonOwnerDTO | null {
  if (!lesson.tenant) return null;
  const { coreOrganizationId, coreWorkspaceId, coreProjectId } = lesson.tenant;
  return {
    organizationId: coreOrganizationId,
    organizationName: names.get(tenantNameKey('organization', coreOrganizationId)) ?? null,
    workspaceName: names.get(tenantNameKey('workspace', coreWorkspaceId)) ?? null,
    projectName: names.get(tenantNameKey('project', coreProjectId)) ?? null,
  };
}

export function toPlatformLessonRowDTO(
  lesson: RawPlatformLesson,
  names: TenantNameMap,
): PlatformLessonRowDTO {
  return {
    id: lesson.id,
    title: lesson.title,
    mistakeType: lesson.mistakeType,
    categories: lesson.categories ?? [],
    scope: lesson.scope === 'global' ? 'global' : 'tenant',
    enabled: lesson.enabled,
    injection: injectionState(lesson),
    recurrenceCount: lesson.recurrenceCount ?? 0,
    lastOccurredAt: lesson.lastOccurredAt,
    createdAt: lesson.createdAt,
    owner: toOwner(lesson, names),
  };
}

const HISTORY_ACTIONS = {
  'ai.lesson.edit': 'edit',
  'ai.lesson.enable': 'enable',
  'ai.lesson.disable': 'disable',
  'ai.lesson.promote': 'promote',
} as const;

/** Whether an audit row is one of the four lesson curate acts. */
export function isLessonCurateRow(row: { action: string }): boolean {
  return row.action in HISTORY_ACTIONS;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The `{ before, after }` the row's metadata carries, as one entry per moved field. */
function toChanges(metadata: unknown): PlatformLessonChangeDTO[] {
  const meta = asRecord(metadata);
  const before = asRecord(meta['before']);
  const after = asRecord(meta['after']);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({ field, before: before[field], after: after[field] }));
}

export function toPlatformLessonHistoryEntryDTO(
  row: PlatformAuditLog,
  users: Pick<User, 'id' | 'name'>[],
): PlatformLessonHistoryEntryDTO {
  return {
    id: row.id,
    action: HISTORY_ACTIONS[row.action as keyof typeof HISTORY_ACTIONS],
    actorName: users.find((u) => u.id === row.actorUserId)?.name ?? null,
    at: row.createdAt.toISOString(),
    reason: row.reason,
    changes: toChanges(row.metadata),
  };
}

export function toPlatformLessonDetailDTO(
  lesson: RawPlatformLessonDetail,
  names: TenantNameMap,
  history: PlatformLessonHistoryEntryDTO[],
  access: { canEdit: boolean; canPromote: boolean },
  retentionDays: number,
): PlatformLessonDetailDTO {
  const row = toPlatformLessonRowDTO(lesson, names);
  const promoteTargets: ('global' | 'planning_craft')[] = !access.canPromote
    ? []
    : row.scope === 'tenant'
      ? ['global', 'planning_craft']
      : row.mistakeType === 'planning_craft'
        ? []
        : ['planning_craft'];
  return {
    ...row,
    body: lesson.body,
    why: lesson.why,
    howToApply: lesson.howToApply,
    sourceRef: lesson.sourceRef,
    retentionDays,
    occurrences: lesson.occurrences.map((o) => ({
      at: o.at,
      source: o.source,
      occurrenceRef: o.occurrenceRef,
    })),
    history,
    canEdit: access.canEdit,
    promoteTargets,
  };
}
