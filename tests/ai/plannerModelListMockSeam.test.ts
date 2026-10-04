import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import {
  getPlannerModelList,
  getPlannerModelSettings,
  updatePlannerModelList,
} from '@/lib/ai/motirAiClient';
import {
  PlannerModelListEntryInUseError,
  PlannerModelListFallbackError,
  PlannerModelNotQualifiedError,
} from '@/lib/ai/errors';
import {
  installPlannerModelBoundaryMock,
  type PlannerModelFixture,
} from '@/lib/test-planner-model-mock';

// The E2E seam's planning-model LIST (Story MOTIR-7521 · MOTIR-7524), driven
// through the REAL client: what the page and the acceptance spec will see is
// exactly what these assert, motir-ai's refusal wording included.

const dir = mkdtempSync(path.join(tmpdir(), 'planner-list-'));
const fixturePath = path.join(dir, 'fixture.json');
let previous: Dispatcher;

function seed(fixture: PlannerModelFixture) {
  writeFileSync(fixturePath, JSON.stringify(fixture));
}

function stored(): PlannerModelFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as PlannerModelFixture;
}

const BASE: PlannerModelFixture = {
  settings: [
    { audience: 'customer', model: 'claude-opus-5-5' },
    { audience: 'meta', model: 'claude-sonnet-5-5' },
    { audience: 'internal', model: 'claude-opus-5-5' },
  ],
  offered: [
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic' },
    { id: 'glm-5.2', provider: 'z-ai' },
  ],
};

beforeAll(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.mock.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'] = fixturePath;
  previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  installPlannerModelBoundaryMock(agent);
  setGlobalDispatcher(agent);
});

afterAll(() => {
  setGlobalDispatcher(previous);
  delete process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'];
});

beforeEach(() => seed(structuredClone(BASE)));

describe('the planning-model list seam', () => {
  it('an unseeded list reads as the migration seed: offered, in use and the fallback', async () => {
    seed({ ...structuredClone(BASE), offered: [{ id: 'glm-5.2', provider: 'z-ai' }] });
    const { entries } = await getPlannerModelList();
    expect(entries.map((e) => e.model).sort()).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'glm-5.2',
    ]);
    expect(entries.find((e) => e.model === 'claude-opus-5-5')).toMatchObject({
      offered: false,
      provider: null,
      reason: 'not_servable',
    });
  });

  it('an add is stored with its actor, and the settings offer follows the list', async () => {
    seed({ ...structuredClone(BASE), list: [{ model: 'claude-opus-5-5' }] });
    expect((await getPlannerModelSettings()).offered.map((m) => m.id)).toEqual(['claude-opus-5-5']);

    const after = await updatePlannerModelList({
      action: 'add',
      model: 'glm-5.2',
      actorCoreUserId: 'u_1',
    });
    expect(after.entries.at(-1)).toMatchObject({ model: 'glm-5.2', addedByCoreUserId: 'u_1' });
    expect(stored().list?.map((e) => e.model)).toEqual(['claude-opus-5-5', 'glm-5.2']);
    expect((await getPlannerModelSettings()).offered.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'glm-5.2',
    ]);
  });

  it('a not-qualified add carries the fixture reason', async () => {
    seed({ ...structuredClone(BASE), notQualified: { 'qwen-4': 'unrated' } });
    await expect(
      updatePlannerModelList({ action: 'add', model: 'qwen-4', actorCoreUserId: 'u_1' }),
    ).rejects.toMatchObject({ constructor: PlannerModelNotQualifiedError, reason: 'unrated' });
  });

  it('removes refuse the fallback and a model in use, and drop anything else', async () => {
    await expect(
      updatePlannerModelList({ action: 'remove', model: 'claude-opus-5-5', actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(PlannerModelListFallbackError);
    await expect(
      updatePlannerModelList({
        action: 'remove',
        model: 'claude-sonnet-5-5',
        actorCoreUserId: 'u',
      }),
    ).rejects.toMatchObject({ constructor: PlannerModelListEntryInUseError, audiences: ['meta'] });

    const after = await updatePlannerModelList({
      action: 'remove',
      model: 'glm-5.2',
      actorCoreUserId: 'u',
    });
    expect(after.entries.map((e) => e.model)).not.toContain('glm-5.2');
  });
});
