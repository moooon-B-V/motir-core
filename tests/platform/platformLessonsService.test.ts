import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlatformLessonInvalidError,
  PlatformLessonUnchangedError,
} from '@/lib/platform/errors';
import { MotirAiUnavailableError, PlatformLessonNotFoundError } from '@/lib/ai/errors';
import type { RawPlatformLessonDetail } from '@/lib/ai/motirAiClient';
import { platformLessonsService } from '@/lib/services/platformLessonsService';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The console's planning-lessons SEAM (Story MOTIR-1408 · MOTIR-1411).
 *
 * Real Postgres for the audit trail and the tenant names, which are the
 * properties under test: every refusal is checked against the ROW COUNT, not
 * just the thrown type, because the way to break "a refused write leaves no
 * row" is to throw outside the transaction. motir-ai is stubbed at the HTTP
 * boundary — its own suite (`lessonPlatformConsole.test.ts`) owns the lessons.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The DEGREE is honoured, so a role refusal below is the service's own
    // `requirePlatformStaff(minimum)` and not the mock waving it through.
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

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+lessons-${role}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

let tenant: { coreOrganizationId: string; coreWorkspaceId: string; coreProjectId: string };

function lesson(over: Partial<RawPlatformLessonDetail> = {}): RawPlatformLessonDetail {
  return {
    id: 'lsn_1',
    scope: 'tenant',
    aiProjectId: 'aip_1',
    mistakeType: 'regular_planning',
    title: 'Split stories by user value',
    body: 'The plan split by layer.',
    why: 'Layers ship nothing alone.',
    howToApply: 'Slice vertically.',
    categories: ['decomposition'],
    sourceRef: 'MOTIR-1',
    enabled: true,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    lastOccurredAt: '2026-09-30T09:00:00.000Z',
    recurrenceCount: 3,
    injected: true,
    injectionBlock: null,
    retentionDays: 90,
    tenant,
    occurrences: [{ at: '2026-09-30T09:00:00.000Z', source: 'planner', occurrenceRef: 'job_9' }],
    ...over,
  };
}

