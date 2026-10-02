import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { OrgUsageDTO, UsageRunDTO } from '@/lib/dto/aiUsage';
import type { PlannerModelSettingsRead } from '@/lib/ai/types';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { toPlatformPlannerModelSettingsDTO } from '@/lib/mappers/platformPlannerModelMappers';
import { presentMcpPlan } from '@/lib/mcp/payloads/workLoop';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/**
 * STORY GATE — motir-core's half of Story MOTIR-7220 (Subtask MOTIR-7234).
 *
 * Platform admins choose which model plans, per audience, and no tenant ever
 * reads which model that was. motir-ai has its own gate (MOTIR-7232) for what a
 * job then USES; this file asserts nothing about motir-ai beyond the stubbed
 * contract shape.
 *
 *   1. The console SEAM, assembled: Server Action → service → audited
 *      transaction → motir-ai client, against real Postgres.
 *   2. The TENANT READ boundary: every tenant-facing plan serialiser, deep-scanned
 *      for a native model id, with a mutation proving the scan is not vacuous.
 *   3. The usage DTO's TYPE carries no model.
 *   4. Nothing reads the retired `Project.aiPlannerModel`.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` stub; the DEGREE is honoured, so an
    // operator's refusal is the action's and the service's own gate.
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

// The MUTATION switch for the deep-scan guard's negative case: with it on, the
// one redaction helper every plan serialiser calls becomes the identity, which
// is what "somebody removed the redaction" looks like from the outside.
const redaction = vi.hoisted(() => ({ disabled: false }));
vi.mock('@/lib/plans/redactNativeModel', async () => {
  const actual = await vi.importActual<typeof import('@/lib/plans/redactNativeModel')>(
    '@/lib/plans/redactNativeModel',
  );
  return {
    redactNativeProvenance: ((p: unknown) =>
      redaction.disabled ? p : actual.redactNativeProvenance(p as never)) as never,
    redactNativeActor: (source: string | null | undefined, model: string | null | undefined) =>
      redaction.disabled ? (model ?? null) : actual.redactNativeActor(source, model),
  };
});

const { setPlannerModelAction } = await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+gate-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

// ── motir-ai, stubbed at the HTTP boundary ──────────────────────────────────
let served: PlannerModelSettingsRead['settings'] = [];
const puts: { url: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (init.method === 'GET') {
    return json({
      settings: served,
      offered: [
        { id: 'claude-opus-5-5', provider: 'anthropic' },
        { id: 'claude-sonnet-5-5', provider: 'anthropic' },
      ],
    });
  }
  const body = JSON.parse(String(init.body)) as { audience: string; model: string };
  puts.push({ url, body });
  return json({
    audience: body.audience,
    previousModel: served.find((s) => s.audience === body.audience)?.model ?? 'claude-opus-5-5',
    model: body.model,
    updatedAt: '2026-10-02T10:00:00.000Z',
  });
});

function row(audience: 'customer' | 'meta' | 'internal', model = 'claude-opus-5-5') {
  return {
    audience,
    model,
    offered: true,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedByCoreUserId: null,
    reachable: true,
    lastProbeAt: null,
    lastProbeError: null,
  };
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  puts.length = 0;
  served = [row('customer'), row('meta'), row('internal')];
  redaction.disabled = false;
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

// ── 1. The console seam ──────────────────────────────────────────────────────

describe('seam — page action → service → audited transaction → motir-ai', () => {
  it('a superadmin save reaches the PUT once and writes exactly one audit row with from → to', async () => {
    const result = await setPlannerModelAction(
      'internal',
      'claude-sonnet-5-5',
      'Cheaper internal planning',
    );
    expect(result).toEqual({ ok: true });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toMatch(/\/v1\/planner-model-settings$/);
    expect(puts[0]!.body).toEqual({
      audience: 'internal',
      model: 'claude-sonnet-5-5',
      actorCoreUserId: currentPrincipal!.userId,
    });

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_model.set',
      targetKind: 'platform',
      targetId: 'internal',
      reason: 'Cheaper internal planning',
      actorUserId: currentPrincipal!.userId,
      metadata: {
        audience: 'internal',
        fromModel: 'claude-opus-5-5',
        toModel: 'claude-sonnet-5-5',
      },
    });
  });

  it('an operator is refused server-side, with no HTTP write and no row', async () => {
    currentPrincipal = await seedStaff('operator');
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('a blank reason writes no row and makes no HTTP call', async () => {
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', '  ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('a stubbed validation_error rolls the audit row back', async () => {
    fetchStub.mockImplementationOnce(async () =>
      json({ settings: served, offered: [{ id: 'claude-opus-5-5', provider: 'anthropic' }] }),
    );
    fetchStub.mockImplementationOnce(async () =>
      json(
        {
          type: 'about:blank',
          title: 'validation_error',
          status: 400,
          code: 'validation_error',
          detail: 'not offered',
        },
        400,
      ),
    );
    expect(await setPlannerModelAction('internal', 'claude-sonnet-5-5', 'x')).toEqual({
      ok: false,
      code: 'NOT_OFFERED',
    });
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('an audience motir-ai did not return audits the model the write replaced', async () => {
    served = [row('customer'), row('internal')];
    expect(await setPlannerModelAction('meta', 'claude-sonnet-5-5', 'first set')).toEqual({
      ok: true,
    });
    const [audit] = await adminDb.platformAuditLog.findMany();
    expect(audit!.metadata).toEqual({
      audience: 'meta',
      fromModel: null,
      toModel: 'claude-sonnet-5-5',
    });
  });
});

describe('the console DTO mapper', () => {
  const read = (settings: PlannerModelSettingsRead['settings']): PlannerModelSettingsRead => ({
    settings,
    offered: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
  });

  it('orders rows by audience and leaves out an audience motir-ai did not return', () => {
    const dto = toPlatformPlannerModelSettingsDTO(
      read([row('internal'), row('customer')]),
      [],
      true,
    );
    expect(dto.rows.map((r) => r.audience)).toEqual(['customer', 'internal']);
    expect(dto.canEdit).toBe(true);
  });

  it('names a changer by name, falls back to email, and nulls a removed account', () => {
    const changed = (id: string) => ({ ...row('customer'), updatedByCoreUserId: id });
    const users = [
      { id: 'u1', name: '  Ops Lead ', email: 'lead@moooon.net' },
      { id: 'u2', name: '   ', email: 'blank@moooon.net' },
    ];
    const name = (id: string) =>
      toPlatformPlannerModelSettingsDTO(read([changed(id)]), users, false).rows[0]!;
    expect(name('u1').updatedBy).toBe('Ops Lead');
    expect(name('u2').updatedBy).toBe('blank@moooon.net');
    expect(name('gone')).toMatchObject({ updatedBy: null, seeded: false });
  });

  it('reads absent probe fields as null, never as undefined', () => {
    const bare = { ...row('meta') } as Record<string, unknown>;
    delete bare['reachable'];
    delete bare['lastProbeAt'];
    delete bare['lastProbeError'];
    const dto = toPlatformPlannerModelSettingsDTO(
      read([bare as unknown as PlannerModelSettingsRead['settings'][number]]),
      [],
      false,
    );
    expect(dto.rows[0]).toMatchObject({ reachable: null, lastProbeAt: null, lastProbeError: null });
  });
});

// ── 2. No tenant-facing plan read names a native model ───────────────────────

const NATIVE_MODEL = 'native-secret-model-7234';
const MCP_MODEL = 'mcp-visible-model-7234';

/** A plan whose author, one proposal and one revision all carry `model`. */
async function seedPlan(source: 'native' | 'mcp', model: string) {
  const fx = await makeWorkItemFixture();
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: `${source} plan`, authorSource: source, authorHarness: 'h', authorModel: model },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: `${source} task`,
          kind: 'task',
          planningProvenance: { source, harness: 'h', model },
        },
      },
    ],
    fx.ctx,
  );
  await adminDb.planRevision.create({
    data: {
      planId: plan.id,
      changeKind: 'brief_corrected',
      actorSource: source,
      actorHarness: 'h',
      actorModel: model,
      diff: {},
    },
  });
  return { fx, planId: plan.id };
}

