// E2E boundary seam for motir-ai's PLATFORM planning-lessons console (Story
// MOTIR-1408 · MOTIR-1413): an undici intercept of `{MOTIR_AI_URL}/v1/admin/lessons…`
// and `/v1/admin/lesson-retention…`, installed by `instrumentation.ts` (through
// `lib/test-mock-seams.ts`) behind `E2E_TEST_PLATFORM_LESSONS=1` and dormant
// everywhere else. The same shape as `lib/test-planner-model-mock.ts`.
//
// The console's pages are SERVER rendered and every curate act is a Server
// Action, so `page.route` reaches none of it. State lives in a JSON fixture file
// (`MOTIR_AI_PLATFORM_LESSONS_FIXTURE_PATH`), re-read on every request and
// rewritten by a write: a spec seeds it, drives the page, and reads back what
// the write stored — the authoritative signal that the change reached motir-ai.
//
// ⚠️ A TRANSPORT MOCK. The real `motirAiClient`, the real staff gate and the real
// audit transaction all stay in the path. What is SIMULATED is motir-ai's own
// curate semantics, kept to the wire contract its `tests/lessonConsoleSeam.test.ts`
// pins: every write answers `{ lesson, audit }`, `audit: null` when nothing moved.

import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

export interface PlatformLessonsFixtureTenant {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
}

/** One lesson as the fixture stores it; the wire row is derived from it. */
export interface PlatformLessonsFixtureLesson {
  id: string;
  title: string;
  mistakeType: string;
  why: string;
  howToApply: string;
  body: string;
  categories: string[];
  enabled: boolean;
  recurrenceCount: number;
  lastOccurredAt: string;
  createdAt: string;
  sourceRef: string | null;
  /** Null is a global lesson. */
  tenant: PlatformLessonsFixtureTenant | null;
}

export interface PlatformLessonsFixture {
  lessons: PlatformLessonsFixtureLesson[];
  retention?: { days: number | null; updatedAt: string | null; updatedByCoreUserId: string | null };
}

const DEFAULT_DAYS = 90;
const json = { headers: { 'content-type': 'application/json' } };
const problemJson = { headers: { 'content-type': 'application/problem+json' } };

type Reply = { statusCode: number; data: object; responseOptions: typeof json };

function fixturePath(): string | undefined {
  return process.env['MOTIR_AI_PLATFORM_LESSONS_FIXTURE_PATH'];
}

function readFixture(): PlatformLessonsFixture {
  const p = fixturePath();
  if (!p) return { lessons: [] };
  try {
    return JSON.parse(readFixtureFileSync(p)) as PlatformLessonsFixture;
  } catch {
    // An absent fixture reads as an empty corpus — the page's empty state, not a 500.
    return { lessons: [] };
  }
}

function writeFixture(fixture: PlatformLessonsFixture): void {
  const p = fixturePath();
  if (p) writeFixtureFileSync(p, JSON.stringify(fixture, null, 2));
}

function windowDays(fixture: PlatformLessonsFixture): number {
  return fixture.retention?.days ?? DEFAULT_DAYS;
}

function toWire(lesson: PlatformLessonsFixtureLesson, days: number) {
  const stale = Date.now() - new Date(lesson.lastOccurredAt).getTime() > days * 86_400_000;
  const injectionBlock = !lesson.enabled ? 'disabled' : stale ? 'not_recurred' : null;
  return {
    id: lesson.id,
    scope: lesson.tenant ? 'tenant' : 'global',
    aiProjectId: lesson.tenant ? `aip_${lesson.tenant.coreProjectId}` : null,
    mistakeType: lesson.mistakeType,
    title: lesson.title,
    body: lesson.body,
    why: lesson.why,
    howToApply: lesson.howToApply,
    categories: lesson.categories,
    sourceRef: lesson.sourceRef,
    enabled: lesson.enabled,
    createdAt: lesson.createdAt,
    updatedAt: lesson.createdAt,
    lastOccurredAt: lesson.lastOccurredAt,
    recurrenceCount: lesson.recurrenceCount,
    injected: injectionBlock === null,
    injectionBlock,
    retentionDays: days,
    tenant: lesson.tenant,
  };
}

