import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_CATALOG, PLAN_CHANGE_KEYS, maxMonthlyPlanCredits } from '@/lib/billing/catalog';
import { adminDb } from './helpers/adminDb';
import {
  CAPTURE_ORIGIN,
  ENGINE_CAPTURE,
  type EngineSample,
} from './fixtures/calculatorEngineCapture';

// The CONTRACT at the calculator's boundary (Story MOTIR-8381 · MOTIR-8640): the
// assembled app-side path — route's service, the shipped motirAiClient leaf,
// problem+json → typed error — driven against a RECORDED WIRE SAMPLE of the
// engine, plus the engine's plan keys against BILLING_CATALOG and the no-literals
// guard over the tab. The only stubbed boundary is the outbound `fetch`.
//
// What this does NOT carry, because the engine does not serve it yet and nothing
// is hand-written to stand in for a capture: an `empty_category` body, the engine's
// own `unavailable` answer, and a `larger_pool` recommendation naming a pool key
// above `max_x2`. The cases that need them are the follow-up of the engine's
// larger-pool story; `calculatorRead.test.ts` covers those mappings on authored
// bodies in the meantime.

const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

const sample = (name: string): EngineSample => {
  const found = ENGINE_CAPTURE.find((s) => s.name === name);
  if (!found) throw new Error(`tests/fixtures/calculatorEngineCapture.ts has no sample "${name}"`);
  return found;
};
/** The engine's JSON, read loosely: every case asserts what it reads. */
type Wire = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const bodyOf = (name: string) => JSON.parse(sample(name).body) as Wire;
const ESTIMATES = ['estimate1', 'estimate2', 'estimate3', 'regularRung', 'overCeiling'];

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  return { organizationId, owner };
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
function replay(s: EngineSample) {
  fetchMock.mockResolvedValueOnce(
    new Response(s.body, { status: s.status, headers: { 'content-type': s.contentType } }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.contract';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['MOTIR_CLOUD', 'MOTIR_BASE_URL', 'MOTIR_AI_URL', 'MOTIR_AI_SERVICE_TOKEN']) {
    delete process.env[k];
  }
});

describe('the capture — provenance', () => {
  it('each sample names its command, origin, date and the versions its answer carries', () => {
    for (const s of ENGINE_CAPTURE) {
      expect(s.command, s.name).toContain(CAPTURE_ORIGIN);
      expect(s.recordedAt, s.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Number.isNaN(Date.parse(s.recordedAt)), s.name).toBe(false);
      expect(() => JSON.parse(s.body), s.name).not.toThrow();
    }
    const rule = bodyOf('categories').categoryRuleVersion;
    for (const name of ESTIMATES) {
      const b = bodyOf(name);
      expect(b.kind, name).toBe('estimate');
      expect(b.version, name).toBe(2);
      expect(b.categoryRuleVersion, name).toBe(rule);
      expect(typeof b.profilesVersion, name).toBe('string');
    }
    expect(sample('validationError')).toMatchObject({
      status: 400,
      contentType: 'application/problem+json',
    });
    expect(bodyOf('validationError').code).toBe('validation_error');
  });

  it('is taken on the category contract — no recorded request carries a lane or a model', () => {
    for (const s of ENGINE_CAPTURE) {
      for (const retired of ['planning', 'running', 'modelIds']) {
        expect(Object.keys(s.request ?? {}), s.name).not.toContain(retired);
      }
    }
    for (const name of ESTIMATES) {
      expect(bodyOf(name), name).not.toHaveProperty('models');
      expect(bodyOf(name), name).not.toHaveProperty('droppedModelIds');
      expect(bodyOf(name).split.categories.length, name).toBe(bodyOf(name).split.count);
    }
  });
});

