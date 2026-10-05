import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerModelListModelMissingError,
} from '@/lib/platform/errors';
import {
  MotirAiUnavailableError,
  PlannerModelListEntryInUseError,
  PlannerModelListFallbackError,
  PlannerModelNotQualifiedError,
} from '@/lib/ai/errors';
import type { PlannerModelListEntryRead, PlannerModelSettingRead } from '@/lib/ai/types';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The console's planning-model LIST seam (Story MOTIR-7521 · MOTIR-7524).
 *
 * Real Postgres for the audit trail, which is the property under test: every
 * refusal is checked against the ROW COUNT, because the way to break "a refused
 * write leaves no row" is to throw outside the transaction. motir-ai is stubbed
 * at the HTTP boundary, answering in its own refusal wording.
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
    email: `ops+planner-list-${role}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

function setting(audience: PlannerModelSettingRead['audience'], model: string) {
  return {
    audience,
    model,
    offered: true,
    updatedAt: '2026-10-02T09:00:00.000Z',
    updatedByCoreUserId: null,
    reachable: true,
    lastProbeAt: null,
    lastProbeError: null,
  } satisfies PlannerModelSettingRead;
}

function entry(model: string, over: Partial<PlannerModelListEntryRead> = {}) {
  return {
    model,
    provider: 'anthropic',
    offered: true,
    reason: null,
    addedByCoreUserId: null,
    createdAt: '2026-10-04T09:00:00.000Z',
    ...over,
  } satisfies PlannerModelListEntryRead;
}

let listed: PlannerModelListEntryRead[] = [];
let settings: PlannerModelSettingRead[] = [];
let putAnswer: { kind: 'ok' } | { kind: 'problem'; detail: string } = { kind: 'ok' };
let puts: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const CANDIDATES = [
  { id: 'glm-5.2', provider: 'z-ai' },
  { id: 'kimi-k2.6', provider: 'moonshot' },
];

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/v1/planner-model-settings')) {
    return json({ settings, offered: [] });
  }
  if (init.method === 'GET') return json({ entries: listed, candidates: CANDIDATES });
  const body = JSON.parse(String(init.body)) as {
    action: 'add' | 'remove';
    model: string;
    actorCoreUserId: string;
  };
  puts.push(body);
  if (putAnswer.kind === 'problem') {
    const detail = putAnswer.detail;
    return json(
      {
        type: 'about:blank',
        title: 'validation_error',
        status: 400,
        code: 'validation_error',
        detail,
      },
      400,
    );
  }
  listed =
    body.action === 'add'
      ? [...listed, entry(body.model, { addedByCoreUserId: body.actorCoreUserId })]
      : listed.filter((e) => e.model !== body.model);
  return json({ entries: listed });
});

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  puts = [];
  putAnswer = { kind: 'ok' };
  listed = [
    entry('claude-opus-5-5'),
    entry('claude-sonnet-5-5'),
    entry('claude-opus-4-8', { provider: null, offered: false, reason: 'not_servable' }),
  ];
  settings = [
    setting('customer', 'claude-opus-5-5'),
    setting('meta', 'claude-sonnet-5-5'),
    setting('internal', 'claude-sonnet-5-5'),
  ];
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
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

describe('listModels — any staff role reads', () => {
  it.each([
    ['support', false],
    ['operator', false],
    ['superadmin', true],
  ] as const)('a %s reads every entry; canEdit=%s', async (role, canEdit) => {
    if (role !== 'superadmin') currentPrincipal = await seedStaff(role);
    const dto = await platformPlannerModelService.listModels(currentPrincipal!);
    expect(dto.canEdit).toBe(canEdit);
    expect(dto.entries.map((e) => e.model)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-opus-4-8',
    ]);
    expect(await auditRows()).toHaveLength(0);
  });

  it("carries motir-ai's addable candidates through, in its order (MOTIR-7614)", async () => {
    const dto = await platformPlannerModelService.listModels(currentPrincipal!);
    expect(dto.candidates).toEqual(CANDIDATES);
  });

  it('each entry carries its offered state, reason, users and the fallback flag', async () => {
    const dto = await platformPlannerModelService.listModels(currentPrincipal!);
    expect(dto.entries[0]).toMatchObject({
      model: 'claude-opus-5-5',
      offered: true,
      reason: null,
      inUseBy: ['customer'],
      fallback: true,
      seeded: true,
      addedBy: null,
    });
    expect(dto.entries[1]).toMatchObject({ inUseBy: ['meta', 'internal'], fallback: false });
    expect(dto.entries[2]).toMatchObject({
      provider: null,
      offered: false,
      reason: 'not_servable',
      inUseBy: [],
    });
  });

  it('resolves the adder to a display name', async () => {
    listed = [entry('glm-5.2', { addedByCoreUserId: currentPrincipal!.userId })];
    const dto = await platformPlannerModelService.listModels(currentPrincipal!);
    expect(dto.entries[0]).toMatchObject({ addedBy: 'Ops superadmin', seeded: false });
  });

  it('a non-staff caller is NotPlatformStaffError, before motir-ai is asked', async () => {
    currentPrincipal = null;
    const tenant = await createTestUser({ email: 'tenant@example.com' });
    await expect(
      platformPlannerModelService.listModels({
        userId: tenant.id,
        email: tenant.email,
        role: 'support',
      }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('motir-ai unreachable is the unavailable error — never an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(platformPlannerModelService.listModels(currentPrincipal!)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('addModel / removeModel — superadmin writes, and every write is audited', () => {
  it('an add calls motir-ai once and appends exactly one row naming the action and model', async () => {
    const dto = await platformPlannerModelService.addModel(
      currentPrincipal!,
      '  glm-5.2 ',
      'GLM is cheaper for meta',
    );
    expect(puts).toEqual([
      { action: 'add', model: 'glm-5.2', actorCoreUserId: currentPrincipal!.userId },
    ]);
    expect(dto.entries.at(-1)).toMatchObject({ model: 'glm-5.2', addedBy: 'Ops superadmin' });
    expect(dto.canEdit).toBe(true);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_model_list.add',
      targetKind: 'platform',
      targetId: 'glm-5.2',
      reason: 'GLM is cheaper for meta',
      actorUserId: currentPrincipal!.userId,
      actorRole: 'superadmin',
      metadata: { action: 'add', model: 'glm-5.2' },
    });
  });

  it('a remove appends exactly one remove row', async () => {
    const dto = await platformPlannerModelService.removeModel(
      currentPrincipal!,
      'claude-opus-4-8',
      'withdrawn upstream',
    );
    expect(dto.entries.map((e) => e.model)).not.toContain('claude-opus-4-8');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_model_list.remove',
      targetId: 'claude-opus-4-8',
      metadata: { action: 'remove', model: 'claude-opus-4-8' },
    });
  });

  it.each(['support', 'operator'] as const)(
    'a %s is refused before any remote call, and no row is written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      for (const write of [
        () => platformPlannerModelService.addModel(currentPrincipal!, 'glm-5.2', 'why'),
        () => platformPlannerModelService.removeModel(currentPrincipal!, 'glm-5.2', 'why'),
      ]) {
        await expect(write()).rejects.toBeInstanceOf(NotPlatformStaffError);
      }
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a blank reason is MissingAuditReasonError, with no remote call and no row', async () => {
    await expect(
      platformPlannerModelService.addModel(currentPrincipal!, 'glm-5.2', '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    await expect(
      platformPlannerModelService.removeModel(currentPrincipal!, 'glm-5.2', ''),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a blank model is refused before motir-ai is asked', async () => {
    await expect(
      platformPlannerModelService.addModel(currentPrincipal!, '   ', 'reason'),
    ).rejects.toBeInstanceOf(PlannerModelListModelMissingError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a not-qualified add is PlannerModelNotQualifiedError with its reason, and the row rolls back', async () => {
    putAnswer = {
      kind: 'problem',
      detail: 'model "glm-5.2" cannot be allowed for planning: it is not a chat model',
    };
    const err = await platformPlannerModelService
      .addModel(currentPrincipal!, 'glm-5.2', 'try GLM')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelNotQualifiedError);
    expect(err).toMatchObject({ model: 'glm-5.2', reason: 'not_chat' });
    expect(puts).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('removing a model in use is PlannerModelListEntryInUseError with the audiences, and no row', async () => {
    putAnswer = {
      kind: 'problem',
      detail:
        'model "claude-sonnet-5-5" is the planning model of: meta, internal — set those audiences to another model first',
    };
    const err = await platformPlannerModelService
      .removeModel(currentPrincipal!, 'claude-sonnet-5-5', 'retire Sonnet')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelListEntryInUseError);
    expect((err as PlannerModelListEntryInUseError).audiences).toEqual(['meta', 'internal']);
    expect(await auditRows()).toHaveLength(0);
  });

  it('removing the fallback is PlannerModelListFallbackError, and no row', async () => {
    putAnswer = {
      kind: 'problem',
      detail: `model "claude-opus-5-5" is the planner's fallback and must stay on the planning-model list`,
    };
    await expect(
      platformPlannerModelService.removeModel(currentPrincipal!, 'claude-opus-5-5', 'tidy'),
    ).rejects.toBeInstanceOf(PlannerModelListFallbackError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('motir-ai unreachable on a write is the unavailable error, and no row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      platformPlannerModelService.addModel(currentPrincipal!, 'glm-5.2', 'try GLM'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('motir-ai applied but the audit row did not commit: logged as the residual case, and rethrown', async () => {
    // motir-ai answers only after the interactive transaction's 5s deadline, so
    // the change lands remotely while core's commit — and its row — does not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method !== 'GET') await new Promise((r) => setTimeout(r, 5_500));
        return fetchStub(url, init);
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      platformPlannerModelService.addModel(currentPrincipal!, 'glm-5.2', 'try GLM'),
    ).rejects.toThrow();
    expect(puts).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('but the audit row did not commit'),
      { action: 'add', model: 'glm-5.2', actorCoreUserId: currentPrincipal!.userId },
      expect.anything(),
    );
    expect(await auditRows()).toHaveLength(0);
  }, 20_000);
});
