import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { hostedRunPickerService } from '@/lib/services/hostedRunPickerService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setProjectAccess } from '../helpers/projectAccess';

// THE RUN HOSTED PICKER'S READ carries the card's resolved model (Story MOTIR-6989
// · MOTIR-6996) — `hostedRunPickerService.readModels` and
// `GET /api/hosted-runs/models?workItem=<KEY>` over the real Postgres. motir-ai is
// the one HTTP seam (`fetch` stubbed with `/v1/agent-models`); the compliant-
// session gate is stubbed for the route half, handing it a REAL context.
//
// Pinned: the three wordings' inputs (a leaf's difficulty, a project override, a
// parent's highest leaf), a leaf with no difficulty resolving to the platform
// default, the answer unchanged without `workItem`, and every way the resolution
// can fail — an unknown key, a card the caller cannot browse — answering
// `resolved: null` rather than refusing the list.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET } = await import('@/app/api/hosted-runs/models/route');

const OFFERED = {
  models: [
    { id: 'claude-opus-5', provider: 'anthropic' },
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  ],
  default: 'claude-opus-5-5',
  defaultsByDifficulty: {
    trivial: 'claude-sonnet-5-5',
    low: 'claude-sonnet-5-5',
    medium: 'claude-opus-5-5',
    high: 'claude-opus-5-5',
  },
};

let modelCalls = 0;

function serveModels(body: unknown = OFFERED, status = 200) {
  modelCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      modelCalls += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  serveModels();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (fx: WorkItemFixture, userId = fx.ownerId): WorkspaceContext => ({
  userId,
  workspaceId: fx.workspaceId,
});

async function leaf(fx: WorkItemFixture, difficulty: 'trivial' | 'low' | 'medium' | 'high' | null) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: `Leaf ${difficulty}` });
  if (difficulty) {
    await adminDb.workItem.update({ where: { id: item.id }, data: { difficulty } });
  }
  return item;
}

describe('hostedRunPickerService.readModels', () => {
  it('answers exactly the old shape — no `resolved` key — when no card is named', async () => {
    const fx = await makeWorkItemFixture();
    const read = await hostedRunPickerService.readModels(null, ctxFor(fx));
    expect(read).toEqual({ state: 'ok', models: OFFERED.models, default: 'claude-opus-5-5' });
    expect(read).not.toHaveProperty('resolved');
  });

  it("resolves a Low leaf with no override to the platform's Low model", async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'low');
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      state: 'ok',
      default: 'claude-opus-5-5',
      resolved: {
        model: 'claude-sonnet-5-5',
        source: 'platform_level',
        difficulty: 'low',
        fromLeaves: false,
      },
    });
    // motir-ai is asked ONCE for the list and the resolution together.
    expect(modelCalls).toBe(1);
  });

  it("resolves a High leaf to the project's override for High", async () => {
    const fx = await makeWorkItemFixture();
    await projectHostedAgentSettingsService.update(
      fx.projectIdentifier,
      { high: 'claude-opus-5' },
      ctxFor(fx),
    );
    const item = await leaf(fx, 'high');
    const read = await hostedRunPickerService.readModels(item.identifier.toLowerCase(), ctxFor(fx));
    expect(read).toMatchObject({
      resolved: { model: 'claude-opus-5', source: 'override', difficulty: 'high' },
    });
  });

  it('resolves a leaf with no difficulty to the platform default — the picker draws no line', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, null);
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      resolved: { model: 'claude-opus-5-5', source: 'platform_default', difficulty: null },
    });
  });

  it('resolves a parent from the highest difficulty among its leaves', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    for (const difficulty of ['low', 'high'] as const) {
      const child = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: difficulty,
        parentId: story.id,
      });
      await adminDb.workItem.update({ where: { id: child.id }, data: { difficulty } });
    }
    const read = await hostedRunPickerService.readModels(story.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      resolved: {
        model: 'claude-opus-5-5',
        source: 'platform_level',
        difficulty: 'high',
        fromLeaves: true,
      },
    });
  });

  it('answers resolved: null for a key that names nothing, and still offers the list', async () => {
    const fx = await makeWorkItemFixture();
    const read = await hostedRunPickerService.readModels(
      `${fx.projectIdentifier}-9999`,
      ctxFor(fx),
    );
    expect(read).toEqual({
      state: 'ok',
      models: OFFERED.models,
      default: 'claude-opus-5-5',
      resolved: null,
    });
    const noProject = await hostedRunPickerService.readModels('NOPE-1', ctxFor(fx));
    expect(noProject).toMatchObject({ state: 'ok', resolved: null });
  });

  it('answers resolved: null for a card in a project the caller cannot browse — no leak', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { hostedModelHigh: 'claude-opus-5' },
    });
    const stranger = await createTestUser({ email: `stranger-${fx.workspaceId}@example.com` });
    await adminDb.workspaceMembership.create({
      data: { userId: stranger.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    const error = vi.spyOn(console, 'error');
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx, stranger.id));
    expect(read).toMatchObject({ state: 'ok', resolved: null });
    // A refusal, not a failure: nothing is logged.
    expect(error).not.toHaveBeenCalled();
    // The positive control: the owner, who may browse it, is told.
    expect(await hostedRunPickerService.readModels(item.identifier, ctxFor(fx))).toMatchObject({
      resolved: { model: 'claude-opus-5', source: 'override' },
    });
  });

  it('degrades an UNEXPECTED resolve failure to resolved: null, and logs it', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(projectHostedAgentSettingsService, 'resolveForWorkItem').mockRejectedValueOnce(
      new Error('connection reset'),
    );
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({ state: 'ok', resolved: null });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable when motir-ai cannot answer — never a resolution without a list', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    serveModels({ code: 'internal_error' }, 503);
    expect(await hostedRunPickerService.readModels(item.identifier, ctxFor(fx))).toEqual({
      state: 'unavailable',
    });
  });
});

describe('GET /api/hosted-runs/models?workItem=', () => {
  const get = (query = '') => GET(new Request(`http://localhost/api/hosted-runs/models${query}`));

  it("adds the card's resolution to the list", async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    await projectHostedAgentSettingsService.update(
      fx.projectIdentifier,
      { high: 'claude-opus-5' },
      ctxFor(fx),
    );
    const item = await leaf(fx, 'high');
    const res = await get(`?workItem=${encodeURIComponent(item.identifier)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      models: OFFERED.models,
      default: 'claude-opus-5-5',
      resolved: {
        model: 'claude-opus-5',
        source: 'override',
        difficulty: 'high',
        fromLeaves: false,
      },
    });
  });

  it('answers the unchanged shape without it, or with a blank one', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    for (const query of ['', '?workItem=', '?workItem=%20']) {
      const res = await get(query);
      expect(await res.json()).toEqual({ models: OFFERED.models, default: 'claude-opus-5-5' });
    }
  });

  it('answers 200 with resolved: null for an unknown card', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    const res = await get(`?workItem=${fx.projectIdentifier}-4242`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: null });
  });

  it('answers 503 with the stable code when motir-ai is unavailable, card or not', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    serveModels({ code: 'internal_error' }, 503);
    const res = await get(`?workItem=${fx.projectIdentifier}-1`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'hosted_models_unavailable' });
  });
});
