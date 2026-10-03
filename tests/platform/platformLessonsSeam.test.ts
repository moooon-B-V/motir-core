import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformLessonsService } from '@/lib/services/platformLessonsService';
import {
  DETAIL,
  EDIT,
  IMPACT,
  LESSON,
  LIST,
  PLATFORM_LESSON_WIRE_KEYS as WIRE,
  RETENTION,
  RETENTION_WRITE,
  withIds,
} from '../fixtures/motirAiContract/platformLessons';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The planning-lessons console's INTEGRATION SEAM, motir-core side (Story
 * MOTIR-1408 · MOTIR-1412) — the key-drift guard between motir-ai's writer and
 * this consumer.
 *
 * motir-ai is faked at `fetch` with bodies RECORDED from its real routes
 * (`tests/fixtures/motirAiContract/platformLessons.ts`), and each is driven
 * through the real client, service and mappers into the DTO the page renders,
 * over real Postgres for the tenant names and the audit trail. motir-ai's
 * `tests/lessonConsoleSeam.test.ts` pins the same keys present on its real
 * routes, so a rename on either side fails one of the two.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;
let ids: { org: string; ws: string; project: string; staff: string };
let retentionSet = false;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchStub = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const method = init.method ?? 'GET';
  const path = url.pathname;
  if (path === '/v1/admin/lessons') return json(withIds(LIST, ids));
  if (path === `/v1/admin/lessons/${LESSON}` && method === 'GET') return json(withIds(DETAIL, ids));
  if (path === `/v1/admin/lessons/${LESSON}` && method === 'PATCH') return json(withIds(EDIT, ids));
  if (path === '/v1/admin/lesson-retention/impact') return json(withIds(IMPACT, ids));
  if (path === '/v1/admin/lesson-retention' && method === 'GET') {
    return json(withIds(retentionSet ? RETENTION_WRITE.setting : RETENTION, ids));
  }
  if (path === '/v1/admin/lesson-retention' && method === 'PUT') {
    retentionSet = true;
    return json(withIds(RETENTION_WRITE, ids));
  }
  throw new Error(`unrecorded motir-ai call: ${method} ${path}`);
});

/** Every leaf of a DTO is defined — a key the consumer reads and the wire lacks shows as `undefined`. */
function undefinedPaths(value: unknown, at = '$'): string[] {
  if (value === undefined) return [at];
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${at}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => undefinedPaths(v, `${at}.${k}`));
  }
  return [];
}

const keysOf = (o: unknown) => Object.keys(o as Record<string, unknown>);

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  retentionSet = false;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme Space' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Rocket',
  });
  const staff = await createTestUser({ email: 'ops+seam@moooon.net', name: 'Ops Seam' });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });
  currentPrincipal = { userId: staff.id, email: staff.email, role: 'superadmin' };
  ids = { org: workspace.organizationId, ws: workspace.id, project: project.id, staff: staff.id };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the recording covers every key the consumer reads', () => {
  it('list, detail, write, retention and impact', () => {
    const row = LIST.lessons[0]!;
    expect(keysOf(LIST)).toEqual(expect.arrayContaining([...WIRE.listPage]));
    expect(keysOf(row)).toEqual(expect.arrayContaining([...WIRE.listRow]));
    expect(keysOf(row.tenant)).toEqual(expect.arrayContaining([...WIRE.tenant]));
    expect(keysOf(DETAIL)).toEqual(expect.arrayContaining([...WIRE.listRow, ...WIRE.detailExtra]));
    expect(keysOf(DETAIL.occurrences[0])).toEqual(expect.arrayContaining([...WIRE.occurrence]));
    expect(keysOf(EDIT)).toEqual(expect.arrayContaining([...WIRE.write]));
    expect(keysOf(EDIT.audit)).toEqual(expect.arrayContaining([...WIRE.audit]));
    expect(keysOf(RETENTION)).toEqual(expect.arrayContaining([...WIRE.retention]));
    expect(keysOf(RETENTION_WRITE)).toEqual(expect.arrayContaining([...WIRE.retentionWrite]));
    expect(keysOf(RETENTION_WRITE.audit)).toEqual(expect.arrayContaining([...WIRE.retentionAudit]));
    expect(keysOf(IMPACT)).toEqual(expect.arrayContaining([...WIRE.impact]));
  });
});

describe('recorded bodies → the DTOs the page renders', () => {
  it('the list: the row named down to its project, the window unset', async () => {
    const list = await platformLessonsService.list(currentPrincipal!, {});
    expect(undefinedPaths(list)).toEqual([]);
    expect(list.rows).toEqual([
      expect.objectContaining({
        id: LESSON,
        title: 'Split stories by user value',
        scope: 'tenant',
        injection: 'injected',
        recurrenceCount: 2,
        owner: {
          organizationId: ids.org,
          organizationName: expect.any(String),
          workspaceName: 'Acme Space',
          projectName: 'Rocket',
        },
      }),
    ]);
    expect(list.retention).toMatchObject({ days: 90, isSet: false, canChange: true });
  });

  it('the detail: provenance, the occurrence ledger and an empty history', async () => {
    const detail = await platformLessonsService.get(currentPrincipal!, LESSON);
    expect(undefinedPaths(detail)).toEqual([]);
    expect(detail).toMatchObject({
      body: 'The plan split by layer.',
      sourceRef: 'MOTIR-1',
      retentionDays: 90,
      occurrences: [{ source: 'capture', occurrenceRef: expect.any(String) }],
      history: [],
      canEdit: true,
      promoteTargets: ['global', 'planning_craft'],
    });
  });

  it('an edit reads back as one history entry, from → to', async () => {
    await platformLessonsService.edit(
      currentPrincipal!,
      LESSON,
      { title: 'Slice stories by user value' },
      'Clearer title',
    );
    const detail = await platformLessonsService.get(currentPrincipal!, LESSON);
    expect(detail.history).toEqual([
      expect.objectContaining({
        action: 'edit',
        actorName: 'Ops Seam',
        reason: 'Clearer title',
        changes: [
          {
            field: 'title',
            before: 'Split stories by user value',
            after: 'Slice stories by user value',
          },
        ],
      }),
    ]);
  });

  it('the window: impact, then a change that reads back with its setter', async () => {
    await expect(platformLessonsService.previewRetention(currentPrincipal!, 30)).resolves.toBe(
      IMPACT.wouldRest,
    );
    await platformLessonsService.setRetention(currentPrincipal!, 30, 'Faster cadence');
    const list = await platformLessonsService.list(currentPrincipal!, {});
    expect(list.retention).toMatchObject({ days: 30, isSet: true, updatedByName: 'Ops Seam' });
    const row = await adminDb.platformAuditLog.findFirst({
      where: { action: 'ai.lesson.retention_set' },
    });
    expect(row?.metadata).toEqual({ before: { days: 90 }, after: { days: 30 } });
  });
});
