import type {
  RawLessonRetention,
  RawLessonRetentionWrite,
  RawPlatformLessonDetail,
  RawPlatformLessonPage,
  RawPlatformLessonWrite,
} from '@/lib/ai/motirAiClient';

/**
 * motir-ai's planning-lessons console routes AS RECORDED (Story MOTIR-1408 ·
 * MOTIR-1412) — the bodies of `GET /v1/admin/lessons`, `GET /v1/admin/lessons/:id`,
 * `PATCH /v1/admin/lessons/:id`, `GET /v1/admin/lesson-retention`,
 * `GET /v1/admin/lesson-retention/impact` and `PUT /v1/admin/lesson-retention`,
 * captured from motir-ai's REAL Hono app on 2026-10-03 (motir-ai
 * `tests/lessonConsoleSeam.test.ts`'s fixture) and ids replaced with placeholders.
 *
 * TYPED with motir-core's own `Raw*` client types on purpose: a field motir-core
 * stops declaring, or declares differently, fails the typecheck here. The keys
 * motir-ai sends that the console does not read ride a SPREAD
 * (`UNREAD_ON_A_LESSON`), which TypeScript does not excess-check — so the
 * recording stays whole without the client having to declare them.
 */

export const ORG = '__ORG__';
export const WS = '__WS__';
export const PROJECT = '__PROJECT__';
export const LESSON = 'lsn_recorded';
export const STAFF = '__STAFF__';

/**
 * The keys motir-core READS from each body — mirrored VERBATIM by motir-ai's
 * `tests/lessonConsoleSeam.test.ts` `WIRE`, which pins them present on the real
 * routes. The two lists change together or not at all.
 */
export const PLATFORM_LESSON_WIRE_KEYS = {
  listPage: ['lessons', 'nextCursor', 'retentionDays'],
  listRow: [
    'aiProjectId',
    'body',
    'categories',
    'createdAt',
    'enabled',
    'howToApply',
    'id',
    'injected',
    'injectionBlock',
    'lastOccurredAt',
    'mistakeType',
    'recurrenceCount',
    'retentionDays',
    'scope',
    'sourceRef',
    'tenant',
    'title',
    'updatedAt',
    'why',
  ],
  tenant: ['coreOrganizationId', 'coreProjectId', 'coreWorkspaceId'],
  detailExtra: ['occurrences'],
  occurrence: ['at', 'occurrenceRef', 'source'],
  write: ['audit', 'lesson'],
  audit: ['action', 'actorCoreUserId', 'after', 'at', 'before', 'lessonId'],
  retention: [
    'days',
    'defaultDays',
    'isSet',
    'maxDays',
    'minDays',
    'updatedAt',
    'updatedByCoreUserId',
  ],
  retentionWrite: ['audit', 'setting'],
  retentionAudit: ['action', 'actorCoreUserId', 'after', 'at', 'before'],
  impact: ['days', 'wouldRest'],
} as const;

/** What motir-ai also sends on every lesson, and the console does not read. */
const UNREAD_ON_A_LESSON = {
  kinds: [],
  types: [],
  phases: [],
  subject: null,
  bugWorkItemKey: null,
  humanOverride: null,
  humanOverrideAt: null,
  humanOverrideBy: null,
};

export const LIST: RawPlatformLessonPage = {
  lessons: [
    {
      ...UNREAD_ON_A_LESSON,
      id: LESSON,
      scope: 'tenant',
      aiProjectId: 'aip_recorded',
      mistakeType: 'regular_planning',
      title: 'Split stories by user value',
      body: 'The plan split by layer.',
      why: 'Layers ship nothing alone.',
      howToApply: 'Slice vertically.',
      categories: ['decomposition'],
      sourceRef: 'MOTIR-1',
      enabled: true,
      createdAt: '2026-10-03T00:23:19.529Z',
      updatedAt: '2026-10-03T00:23:19.540Z',
      lastOccurredAt: '2026-09-02T00:00:00.000Z',
      recurrenceCount: 2,
      injected: true,
      injectionBlock: null,
      retentionDays: 90,
      tenant: {
        coreOrganizationId: ORG,
        coreWorkspaceId: WS,
        coreProjectId: PROJECT,
      },
    },
  ],
  nextCursor: null,
  retentionDays: 90,
};

