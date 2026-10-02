import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The planning-model Server ACTION (MOTIR-7231) — its result codes.
 *
 * The action is TRANSPORT: the rules live in `platformPlannerModelService`, which
 * has its own suite. What is asserted here is the TRANSLATION — each refusal the
 * page draws differently reaches it as its own code, not collapsed into
 * `FAILED` — and that a refusal writes no audit row. motir-ai is stubbed at the
 * HTTP boundary, as in the service suite.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The degree is honoured, so NOT_PERMITTED is the action's own gate.
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

const { setPlannerModelAction } = await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+planner-action-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

let putAnswer:
  | { kind: 'ok' }
  | { kind: 'problem'; code: string; status: number; detail?: string }
  | { kind: 'down' } = { kind: 'ok' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
  if (putAnswer.kind === 'down') throw new TypeError('fetch failed');
  if (init.method === 'GET') {
    return json({
      settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
        audience,
        model: 'claude-opus-5-5',
        offered: true,
        updatedAt: '2026-10-02T09:00:00.000Z',
        updatedByCoreUserId: null,
        reachable: true,
        lastProbeAt: null,
        lastProbeError: null,
      })),
      offered: [
        { id: 'claude-opus-5-5', provider: 'anthropic' },
        { id: 'claude-sonnet-5-5', provider: 'anthropic' },
      ],
    });
  }
  const body = JSON.parse(String(init.body)) as { audience: string; model: string };
  if (putAnswer.kind === 'problem') {
    const { code, status, detail } = putAnswer;
    return json({ type: 'about:blank', title: code, status, code, detail }, status);
  }
  return json({
    audience: body.audience,
    previousModel: 'claude-opus-5-5',
    model: body.model,
    updatedAt: '2026-10-02T10:00:00.000Z',
  });
});

const auditRows = () => adminDb.platformAuditLog.findMany();

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  vi.mocked(revalidatePath).mockClear();
  putAnswer = { kind: 'ok' };
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('setPlannerModelAction', () => {
  it('saves, writes one audit row, and revalidates the page', async () => {
    const result = await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'Cheaper');
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ai-planning');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'ai.planner_model.set', reason: 'Cheaper' });
  });

  it('NOT_OFFERED — a model withdrawn since load; revalidates so the list re-reads', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400, detail: 'not offered' };
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'NOT_OFFERED',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ai-planning');
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNREACHABLE — carries the probe reason', async () => {
    putAnswer = {
      kind: 'problem',
      code: 'model_unreachable',
      status: 422,
      detail:
        'model "claude-sonnet-5-5" is not reachable for the planner: the provider key was refused (401)',
    };
    const result = await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x');
    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect(result.ok === false && 'reason' in result && result.reason).toMatch(
      /^the provider key was refused/,
    );
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNCHANGED — the audience already plans on that model', async () => {
    expect(await setPlannerModelAction('internal', 'claude-opus-5-5', 'x')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
  });

  it('REASON_REQUIRED — a blank reason is refused before motir-ai is called', async () => {
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', '   ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(fetchStub.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
  });

  it('NOT_PERMITTED — an operator cannot change the model', async () => {
    currentPrincipal = await seedStaff('operator');
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNAVAILABLE — motir-ai cannot be reached', async () => {
    putAnswer = { kind: 'down' };
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
  });

  it('FAILED — an unknown audience is not a code the page can draw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await setPlannerModelAction('everyone', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'FAILED',
    });
  });
});
