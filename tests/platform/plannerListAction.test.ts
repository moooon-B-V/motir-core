import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The planning-model LIST Server ACTIONS (MOTIR-7527) — their result codes.
 *
 * Transport only: the rules live in `platformPlannerModelService`, which has its
 * own suite (`platformPlannerModelList.test.ts`). What is asserted here is the
 * TRANSLATION — each refusal the card draws differently reaches it as its own
 * code, not collapsed into `FAILED` — and that a refusal writes no audit row.
 * motir-ai is stubbed at the HTTP boundary, answering in its own wording.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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

const { addPlannerListModelAction, removePlannerListModelAction } =
  await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+planner-list-action-${role}-${seq++}@moooon.net`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

let putAnswer: { kind: 'ok' } | { kind: 'problem'; detail: string } | { kind: 'down' } = {
  kind: 'ok',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (putAnswer.kind === 'down') throw new TypeError('fetch failed');
  if (url.endsWith('/v1/planner-model-settings')) return json({ settings: [], offered: [] });
  if (init.method === 'GET') return json({ entries: [] });
  if (putAnswer.kind === 'problem') {
    const { detail } = putAnswer;
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
  return json({ entries: [] });
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

describe('addPlannerListModelAction', () => {
  it('adds, writes one audit row, and revalidates the page', async () => {
    expect(await addPlannerListModelAction('kimi-k2.6', 'Try it')).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ai-planning');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'ai.planner_model_list.add', reason: 'Try it' });
  });

  it('NOT_QUALIFIED — carries the reason and motir-ai’s detail; no row', async () => {
    putAnswer = {
      kind: 'problem',
      detail: 'model "glm-5.2" cannot be allowed for planning: it is not a chat model',
    };
    expect(await addPlannerListModelAction('glm-5.2', 'x')).toEqual({
      ok: false,
      code: 'NOT_QUALIFIED',
      reason: 'not_chat',
      detail: 'it is not a chat model',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('REFUSED — a wording it does not recognise keeps the detail whole', async () => {
    putAnswer = { kind: 'problem', detail: 'unknown action' };
    expect(await addPlannerListModelAction('x', 'r')).toEqual({
      ok: false,
      code: 'REFUSED',
      detail: 'unknown action',
    });
  });

  it('MODEL_REQUIRED — a blank id never reaches motir-ai', async () => {
    expect(await addPlannerListModelAction('   ', 'r')).toEqual({
      ok: false,
      code: 'MODEL_REQUIRED',
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('REASON_REQUIRED — a blank reason; no row', async () => {
    expect(await addPlannerListModelAction('x', '  ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNAVAILABLE — motir-ai is down; no row', async () => {
    putAnswer = { kind: 'down' };
    expect(await addPlannerListModelAction('x', 'r')).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await auditRows()).toHaveLength(0);
  });

  it('NOT_PERMITTED — an operator is turned away before motir-ai is asked', async () => {
    currentPrincipal = await seedStaff('operator');
    expect(await addPlannerListModelAction('x', 'r')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('FAILED — anything else, logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { platformPlannerModelService } =
      await import('@/lib/services/platformPlannerModelService');
    vi.spyOn(platformPlannerModelService, 'addModel').mockRejectedValueOnce(new RangeError('boom'));
    expect(await addPlannerListModelAction('x', 'r')).toEqual({ ok: false, code: 'FAILED' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('removePlannerListModelAction', () => {
  it('removes, writes one audit row, and revalidates the page', async () => {
    expect(await removePlannerListModelAction('glm-5.2', 'unused')).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ai-planning');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'ai.planner_model_list.remove', reason: 'unused' });
  });

  it('IN_USE — names the audiences; no row', async () => {
    putAnswer = {
      kind: 'problem',
      detail:
        'model "claude-sonnet-5-5" is the planning model of: meta, internal — set those audiences to another model first',
    };
    expect(await removePlannerListModelAction('claude-sonnet-5-5', 'r')).toEqual({
      ok: false,
      code: 'IN_USE',
      audiences: ['meta', 'internal'],
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('FALLBACK — the planner’s fallback stays; no row', async () => {
    putAnswer = {
      kind: 'problem',
      detail: `model "claude-opus-5-5" is the planner's fallback and must stay on the planning-model list`,
    };
    expect(await removePlannerListModelAction('claude-opus-5-5', 'r')).toEqual({
      ok: false,
      code: 'FALLBACK',
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