function toDetail(lesson: PlatformLessonsFixtureLesson, days: number) {
  return {
    ...toWire(lesson, days),
    occurrences: [
      { at: lesson.lastOccurredAt, source: 'capture', occurrenceRef: lesson.sourceRef },
    ],
  };
}

function retentionWire(fixture: PlatformLessonsFixture) {
  const r = fixture.retention;
  return {
    days: windowDays(fixture),
    defaultDays: DEFAULT_DAYS,
    isSet: r?.days != null,
    updatedAt: r?.updatedAt ?? null,
    updatedByCoreUserId: r?.updatedByCoreUserId ?? null,
    minDays: 7,
    maxDays: 365,
  };
}

function problem(status: number, code: string, detail: string): Reply {
  return {
    statusCode: status,
    data: { type: 'about:blank', code, title: code, status, detail },
    responseOptions: problemJson,
  };
}

function ok(data: object): Reply {
  return { statusCode: 200, data, responseOptions: json };
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const pathOf = (p: string) => p.split('?')[0]!;
const LESSON_PATH = /^\/v1\/admin\/lessons\/([^/]+)(\/enabled|\/promote)?$/;

/** Apply one curate act to the fixture; `null` audit when nothing moved. */
function curate(
  fixture: PlatformLessonsFixture,
  lesson: PlatformLessonsFixtureLesson,
  op: 'edit' | 'enabled' | 'promote',
  body: Record<string, unknown>,
): Reply {
  const actorCoreUserId = body['actorCoreUserId'];
  if (typeof actorCoreUserId !== 'string' || !actorCoreUserId) {
    return problem(400, 'validation_error', 'actorCoreUserId is required');
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let action: string;
  if (op === 'edit') {
    action = 'ai.lesson.edit';
    for (const field of ['title', 'why', 'howToApply', 'categories'] as const) {
      if (!(field in body)) continue;
      const next = body[field];
      if (JSON.stringify(next) !== JSON.stringify(lesson[field])) {
        before[field] = lesson[field];
        after[field] = next;
        (lesson as unknown as Record<string, unknown>)[field] = next;
      }
    }
  } else if (op === 'enabled') {
    const enabled = body['enabled'];
    if (typeof enabled !== 'boolean')
      return problem(400, 'validation_error', 'enabled must be a boolean');
    action = enabled ? 'ai.lesson.enable' : 'ai.lesson.disable';
    if (enabled !== lesson.enabled) {
      before['enabled'] = lesson.enabled;
      after['enabled'] = enabled;
      lesson.enabled = enabled;
    }
  } else {
    const to = body['to'];
    if (to !== 'global' && to !== 'planning_craft') {
      return problem(400, 'validation_error', "'to' must be one of: global, planning_craft");
    }
    action = 'ai.lesson.promote';
    const nextType = to === 'planning_craft' ? 'planning_craft' : lesson.mistakeType;
    if (lesson.tenant !== null || nextType !== lesson.mistakeType) {
      Object.assign(before, {
        scope: lesson.tenant ? 'tenant' : 'global',
        mistakeType: lesson.mistakeType,
        tenant: lesson.tenant,
      });
      Object.assign(after, { scope: 'global', mistakeType: nextType, tenant: null });
      lesson.tenant = null;
      lesson.mistakeType = nextType;
    }
  }
  const moved = Object.keys(after).length > 0;
  if (moved) writeFixture(fixture);
  return ok({
    lesson: toWire(lesson, windowDays(fixture)),
    audit: moved
      ? {
          action,
          lessonId: lesson.id,
          actorCoreUserId,
          at: new Date().toISOString(),
          before,
          after,
        }
      : null,
  });
}

export function installPlatformLessonsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // GET /v1/admin/lessons — the cross-tenant list, with the console's filters.
  pool
    .intercept({ path: (p: string) => pathOf(p) === '/v1/admin/lessons', method: 'GET' })
    .reply<object>((req) => {
      const fixture = readFixture();
      const q = new URL(String(req.path), 'http://x').searchParams;
      const days = windowDays(fixture);
      const text = q.get('q')?.toLowerCase();
      const rows = fixture.lessons.filter((l) => {
        if (q.get('scope') && (l.tenant ? 'tenant' : 'global') !== q.get('scope')) return false;
        if (q.get('mistakeType') && l.mistakeType !== q.get('mistakeType')) return false;
        if (q.get('category') && !l.categories.includes(q.get('category')!)) return false;
        if (q.get('enabled') && String(l.enabled) !== q.get('enabled')) return false;
        const org = q.get('coreOrganizationId');
        if (org && l.tenant?.coreOrganizationId !== org) return false;
        if (text && !`${l.title} ${l.why} ${l.howToApply}`.toLowerCase().includes(text))
          return false;
        return true;
      });
      return ok({
        lessons: rows.map((l) => toWire(l, days)),
        nextCursor: null,
        retentionDays: days,
      });
    })
    .persist();

  // GET · PATCH /v1/admin/lessons/:id, PUT …/enabled, POST …/promote.
  for (const method of ['GET', 'PATCH', 'PUT', 'POST'] as const) {
    pool
      .intercept({ path: (p: string) => LESSON_PATH.test(pathOf(p)), method })
      .reply<object>((req) => {
        const [, id, suffix] = pathOf(String(req.path)).match(LESSON_PATH)!;
        const fixture = readFixture();
        const lesson = fixture.lessons.find((l) => l.id === decodeURIComponent(id!));
        if (!lesson) return problem(404, 'not_found', `no lesson ${id}`);
        if (method === 'GET' && !suffix) return ok(toDetail(lesson, windowDays(fixture)));
        const body = parseBody(req.body);
        if (!body) return problem(400, 'validation_error', 'body is not JSON');
        if (method === 'PATCH' && !suffix) return curate(fixture, lesson, 'edit', body);
        if (method === 'PUT' && suffix === '/enabled')
          return curate(fixture, lesson, 'enabled', body);
        if (method === 'POST' && suffix === '/promote')
          return curate(fixture, lesson, 'promote', body);
        return problem(404, 'not_found', `no route ${method} ${req.path}`);
      })
      .persist();
  }

  // GET /v1/admin/lesson-retention/impact?days=N
  pool
    .intercept({
      path: (p: string) => pathOf(p) === '/v1/admin/lesson-retention/impact',
      method: 'GET',
    })
    .reply<object>((req) => {
      const days = Number(new URL(String(req.path), 'http://x').searchParams.get('days'));
      const fixture = readFixture();
      const cutoff = Date.now() - days * 86_400_000;
      const wouldRest = fixture.lessons.filter(
        (l) =>
          l.enabled &&
          toWire(l, windowDays(fixture)).injected &&
          new Date(l.lastOccurredAt).getTime() < cutoff,
      ).length;
      return ok({ days, wouldRest });
    })
    .persist();

  // GET · PUT /v1/admin/lesson-retention
  for (const method of ['GET', 'PUT'] as const) {
    pool
      .intercept({ path: (p: string) => pathOf(p) === '/v1/admin/lesson-retention', method })
      .reply<object>((req) => {
        const fixture = readFixture();
        if (method === 'GET') return ok(retentionWire(fixture));
        const body = parseBody(req.body);
        const days = body?.['days'];
        const actor = body?.['actorCoreUserId'];
        if (typeof days !== 'number' || !Number.isInteger(days) || days < 7 || days > 365) {
          return problem(400, 'validation_error', 'days must be a whole number from 7 to 365');
        }
        if (typeof actor !== 'string' || !actor) {
          return problem(400, 'validation_error', 'actorCoreUserId is required');
        }
        const before = windowDays(fixture);
        if (before === days) return ok({ setting: retentionWire(fixture), audit: null });
        const at = new Date().toISOString();
        fixture.retention = { days, updatedAt: at, updatedByCoreUserId: actor };
        writeFixture(fixture);
        return ok({
          setting: retentionWire(fixture),
          audit: {
            action: 'ai.lesson.retention_set',
            actorCoreUserId: actor,
            at,
            before: { days: before },
            after: { days },
          },
        });
      })
      .persist();
  }
}
