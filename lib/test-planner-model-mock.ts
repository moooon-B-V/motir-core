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
}

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

function toWire(fixture: PlannerModelFixture) {
  const offeredIds = new Set(fixture.offered.map((m) => m.id));
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
    offered: fixture.offered,
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
      if (!fixture.offered.some((m) => m.id === body.model)) {
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
}
