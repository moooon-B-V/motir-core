// E2E boundary seam for motir-ai's PLANNER-MODEL settings (Story MOTIR-7220 ·
// MOTIR-7231): an undici intercept of `GET` / `PUT {MOTIR_AI_URL}/v1/planner-model-settings`,
// installed by `instrumentation.ts` (through `lib/test-mock-seams.ts`) behind
// `E2E_TEST_PLANNER_MODEL=1` and dormant everywhere else. The same shape as
// `lib/test-billing-mock.ts` and `lib/test-lessons-mock.ts`.
//
// The console's AI planning page is SERVER rendered and its write is a Server
// Action, so `page.route` reaches neither. State therefore lives in a JSON
// fixture file (`MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH`) that is re-read on every
// request and rewritten by a PUT: a spec seeds it, drives the page, and reads
// back what the save wrote.
//
// The two refusals are motir-ai's, in its wire shape: a model the fixture does
// not offer answers `validation_error`, and a model listed in `unreachable`
// answers `model_unreachable` with the probe's reason — so the page's refused
// and unreachable states are reachable from a browser.
//
// The same file carries the PLANNING-MODEL LIST (Story MOTIR-7521 · MOTIR-7524),
// served on `GET` / `PUT /v1/planner-model-list` with motir-ai's three refusals
// in its exact wording (not qualified, the fallback, in use by an audience). As
// in motir-ai, the settings' `offered` is narrowed to the list. A fixture with no
// `list` reads as motir-ai's migration seed: every offered model, every
// audience's model and the fallback — so a spec written before the list existed
// sees the page it always saw.

import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

type Audience = 'customer' | 'meta' | 'internal';

/** One audience's row, in motir-ai's WIRE shape (`PlannerModelSettingRead`). */
export interface PlannerModelFixtureRow {
  audience: Audience;
  model: string;
  updatedAt?: string;
  updatedByCoreUserId?: string | null;
  reachable?: boolean | null;
  lastProbeAt?: string | null;
  lastProbeError?: string | null;
}

export interface PlannerModelFixture {
  settings: PlannerModelFixtureRow[];
  offered: { id: string; provider: string }[];
  /** Models whose save-time probe fails, with the probe's reason. */
  unreachable?: Record<string, string>;
  /** motir-ai is down: every request answers 503, the page's unavailable state. */
  unavailable?: boolean;
  /** The planning-model list; absent reads as the migration seed (see the header). */
  list?: PlannerModelListFixtureEntry[];
  /** Why a model that is NOT in `offered` is not plannable; absent reads as `not_servable`. */
  notQualified?: Record<string, PlannerModelListFixtureReason>;
}

type PlannerModelListFixtureReason = 'not_servable' | 'not_chat' | 'unrated';

/** One listed model, as the fixture stores it. */
export interface PlannerModelListFixtureEntry {
  model: string;
  addedByCoreUserId?: string | null;
  createdAt?: string;
}

/** motir-ai's fallback, which its list always keeps (`PLANNER_MODEL_FALLBACK`). */
const FALLBACK = 'claude-opus-5-5';

/** motir-ai's `REASON_TEXT`, word for word — the client reads the refusal back from it. */
const REASON_TEXT: Record<PlannerModelListFixtureReason, string> = {
  not_servable: 'the gateway does not serve it',
  not_chat: 'it is not a chat model',
  unrated: 'it has no planning-lane rate in force',
};

const SEEDED_AT = '2026-10-01T00:00:00.000Z';

/** What an unseeded fixture reads as: the three seeded rows, one offered model. */
export function defaultPlannerModelFixture(): PlannerModelFixture {
  return {
    settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
      audience,
      model: 'claude-opus-5-5',
    })),
    offered: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
  };
}

const json = { headers: { 'content-type': 'application/json' } };
const problemJson = { headers: { 'content-type': 'application/problem+json' } };

function fixturePath(): string | undefined {
  return process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'];
}

function readFixture(): PlannerModelFixture {
  const p = fixturePath();
  if (!p) return defaultPlannerModelFixture();
  try {
    return JSON.parse(readFixtureFileSync(p)) as PlannerModelFixture;
  } catch {
    // An absent fixture reads as the seeded state — a legible page, not a 500.
    return defaultPlannerModelFixture();
  }
}

function writeFixture(fixture: PlannerModelFixture): void {
  const p = fixturePath();
  if (p) writeFixtureFileSync(p, JSON.stringify(fixture, null, 2));
}

/** The list as stored, or the migration seed for a fixture that has none. */
function listOf(fixture: PlannerModelFixture): PlannerModelListFixtureEntry[] {
  if (fixture.list) return fixture.list;
  const models = new Set([
    ...fixture.offered.map((m) => m.id),
    ...fixture.settings.map((s) => s.model),
    FALLBACK,
  ]);
  return [...models].map((model) => ({ model }));
}

/** The planner offer: offered ∩ listed, as motir-ai narrows it. */
function plannable(fixture: PlannerModelFixture) {
  const listed = new Set(listOf(fixture).map((e) => e.model));
  return fixture.offered.filter((m) => listed.has(m.id));
}