/** What the stub serves; `null` is a 404 `not_found`. */
let stored: RawPlatformLessonDetail | null = null;
/** How the stub answers a write. */
let writeAnswer: 'apply' | 'noop' | 'unavailable' = 'apply';
let writes: { method: string; path: string; body: unknown }[] = [];
let listQueries: URLSearchParams[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** The stored retirement window; `null` days is the unset default. */
let retention: { days: number | null; updatedAt: string | null; by: string | null } = {
  days: null,
  updatedAt: null,
  by: null,
};

function retentionBody() {
  return {
    days: retention.days ?? 90,
    defaultDays: 90,
    isSet: retention.days !== null,
    updatedAt: retention.updatedAt,
    updatedByCoreUserId: retention.by,
    minDays: 7,
    maxDays: 365,
  };
}

const fetchStub = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const method = init.method ?? 'GET';
  if (url.pathname === '/v1/admin/lesson-retention/impact') {
    return json({ days: Number(url.searchParams.get('days')), wouldRest: 4 });
  }
  if (url.pathname === '/v1/admin/lesson-retention') {
    if (method === 'GET') return json(retentionBody());
    const body = JSON.parse(String(init.body)) as { days: number; actorCoreUserId: string };
    writes.push({ method, path: url.pathname, body });
    if (writeAnswer === 'unavailable') {
      return json(
        { type: 'about:blank', title: 'down', status: 503, code: 'upstream_unavailable' },
        503,
      );
    }
    const before = retentionBody().days;
    if (writeAnswer === 'noop') return json({ setting: retentionBody(), audit: null });
    retention = {
      days: body.days,
      updatedAt: '2026-10-03T10:00:00.000Z',
      by: body.actorCoreUserId,
    };
    return json({
      setting: retentionBody(),
      audit: {
        action: 'ai.lesson.retention_set',
        actorCoreUserId: body.actorCoreUserId,
        at: '2026-10-03T10:00:00.000Z',
        before: { days: before },
        after: { days: body.days },
      },
    });
  }
  if (method === 'GET' && url.pathname === '/v1/admin/lessons') {
    listQueries.push(url.searchParams);
    const { occurrences: _o, ...row } = stored ?? lesson();
    return json({ lessons: stored ? [row] : [], nextCursor: null, retentionDays: 90 });
  }
  if (!stored) {
    return json({ type: 'about:blank', title: 'Not found', status: 404, code: 'not_found' }, 404);
  }
  if (method === 'GET') return json(stored);
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  writes.push({ method, path: url.pathname, body });
  if (writeAnswer === 'unavailable') {
    return json(
      { type: 'about:blank', title: 'down', status: 503, code: 'upstream_unavailable' },
      503,
    );
  }
  const { occurrences: _o, ...row } = stored;
  return json({
    lesson: row,
    audit:
      writeAnswer === 'noop'
        ? null
        : {
            action: 'ai.lesson.edit',
            lessonId: stored.id,
            actorCoreUserId: body['actorCoreUserId'],
            at: '2026-10-02T10:00:00.000Z',
            before: {},
            after: {},
          },
  });
});

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  writes = [];
  listQueries = [];
  writeAnswer = 'apply';
  retention = { days: null, updatedAt: null, by: null };
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme Space' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Rocket',
  });
  tenant = {
    coreOrganizationId: workspace.organizationId,
    coreWorkspaceId: workspace.id,
    coreProjectId: project.id,
  };
  stored = lesson();
  currentPrincipal = await seedStaff('superadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('list — any staff role reads, and the read is audited', () => {
  it('resolves the tenant names, forwards the filters and writes one estate.read row', async () => {
    currentPrincipal = await seedStaff('support');
    const dto = await platformLessonsService.list(currentPrincipal, {
      scope: 'tenant',
      enabled: false,
      organizationId: tenant.coreOrganizationId,
      q: 'split',
    });
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]!.owner).toMatchObject({
      organizationId: tenant.coreOrganizationId,
      workspaceName: 'Acme Space',
      projectName: 'Rocket',
    });
    expect(dto.rows[0]!.injection).toBe('injected');
    expect(dto.retentionDays).toBe(90);
    expect(dto.organizations.some((o) => o.id === tenant.coreOrganizationId)).toBe(true);
    expect(dto.categories).toEqual(['decomposition']);
    const q = listQueries[0]!;
    expect(q.get('scope')).toBe('tenant');
    expect(q.get('enabled')).toBe('false');
    expect(q.get('coreOrganizationId')).toBe(tenant.coreOrganizationId);
    expect(q.get('q')).toBe('split');
    expect(q.get('limit')).toBe('50');
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.targetKind])).toEqual([['estate.read', 'platform']]);
  });

  it('a global lesson has no owner; disabled reads as Off and not_recurred as Resting', async () => {
    stored = lesson({
      tenant: null,
      scope: 'global',
      injected: false,
      injectionBlock: 'disabled',
      enabled: false,
    });
    expect((await platformLessonsService.list(currentPrincipal!, {})).rows[0]).toMatchObject({
      owner: null,
      scope: 'global',
      injection: 'off',
    });
    stored = lesson({ injected: false, injectionBlock: 'not_recurred' });
    expect((await platformLessonsService.list(currentPrincipal!, {})).rows[0]!.injection).toBe(
      'resting',
    );
  });

  it('a non-staff caller is refused before motir-ai is asked, and leaves no row', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(platformLessonsService.list(principal, {})).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('get — the detail', () => {
  it('a missing lesson is PlatformLessonNotFoundError and leaves no row', async () => {
    stored = null;
    await expect(platformLessonsService.get(currentPrincipal!, 'nope')).rejects.toBeInstanceOf(
      PlatformLessonNotFoundError,
    );
    expect(await auditRows()).toHaveLength(0);
  });

  it('writes an estate.read on the lesson, and lists only the curate rows as history', async () => {
    await platformLessonsService.setEnabled(currentPrincipal!, 'lsn_1', false, 'noisy');
    const dto = await platformLessonsService.get(currentPrincipal!, 'lsn_1');
    expect(dto.history).toHaveLength(1);
    expect(dto.history[0]).toMatchObject({
      action: 'disable',
      actorName: 'Ops superadmin',
      reason: 'noisy',
      changes: [{ field: 'enabled', before: true, after: false }],
    });
    expect(dto.occurrences).toHaveLength(1);
    expect(dto.canEdit).toBe(true);
    expect(dto.promoteTargets).toEqual(['global', 'planning_craft']);
    const read = (await auditRows()).at(-1)!;
    expect(read).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetId: 'lsn_1',
      organizationId: tenant.coreOrganizationId,
    });
  });

  it.each([
    ['support', false, []],
    ['operator', true, []],
  ] as const)('a %s gets canEdit=%s and no promote targets', async (role, canEdit, targets) => {
    currentPrincipal = await seedStaff(role);
    const dto = await platformLessonsService.get(currentPrincipal, 'lsn_1');
    expect(dto.canEdit).toBe(canEdit);
    expect(dto.promoteTargets).toEqual(targets);
  });

  it('a global regular lesson offers only planning craft; global craft offers nothing', async () => {
    stored = lesson({ tenant: null, scope: 'global' });
    expect((await platformLessonsService.get(currentPrincipal!, 'lsn_1')).promoteTargets).toEqual([
      'planning_craft',
    ]);
    stored = lesson({ tenant: null, scope: 'global', mistakeType: 'planning_craft' });
    expect((await platformLessonsService.get(currentPrincipal!, 'lsn_1')).promoteTargets).toEqual(
      [],
    );
  });
});

