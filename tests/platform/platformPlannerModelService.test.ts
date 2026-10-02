import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerAudienceUnknownError,
  PlannerModelUnchangedError,
} from '@/lib/platform/errors';
import {
  MotirAiUnavailableError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import type { PlannerModelSettingRead, PlannerAudience } from '@/lib/ai/types';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The console's planner-model SEAM (Story MOTIR-7220 · MOTIR-7227).
 *
 * Real Postgres for the audit trail, which is the property under test: every
 * refusal is checked against the ROW COUNT, not just the thrown type, because
 * the way to break "a refused write leaves no row" is to throw outside the
 * transaction. motir-ai is stubbed at the HTTP boundary — its own suites own
 * validation and the probe.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` stub, as `organizationClassification.test.ts`
    // does it: the DEGREE is honoured, so a role refusal below is the service's
    // own `requirePlatformStaff(minimum)` and not the mock waving it through.
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
    email: `ops+planner-${role}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

function setting(
  audience: PlannerAudience,
  model: string,
  over: Partial<PlannerModelSettingRead> = {},
): PlannerModelSettingRead {
  return {
    audience,
    model,
    offered: true,
    updatedAt: '2026-10-02T09:00:00.000Z',
    updatedByCoreUserId: null,
    reachable: true,
    lastProbeAt: '2026-10-02T09:05:00.000Z',
    lastProbeError: null,
    ...over,
  };
}

/** What the stub serves on GET, in a deliberately scrambled order. */
let stored: PlannerModelSettingRead[] = [];
/** What the stub answers a PUT with: `ok` writes, otherwise a problem. */
let putAnswer:
  | { kind: 'ok'; previousModel?: string }
  | { kind: 'problem'; code: string; status: number; detail?: string } = { kind: 'ok' };
let puts: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
  if (init.method === 'GET') {
    return json({ settings: stored, offered: [{ id: 'claude-opus-5-5', provider: 'anthropic' }] });
  }
  const body = JSON.parse(String(init.body)) as { audience: string; model: string };
  puts.push(body);
  if (putAnswer.kind === 'problem') {
    const { code, status, detail } = putAnswer;
    return json({ type: 'about:blank', title: code, status, code, detail }, status);
  }
  const current = stored.find((s) => s.audience === body.audience)!;
  return json({
    audience: body.audience,
    previousModel: putAnswer.previousModel ?? current.model,
    model: body.model,
    updatedAt: '2026-10-02T10:00:00.000Z',
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
  puts = [];
  putAnswer = { kind: 'ok' };
  stored = [
    setting('internal', 'claude-sonnet-5-5'),
    setting('customer', 'claude-opus-5-5'),
    setting('meta', 'claude-opus-5-5'),
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

describe('getSettings — any staff role reads', () => {
  it.each([
    ['support', false],
    ['operator', false],
    ['superadmin', true],
  ] as const)(
    'a %s gets three rows in customer, meta, internal order; canEdit=%s',
    async (role, canEdit) => {
      // The beforeEach already seeded the superadmin; seed only the other roles.
      if (role !== 'superadmin') currentPrincipal = await seedStaff(role);
      const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
      expect(dto.rows.map((r) => r.audience)).toEqual(['customer', 'meta', 'internal']);
      expect(dto.rows.map((r) => r.model)).toEqual([
        'claude-opus-5-5',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
      ]);
      expect(dto.canEdit).toBe(canEdit);
      expect(dto.offered).toEqual([{ id: 'claude-opus-5-5', provider: 'anthropic' }]);
    },
  );

  it('a non-staff caller is NotPlatformStaffError, before motir-ai is asked', async () => {
    const tenant = await createTestUser({ email: 'tenant@example.com' });
    const principal = { userId: tenant.id, email: tenant.email, role: 'support' as const };
    currentPrincipal = null;
    await expect(platformPlannerModelService.getSettings(principal)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('resolves the changer to a display name, and leaves the seeded default unattributed', async () => {
    const changer = currentPrincipal!;
    stored = stored.map((s) =>
      s.audience === 'internal' ? { ...s, updatedByCoreUserId: changer.userId } : s,
    );
    const dto = await platformPlannerModelService.getSettings(changer);
    expect(dto.rows.find((r) => r.audience === 'internal')?.updatedBy).toBe('Ops superadmin');
    expect(dto.rows.find((r) => r.audience === 'customer')?.updatedBy).toBeNull();
  });

  it('carries the withdrawn and unreachable signals through', async () => {
    stored = stored.map((s) =>
      s.audience === 'meta'
        ? { ...s, offered: false, reachable: false, lastProbeError: 'the provider key was refused' }
        : s,
    );
    const meta = (await platformPlannerModelService.getSettings(currentPrincipal!)).rows[1]!;
    expect(meta).toMatchObject({
      offered: false,
      reachable: false,
      lastProbeError: 'the provider key was refused',
    });
  });

  it('motir-ai unreachable is the unavailable error — no guessed rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(platformPlannerModelService.getSettings(currentPrincipal!)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('setModel — superadmin writes, and every write is audited', () => {
  it('calls motir-ai once and appends exactly one row with from → to', async () => {
    const result = await platformPlannerModelService.setModel(
      currentPrincipal!,
      'internal',
      'claude-opus-5-5',
      'internal orgs should plan on Opus again',
    );

    expect(result).toEqual({
      audience: 'internal',
      fromModel: 'claude-sonnet-5-5',
      toModel: 'claude-opus-5-5',
      updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(puts).toEqual([
      { audience: 'internal', model: 'claude-opus-5-5', actorCoreUserId: currentPrincipal!.userId },
    ]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_model.set',
      targetKind: 'platform',
      targetId: 'internal',
      reason: 'internal orgs should plan on Opus again',
      actorUserId: currentPrincipal!.userId,
      actorRole: 'superadmin',
      metadata: {
        audience: 'internal',
        fromModel: 'claude-sonnet-5-5',
        toModel: 'claude-opus-5-5',
      },
    });
  });

  it.each(['support', 'operator'] as const)(
    'a %s is refused before any remote call, and no row is written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      await expect(
        platformPlannerModelService.setModel(currentPrincipal, 'meta', 'glm-5.2', 'why not'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a blank reason is refused before the transaction, with no remote call and no row', async () => {
    await expect(
      platformPlannerModelService.setModel(currentPrincipal!, 'meta', 'glm-5.2', '   '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('an unknown audience is refused before any remote call', async () => {
    await expect(
      platformPlannerModelService.setModel(currentPrincipal!, 'everyone', 'glm-5.2', 'reason'),
    ).rejects.toBeInstanceOf(PlannerAudienceUnknownError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('setting the model the audience already holds is PlannerModelUnchangedError — no write, no row', async () => {
    await expect(
      platformPlannerModelService.setModel(currentPrincipal!, 'customer', 'claude-opus-5-5', 'r'),
    ).rejects.toBeInstanceOf(PlannerModelUnchangedError);
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a validation_error is PlannerModelNotOfferedError naming the model, and the row rolls back', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400, detail: 'not offered' };
    const err = await platformPlannerModelService
      .setModel(currentPrincipal!, 'meta', 'glm-5.2', 'try GLM')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelNotOfferedError);
    expect((err as PlannerModelNotOfferedError).model).toBe('glm-5.2');
    expect(puts).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a model_unreachable is PlannerModelUnreachableError with the reason, and the row rolls back', async () => {
    putAnswer = {
      kind: 'problem',
      code: 'model_unreachable',
      status: 422,
      detail:
        'model "glm-5.2" is not reachable for the planner: no enabled channel serves this model for the planner',
    };
    const err = await platformPlannerModelService
      .setModel(currentPrincipal!, 'meta', 'glm-5.2', 'try GLM')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelUnreachableError);
    expect((err as PlannerModelUnreachableError).reason).toBe(
      'no enabled channel serves this model for the planner',
    );
    expect(await auditRows()).toHaveLength(0);
  });

  it('a concurrent write between read and save warns with both values and still succeeds', async () => {
    putAnswer = { kind: 'ok', previousModel: 'glm-5.2' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await platformPlannerModelService.setModel(
      currentPrincipal!,
      'meta',
      'claude-sonnet-5-5',
      'cheaper for meta',
    );
    expect(result.toModel).toBe('claude-sonnet-5-5');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"claude-opus-5-5"');
    expect(String(warn.mock.calls[0]?.[0])).toContain('"glm-5.2"');
    // The row records what THIS superadmin saw and chose.
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({
      audience: 'meta',
      fromModel: 'claude-opus-5-5',
      toModel: 'claude-sonnet-5-5',
    });
  });
});