describe('the request the tab’s inputs become — three cardinalities', () => {
  const modelIds = (bodyOf('categories').categories as Array<{ models: { id: string }[] }>).flatMap(
    (c) => c.models.map((m) => m.id),
  );

  for (const [n, name] of [
    [1, 'estimate1'],
    [2, 'estimate2'],
    [3, 'estimate3'],
  ] as const) {
    it(`${n} categor${n === 1 ? 'y' : 'ies'}: exactly itemsPerMonth, categories and cadence reach the engine`, async () => {
      const { organizationId, owner } = await makeOrg();
      const s = sample(name);
      replay(s);
      await billingService.estimateCalculator({
        organizationId,
        actorUserId: owner.id,
        body: s.request,
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://motir-ai.contract/v1/public/calculator/estimate');
      expect(init?.method).toBe('POST');
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent).toStrictEqual(s.request);
      expect((sent['categories'] as string[]).length).toBe(n);
      expect(Object.keys(sent).sort()).toEqual(['cadence', 'categories', 'itemsPerMonth']);
      const wire = String(init?.body);
      for (const id of modelIds) expect(wire).not.toContain(id);
      expect(wire).not.toContain(organizationId);
    });
  }
});

describe('field for field', () => {
  it.each(ESTIMATES)('%s — the service answers the engine’s body key for key', async (name) => {
    const { organizationId, owner } = await makeOrg();
    const s = sample(name);
    replay(s);
    const out = await billingService.estimateCalculator({
      organizationId,
      actorUserId: owner.id,
      body: s.request,
    });
    expect(out).toStrictEqual(JSON.parse(s.body));
  });

  it('the categories list crosses unaltered', async () => {
    const { organizationId, owner } = await makeOrg();
    replay(sample('categories'));
    await expect(
      billingService.getCalculatorCategories({ organizationId, actorUserId: owner.id }),
    ).resolves.toStrictEqual(JSON.parse(sample('categories').body));
  });

  it('the engine’s real validation_error is a 400 CALCULATOR_REQUEST_INVALID, never the blanket 502', async () => {
    const { organizationId, owner } = await makeOrg();
    // The app's own schema refuses `low > high` first; give the engine a body ours
    // admits so the engine's captured refusal is what answers.
    replay(sample('validationError'));
    await expect(
      billingService.estimateCalculator({
        organizationId,
        actorUserId: owner.id,
        body: { itemsPerMonth: { low: 1, high: 2 }, categories: ['economy'], cadence: 'monthly' },
      }),
    ).rejects.toMatchObject({ code: 'CALCULATOR_REQUEST_INVALID' });
  });
});

// ── the engine's plan keys against the catalog ──────────────────────────────

/** Every plan key the capture names, with the cadence it priced it on. */
function namedPlans() {
  return ESTIMATES.flatMap((name) => {
    const b = bodyOf(name);
    return b.recommendation.planKey
      ? [{ name, cadence: b.cadence as 'annual' | 'monthly', rec: b.recommendation }]
      : [];
  });
}

/** The failure a missing key reports: names the key and the file that owns it. */
function resolve(
  aiPlans: typeof BILLING_CATALOG.aiPlans,
  key: string,
  cadence: 'annual' | 'monthly',
) {
  const entry = aiPlans.find((p) => p.key === key);
  if (!entry)
    throw new Error(
      `the engine names plan "${key}" and lib/billing/catalog.ts has no entry for it`,
    );
  const price = entry.prices?.[cadence];
  if (!entry.name || !price) {
    throw new Error(`lib/billing/catalog.ts entry "${key}" has no name or no ${cadence} price`);
  }
  return { entry, price };
}

describe('plan keys, ladder, ceiling and prices — one source of truth per figure', () => {
  it('every plan key the capture names resolves in the catalog with a name and a price', () => {
    const named = namedPlans();
    expect(named.length).toBeGreaterThan(0);
    for (const { rec, cadence } of named) {
      expect(() => resolve(BILLING_CATALOG.aiPlans, rec.planKey, cadence)).not.toThrow();
    }
    // The capture spans a regular rung and the top rung (an over-ceiling answer).
    expect(new Set(named.map((n) => n.rec.planKey)).size).toBeGreaterThanOrEqual(2);
  });

  it('bites in both directions — a catalog without the named key fails, naming key and file', () => {
    for (const { rec, cadence } of namedPlans()) {
      const without = BILLING_CATALOG.aiPlans.filter((p) => p.key !== rec.planKey);
      expect(() => resolve(without, rec.planKey, cadence)).toThrow(
        new RegExp(`${rec.planKey}.*lib/billing/catalog\\.ts`),
      );
    }
  });

  it('the upgrade order is PLAN_CHANGE_KEYS: no Free, every named key in it, ascending by pool', () => {
    expect(PLAN_CHANGE_KEYS).not.toContain('free');
    for (const { rec } of namedPlans()) expect(PLAN_CHANGE_KEYS).toContain(rec.planKey);
    const pools = PLAN_CHANGE_KEYS.map(
      (k) => BILLING_CATALOG.aiPlans.find((p) => p.key === k)?.allotment?.credits ?? NaN,
    );
    expect(pools).toEqual([...pools].sort((a, b) => a - b));
  });

  it('the ceiling is the largest regular rung’s pool, and the engine reports that one number', () => {
    const regular = BILLING_CATALOG.aiPlans.flatMap((p) =>
      p.prices && p.allotment?.cadence === 'monthly' ? [p.allotment.credits] : [],
    );
    expect(maxMonthlyPlanCredits()).toBe(Math.max(...regular));
    for (const name of ESTIMATES) {
      expect(bodyOf(name).ceiling.credits, name).toBe(maxMonthlyPlanCredits());
    }
    const over = bodyOf('overCeiling').ceiling;
    expect(over.exceeded).toBe(true);
    expect(over.excessCredits).toBeGreaterThan(0);
  });

  it('the engine’s monthlyPriceUsd is the catalog price per month — annual ÷ 12, never printed on Annual', () => {
    for (const { rec, cadence } of namedPlans()) {
      const { price } = resolve(BILLING_CATALOG.aiPlans, rec.planKey, cadence);
      if (cadence === 'annual') {
        expect(rec.monthlyPriceUsd * 12, rec.planKey).toBe(price.amountUsd);
      } else {
        expect(rec.monthlyPriceUsd, rec.planKey).toBe(price.amountUsd);
      }
    }
    // Both cadences were measured, so neither reading is vacuous.
    expect(new Set(namedPlans().map((n) => n.cadence)).size).toBe(2);
  });
});

// ── the no-literals guard ───────────────────────────────────────────────────

const VIEW = 'app/(authed)/settings/organization/billing/_components/CalculatorView.tsx';

/** Comments out: a warning in a comment must not be silenced by being scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** What may not be typed in the tab or its words — derived, never listed here. */
function forbiddenVocabulary() {
  const plans = BILLING_CATALOG.aiPlans;
  const names = plans.map((p) => p.name);
  const pools = plans.flatMap((p) => (p.allotment ? [p.allotment.credits] : []));
  const amounts = plans.flatMap((p) =>
    p.prices ? Object.values(p.prices).map((x) => x.amountUsd) : [],
  );
  const words = [
    ...(
      bodyOf('categories').categories as Array<{ key: string; models: { id: string }[] }>
    ).flatMap((c) => [c.key, ...c.models.map((m) => m.id)]),
  ];
  return { names, pools, amounts, words };
}

/** The problems a piece of tab text has; empty when it is clean. */
function literalsIn(text: string): string[] {
  const { names, pools, amounts, words } = forbiddenVocabulary();
  const found: string[] = [];
  if (/[$€£¥]\s?\d|\d\s?[$€£¥]/.test(text)) found.push('a currency amount');
  for (const n of [...pools, ...amounts]) {
    if (
      n >= 100 &&
      new RegExp(`(^|\\D)${String(n).replace(/(\d)(?=(\d{3})+$)/g, '$1,?')}(\\D|$)`).test(text)
    ) {
      found.push(`the figure ${n}`);
    }
  }
  for (const n of names) if (new RegExp(`\\b${n}\\b`).test(text)) found.push(`the plan name ${n}`);
  for (const w of words) {
    if (new RegExp(`['"\`]${w}['"\`]`, 'i').test(text)) found.push(`the engine word ${w}`);
  }
  return found;
}

describe('the no-literals guard — the tab types no catalog figure and no engine vocabulary', () => {
  it('scans a non-empty file list and a non-empty vocabulary', () => {
    const src = readFileSync(join(process.cwd(), VIEW), 'utf8');
    expect(src.length).toBeGreaterThan(0);
    const v = forbiddenVocabulary();
    for (const list of Object.values(v)) expect(list.length).toBeGreaterThan(0);
  });

  it('the view’s source (comments stripped) carries none of it', () => {
    const src = stripComments(readFileSync(join(process.cwd(), VIEW), 'utf8'));
    expect(literalsIn(src)).toEqual([]);
  });

  it('every billing.calculator.* value, in every locale the billing page keeps, carries none of it', () => {
    const dir = join(process.cwd(), 'messages');
    const files = readdirSync(dir).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));
    expect(files.length).toBeGreaterThan(1);
    const flat = (o: unknown, path = ''): Array<[string, string]> =>
      typeof o === 'string'
        ? [[path, o]]
        : o && typeof o === 'object'
          ? Object.entries(o).flatMap(([k, v]) => flat(v, path ? `${path}.${k}` : k))
          : [];
    for (const f of files) {
      const catalog = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
        billing: { calculator: unknown };
      };
      const values = flat(catalog.billing.calculator);
      expect(values.length, f).toBeGreaterThan(0);
      for (const [key, value] of values) {
        expect(literalsIn(value), `${f} billing.calculator.${key}: ${value}`).toEqual([]);
      }
    }
  });

  it('is not vacuous — a control string with an amount, a pool figure and a plan name is flagged', () => {
    const plan = BILLING_CATALOG.aiPlans.find((p) => p.prices && p.allotment)!;
    const pool = plan.allotment!.credits.toLocaleString('en-US');
    const control = `Get ${plan.name} for $${plan.prices!.monthly.amountUsd} with ${pool} credits`;
    expect(literalsIn(control).length).toBeGreaterThanOrEqual(3);
  });

  it('does not eat its own warnings — the same text in a comment is not flagged', () => {
    const plan = BILLING_CATALOG.aiPlans.find((p) => p.prices && p.allotment)!;
    const warning = `Never type ${plan.name} or $${plan.prices!.monthly.amountUsd}`;
    expect(literalsIn(stripComments(`// ${warning}\nconst x = 1;`))).toEqual([]);
    expect(literalsIn(stripComments(`/* ${warning} */\nconst x = 1;`))).toEqual([]);
    expect(literalsIn(`const s = "${warning}";`).length).toBeGreaterThan(0);
  });
});