/** Every tenant-facing serialiser that carries a plan model, as JSON. */
async function serialisedReads(
  planId: string,
  ctx: Awaited<ReturnType<typeof seedPlan>>['fx']['ctx'],
) {
  const plan = await plansService.getPlan(planId, ctx);
  return {
    planDto: JSON.stringify(plan),
    reviewDto: JSON.stringify(await planReviewService.getPlanReview(planId, ctx)),
    mcpGetPlan: JSON.stringify(presentMcpPlan(plan)),
  };
}

describe('guard — no tenant-facing plan read carries a native planning model', () => {
  it('a native plan’s model appears in NONE of the serialised reads', async () => {
    const { fx, planId } = await seedPlan('native', NATIVE_MODEL);
    // The stored rows keep it — redaction is at the read, never the write.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).authorModel).toBe(
      NATIVE_MODEL,
    );
    for (const [name, body] of Object.entries(await serialisedReads(planId, fx.ctx))) {
      expect(body, `${name} leaks the native model`).not.toContain(NATIVE_MODEL);
    }
  });

  it('is NOT vacuous: an mcp author’s model is carried by every read', async () => {
    const { fx, planId } = await seedPlan('mcp', MCP_MODEL);
    for (const [name, body] of Object.entries(await serialisedReads(planId, fx.ctx))) {
      expect(body, `${name} should carry the mcp model`).toContain(MCP_MODEL);
    }
  });

  it('FAILS when the redaction is removed — every read then carries the native model', async () => {
    const { fx, planId } = await seedPlan('native', NATIVE_MODEL);
    redaction.disabled = true;
    for (const [name, body] of Object.entries(await serialisedReads(planId, fx.ctx))) {
      expect(body, `${name} should leak once redaction is gone`).toContain(NATIVE_MODEL);
    }
  });
});

// ── 3. The usage DTO's type ──────────────────────────────────────────────────

describe('guard — the usage DTO names no model', () => {
  it('OrgUsageDTO has no perModel, UsageRunDTO no model', () => {
    expectTypeOf<OrgUsageDTO>().not.toHaveProperty('perModel');
    expectTypeOf<UsageRunDTO>().not.toHaveProperty('model');
  });
});

// ── 4. Nothing reads the retired setting ─────────────────────────────────────

const ROOT = resolve(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('guard — nothing reads Project.aiPlannerModel', () => {
  it('no file under lib/, app/ or components/ names it', () => {
    const hits = ['lib', 'app', 'components']
      .flatMap((d) => sourceFiles(join(ROOT, d)))
      .filter((f) => readFileSync(f, 'utf8').includes('aiPlannerModel'))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });

  it('the schema keeps the column but hides it from the client with @ignore', () => {
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const line = schema.split('\n').find((l) => /^\s*aiPlannerModel\s/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/@map\("ai_planner_model"\)/);
    expect(line).toMatch(/@ignore/);
  });
});