export const DETAIL: RawPlatformLessonDetail = {
  ...UNREAD_ON_A_LESSON,
  id: LESSON,
  scope: 'tenant',
  aiProjectId: 'aip_recorded',
  mistakeType: 'regular_planning',
  title: 'Split stories by user value',
  body: 'The plan split by layer.',
  why: 'Layers ship nothing alone.',
  howToApply: 'Slice vertically.',
  categories: ['decomposition'],
  sourceRef: 'MOTIR-1',
  enabled: true,
  createdAt: '2026-10-03T00:23:19.529Z',
  updatedAt: '2026-10-03T00:23:19.540Z',
  lastOccurredAt: '2026-09-02T00:00:00.000Z',
  recurrenceCount: 2,
  injected: true,
  injectionBlock: null,
  retentionDays: 90,
  tenant: {
    coreOrganizationId: ORG,
    coreWorkspaceId: WS,
    coreProjectId: PROJECT,
  },
  occurrences: [
    {
      at: '2026-09-02T00:00:00.000Z',
      source: 'capture',
      occurrenceRef: 'MOTIR-2',
    },
  ],
};

export const EDIT: RawPlatformLessonWrite = {
  lesson: {
    ...UNREAD_ON_A_LESSON,
    id: LESSON,
    scope: 'tenant',
    aiProjectId: 'aip_recorded',
    mistakeType: 'regular_planning',
    title: 'Slice stories by user value',
    body: 'The plan split by layer.',
    why: 'Layers ship nothing alone.',
    howToApply: 'Slice vertically.',
    categories: ['decomposition'],
    sourceRef: 'MOTIR-1',
    enabled: true,
    createdAt: '2026-10-03T00:23:19.529Z',
    updatedAt: '2026-10-03T00:23:19.583Z',
    lastOccurredAt: '2026-09-02T00:00:00.000Z',
    recurrenceCount: 2,
    injected: true,
    injectionBlock: null,
    retentionDays: 90,
    tenant: {
      coreOrganizationId: ORG,
      coreWorkspaceId: WS,
      coreProjectId: PROJECT,
    },
  },
  audit: {
    action: 'ai.lesson.edit',
    lessonId: LESSON,
    actorCoreUserId: STAFF,
    at: '2026-10-03T00:23:19.588Z',
    before: {
      title: 'Split stories by user value',
    },
    after: {
      title: 'Slice stories by user value',
    },
  },
};

export const RETENTION: RawLessonRetention = {
  days: 90,
  defaultDays: 90,
  isSet: false,
  updatedAt: null,
  updatedByCoreUserId: null,
  minDays: 7,
  maxDays: 365,
};

export const IMPACT: { days: number; wouldRest: number } = {
  days: 30,
  wouldRest: 1,
};

export const RETENTION_WRITE: RawLessonRetentionWrite = {
  setting: {
    days: 30,
    defaultDays: 90,
    isSet: true,
    updatedAt: '2026-10-03T00:23:19.610Z',
    updatedByCoreUserId: STAFF,
    minDays: 7,
    maxDays: 365,
  },
  audit: {
    action: 'ai.lesson.retention_set',
    actorCoreUserId: STAFF,
    at: '2026-10-03T00:23:19.611Z',
    before: {
      days: 90,
    },
    after: {
      days: 30,
    },
  },
};

/** A recorded body with the placeholders rewritten onto a test's own rows. */
export function withIds<T>(
  body: T,
  ids: { org: string; ws: string; project: string; staff: string },
): T {
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(ORG, ids.org)
      .replaceAll(WS, ids.ws)
      .replaceAll(PROJECT, ids.project)
      .replaceAll(STAFF, ids.staff),
  ) as T;
}