function listToWire(fixture: PlannerModelFixture) {
  const listed = new Set(listOf(fixture).map((e) => e.model));
  return {
    // motir-ai's `candidates` (MOTIR-7614): plannable (`offered` here) minus listed,
    // sorted by provider, then id.
    candidates: fixture.offered
      .filter((m) => !listed.has(m.id))
      .map((m) => ({ id: m.id, provider: m.provider }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
    entries: listOf(fixture).map((e) => {
      const offered = fixture.offered.find((m) => m.id === e.model);
      return {
        model: e.model,
        provider: offered?.provider ?? null,
        offered: !!offered,
        reason: offered ? null : (fixture.notQualified?.[e.model] ?? 'not_servable'),
        addedByCoreUserId: e.addedByCoreUserId ?? null,
        createdAt: e.createdAt ?? SEEDED_AT,
      };
    }),
  };
}

function toWire(fixture: PlannerModelFixture) {
  const offered = plannable(fixture);
  const offeredIds = new Set(offered.map((m) => m.id));
  return {
    settings: fixture.settings.map((s) => ({
      audience: s.audience,
      model: s.model,
      offered: offeredIds.has(s.model),
      updatedAt: s.updatedAt ?? SEEDED_AT,
      updatedByCoreUserId: s.updatedByCoreUserId ?? null,
      reachable: s.reachable ?? null,
      lastProbeAt: s.lastProbeAt ?? null,
      lastProbeError: s.lastProbeError ?? null,
    })),
    offered,
  };
}

function problem(status: number, code: string, detail: string): Reply {
  return {
    statusCode: status,
    data: { type: `about:blank`, code, title: code, status, detail },
    responseOptions: problemJson,
  };
}

type Reply = { statusCode: number; data: object; responseOptions: typeof json };

const isPath = (p: string) => p.split('?')[0] === '/v1/planner-model-settings';
const isListPath = (p: string) => p.split('?')[0] === '/v1/planner-model-list';

export function installPlannerModelBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  pool
    .intercept({ path: isPath, method: 'GET' })
    .reply<object>(() => {
      const fixture = readFixture();
      if (fixture.unavailable) return problem(503, 'upstream_unavailable', 'motir-ai is down');
      return { statusCode: 200, data: toWire(fixture), responseOptions: json };
    })
    .persist();

  pool
    .intercept({ path: isPath, method: 'PUT' })
    .reply<object>((req) => {
      const fixture = readFixture();
      if (fixture.unavailable) return problem(503, 'upstream_unavailable', 'motir-ai is down');
      let body: { audience?: string; model?: string; actorCoreUserId?: string } = {};
      try {
        body = JSON.parse(String(req.body ?? '{}')) as typeof body;
      } catch {
        return problem(400, 'validation_error', 'body is not JSON');
      }
      const row = fixture.settings.find((s) => s.audience === body.audience);
      if (!row || typeof body.model !== 'string') {
        return problem(400, 'validation_error', 'unknown audience or missing model');
      }
      if (!plannable(fixture).some((m) => m.id === body.model)) {
        return problem(400, 'validation_error', `"${body.model}" is not offered for planning`);
      }
      const reason = fixture.unreachable?.[body.model];
      if (reason) {
        return problem(
          422,
          'model_unreachable',
          `model "${body.model}" is not reachable for the planner: ${reason}`,
        );
      }
      const previousModel = row.model;
      const now = new Date().toISOString();
      row.model = body.model;
      row.updatedAt = now;
      row.updatedByCoreUserId = body.actorCoreUserId ?? null;
      row.reachable = true;
      row.lastProbeAt = now;
      row.lastProbeError = null;
      writeFixture(fixture);
      return {
        statusCode: 200,
        data: { audience: row.audience, previousModel, model: row.model, updatedAt: now },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({ path: isListPath, method: 'GET' })
    .reply<object>(() => {
      const fixture = readFixture();
      if (fixture.unavailable) return problem(503, 'upstream_unavailable', 'motir-ai is down');
      return { statusCode: 200, data: listToWire(fixture), responseOptions: json };
    })
    .persist();

  pool
    .intercept({ path: isListPath, method: 'PUT' })
    .reply<object>((req) => {
      const fixture = readFixture();
      if (fixture.unavailable) return problem(503, 'upstream_unavailable', 'motir-ai is down');
      let body: { action?: string; model?: string; actorCoreUserId?: string } = {};
      try {
        body = JSON.parse(String(req.body ?? '{}')) as typeof body;
      } catch {
        return problem(400, 'validation_error', 'body is not JSON');
      }
      const { action, model, actorCoreUserId } = body;
      if ((action !== 'add' && action !== 'remove') || !model || !actorCoreUserId) {
        return problem(400, 'validation_error', 'expected { action, model, actorCoreUserId }');
      }
      const list = listOf(fixture);
      if (action === 'add') {
        if (!fixture.offered.some((m) => m.id === model)) {
          const why = REASON_TEXT[fixture.notQualified?.[model] ?? 'not_servable'];
          return problem(
            400,
            'validation_error',
            `model "${model}" cannot be allowed for planning: ${why}`,
          );
        }
        if (!list.some((e) => e.model === model)) {
          list.push({
            model,
            addedByCoreUserId: actorCoreUserId,
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        if (model === FALLBACK) {
          return problem(
            400,
            'validation_error',
            `model "${model}" is the planner's fallback and must stay on the planning-model list`,
          );
        }
        const inUse = fixture.settings.filter((s) => s.model === model).map((s) => s.audience);
        if (inUse.length > 0) {
          return problem(
            400,
            'validation_error',
            `model "${model}" is the planning model of: ${inUse.join(', ')} — set those audiences to another model first`,
          );
        }
        const at = list.findIndex((e) => e.model === model);
        if (at !== -1) list.splice(at, 1);
      }
      fixture.list = list;
      writeFixture(fixture);
      return { statusCode: 200, data: listToWire(fixture), responseOptions: json };
    })
    .persist();
}