describe('writes — one audit row each, none on a refusal', () => {
  it('edit sends ONLY the changed fields and records them from → to', async () => {
    await platformLessonsService.edit(
      currentPrincipal!,
      'lsn_1',
      {
        title: '  Split by user value  ',
        why: stored!.why,
        categories: ['decomposition', 'scope'],
      },
      'clearer title',
    );
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: '/v1/admin/lessons/lsn_1',
        body: {
          title: 'Split by user value',
          categories: ['decomposition', 'scope'],
          actorCoreUserId: currentPrincipal!.userId,
        },
      },
    ]);
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'ai.lesson.edit',
      targetKind: 'platform',
      targetId: 'lsn_1',
      organizationId: tenant.coreOrganizationId,
      reason: 'clearer title',
      metadata: {
        lessonId: 'lsn_1',
        before: { title: 'Split stories by user value', categories: ['decomposition'] },
        after: { title: 'Split by user value', categories: ['decomposition', 'scope'] },
      },
    });
  });

  it('an edit that moves nothing is Unchanged before motir-ai is written', async () => {
    await expect(
      platformLessonsService.edit(currentPrincipal!, 'lsn_1', { title: stored!.title }, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    expect(writes).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a blanked field is Invalid', async () => {
    await expect(
      platformLessonsService.edit(currentPrincipal!, 'lsn_1', { why: '   ' }, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonInvalidError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a blank reason is refused before any read', async () => {
    await expect(
      platformLessonsService.setEnabled(currentPrincipal!, 'lsn_1', false, '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('switching to where the lesson already is, is Unchanged', async () => {
    await expect(
      platformLessonsService.setEnabled(currentPrincipal!, 'lsn_1', true, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    expect(writes).toHaveLength(0);
  });

  it("motir-ai's audit:null no-op rolls the row back", async () => {
    writeAnswer = 'noop';
    await expect(
      platformLessonsService.setEnabled(currentPrincipal!, 'lsn_1', false, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    expect(writes).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('motir-ai down on a write leaves no row', async () => {
    writeAnswer = 'unavailable';
    await expect(
      platformLessonsService.setEnabled(currentPrincipal!, 'lsn_1', false, 'r'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('an operator may switch and edit but not promote', async () => {
    currentPrincipal = await seedStaff('operator');
    await platformLessonsService.setEnabled(currentPrincipal, 'lsn_1', false, 'noisy');
    await expect(
      platformLessonsService.promote(currentPrincipal, 'lsn_1', 'global', 'share'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect((await auditRows()).map((r) => r.action)).toEqual(['ai.lesson.disable']);
  });

  it('support may not switch', async () => {
    currentPrincipal = await seedStaff('support');
    await expect(
      platformLessonsService.setEnabled(currentPrincipal, 'lsn_1', false, 'r'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('promote records scope and type from → to, and refuses an unknown target', async () => {
    await platformLessonsService.promote(currentPrincipal!, 'lsn_1', 'planning_craft', 'universal');
    expect(writes[0]).toMatchObject({
      method: 'POST',
      path: '/v1/admin/lessons/lsn_1/promote',
      body: { to: 'planning_craft' },
    });
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: 'ai.lesson.promote',
      metadata: {
        before: { scope: 'tenant', mistakeType: 'regular_planning', tenant },
        after: { scope: 'global', mistakeType: 'planning_craft' },
      },
    });
    await expect(
      platformLessonsService.promote(currentPrincipal!, 'lsn_1', 'everywhere', 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonInvalidError);
  });

  it('promoting a lesson already global to global is Unchanged', async () => {
    stored = lesson({ tenant: null, scope: 'global' });
    await expect(
      platformLessonsService.promote(currentPrincipal!, 'lsn_1', 'global', 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    expect(writes).toHaveLength(0);
  });
});

describe('retention — the retirement window (MOTIR-1463)', () => {
  it('the list carries the window; only a superadmin may change it', async () => {
    const asSuper = await platformLessonsService.list(currentPrincipal!, {});
    expect(asSuper.retention).toMatchObject({
      days: 90,
      defaultDays: 90,
      isSet: false,
      updatedByName: null,
      minDays: 7,
      maxDays: 365,
      canChange: true,
    });
    currentPrincipal = await seedStaff('operator');
    const asOperator = await platformLessonsService.list(currentPrincipal, {});
    expect(asOperator.retention.canChange).toBe(false);
  });

  it('a set window names who set it', async () => {
    retention = { days: 30, updatedAt: '2026-10-01T09:00:00.000Z', by: currentPrincipal!.userId };
    const list = await platformLessonsService.list(currentPrincipal!, {});
    expect(list.retention).toMatchObject({
      days: 30,
      isSet: true,
      updatedByName: 'Ops superadmin',
    });
  });

  it('preview returns the count that would rest, superadmin only', async () => {
    await expect(platformLessonsService.previewRetention(currentPrincipal!, 30)).resolves.toBe(4);
    await expect(
      platformLessonsService.previewRetention(currentPrincipal!, 3),
    ).rejects.toBeInstanceOf(PlatformLessonInvalidError);
    currentPrincipal = await seedStaff('operator');
    await expect(
      platformLessonsService.previewRetention(currentPrincipal, 30),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('set writes the new N and one retention_set row, from → to', async () => {
    await platformLessonsService.setRetention(currentPrincipal!, 30, 'Lessons go stale faster');
    expect(writes).toEqual([
      {
        method: 'PUT',
        path: '/v1/admin/lesson-retention',
        body: { days: 30, actorCoreUserId: currentPrincipal!.userId },
      },
    ]);
    const rows = await auditRows();
    const row = rows.find((r) => r.action === 'ai.lesson.retention_set');
    expect(row).toMatchObject({
      targetKind: 'platform',
      targetId: 'lesson-retention',
      reason: 'Lessons go stale faster',
      metadata: { before: { days: 90 }, after: { days: 30 } },
    });
  });

  it('refusals leave no row: same N, out of bounds, blank reason, operator, no-op, motir-ai down', async () => {
    await expect(
      platformLessonsService.setRetention(currentPrincipal!, 90, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    await expect(
      platformLessonsService.setRetention(currentPrincipal!, 400, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonInvalidError);
    await expect(
      platformLessonsService.setRetention(currentPrincipal!, 30, '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    writeAnswer = 'noop';
    await expect(
      platformLessonsService.setRetention(currentPrincipal!, 30, 'r'),
    ).rejects.toBeInstanceOf(PlatformLessonUnchangedError);
    writeAnswer = 'unavailable';
    await expect(
      platformLessonsService.setRetention(currentPrincipal!, 30, 'r'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    currentPrincipal = await seedStaff('operator');
    await expect(
      platformLessonsService.setRetention(currentPrincipal, 30, 'r'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    const rows = await auditRows();
    expect(rows.filter((r) => r.action === 'ai.lesson.retention_set')).toHaveLength(0);
  });
});
