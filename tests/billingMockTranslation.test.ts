import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import type { AiJobsFixture, SubmittedJob, TranslateJobOutcome } from '@/lib/test-ai-jobs-mock';
import type { BillingFixture, BillingFixtureEntry } from '@/lib/test-billing-mock';
import { adminDb } from './helpers/adminDb';

// The billing boundary mock's `translation` usage block (Story MOTIR-7735 ·
// MOTIR-8459), crossed on the WIRE by the shipped read: the real
// `getOrgUsage` client, the real `aiUsageService.getUsage` DTO mapping and the
// usage page's own view-model, with only motir-ai replaced by the two in-repo
// seams the acceptance lane installs. Three arms: a scripted entry is reported
// verbatim, an explicit `null` omits the key (UNAVAILABLE), and an absent entry
// derives the block from the jobs mock's succeeded `translate` jobs.

const ORIGIN = 'http://motir-ai.billing-translation.test';
let billingPath: string;
let jobsPath: string;
let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-billing-translation-'));
  billingPath = join(dir, 'billing.json');
  jobsPath = join(dir, 'jobs.json');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_BILLING_FIXTURE_PATH', billingPath);
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', jobsPath);
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  const { installBillingBoundaryMock } = await import('@/lib/test-billing-mock');
  installBillingBoundaryMock(agent);
});

beforeEach(async () => {
  await truncateAuthTables();
  writeFileSync(billingPath, '{}');
  writeFileSync(jobsPath, '{}');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const { getOrgUsage } = await import('@/lib/ai/motirAiClient');
const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { TRANSLATION_CREDITS_PER_JOB } = await import('@/lib/test-billing-mock');
const { translationUsageFigures } =
  await import('@/app/(authed)/settings/organization/usage/_components/translationUsage');
const { createTestWorkspace } = await import('./fixtures');
const { truncateAuthTables } = await import('./helpers/db');

const K = TRANSLATION_CREDITS_PER_JOB;

const BASE_ENTRY: BillingFixtureEntry = {
  balance: 500,
  tier: null,
  subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
};

function setEntries(entries: BillingFixture): void {
  writeFileSync(billingPath, JSON.stringify(entries));
}

/** The jobs fixture as the jobs mock leaves it: a queue, and the submits it recorded. */
function setJobs(translate: TranslateJobOutcome[], submits: boolean[]): void {
  const submitted: SubmittedJob[] = submits.map((refused, i) =>
    refused ? { kind: 'translate', refused } : { kind: 'translate', jobId: `job_translate_${i}` },
  );
  writeFileSync(jobsPath, JSON.stringify({ translate, submitted } satisfies AiJobsFixture));
}

/** A real organisation and its owner, so the shipped service read runs. */
async function org() {
  const { workspace, owner } = await createTestWorkspace();
  return { orgId: workspace.organizationId, ownerId: owner.id };
}

/** The shipped read: the boundary → `OrgUsageDTO.translation` → the page's variant. */
async function readUsage(o: { orgId: string; ownerId: string }) {
  const dto = await aiUsageService.getUsage({ organizationId: o.orgId, actorUserId: o.ownerId });
  return { translation: dto.translation, variant: translationUsageFigures(dto).variant };
}

/** The raw reply body, so a test can see a key that is absent rather than null. */
const wire = (orgId: string) => getOrgUsage({ coreOrganizationId: orgId, scope: 'org' });

describe('the three arms of the entry field', () => {
  it('a scripted block is reported verbatim (spend)', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY, translation: { totalSpend: 12, monthSpend: 4 } } });

    expect((await wire(o.orgId)).translation).toEqual({ totalSpend: 12, monthSpend: 4 });
    expect(await readUsage(o)).toEqual({
      translation: { totalSpend: 12, monthSpend: 4 },
      variant: 'spend',
    });
  });

  it('an explicit null omits the key: null in the DTO, unavailable — never none, never zero', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY, translation: null } });
    setJobs([], [false]);

    expect('translation' in (await wire(o.orgId))).toBe(false);
    expect(await readUsage(o)).toEqual({ translation: null, variant: 'unavailable' });
  });

  it('absent: three succeeded translate jobs derive 3k / 3k (spend)', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY } });
    setJobs([{ status: 'succeeded' }], [false, false, false]);

    expect(await readUsage(o)).toEqual({
      translation: { totalSpend: 3 * K, monthSpend: 3 * K },
      variant: 'spend',
    });
  });
});

describe('what the derivation counts', () => {
  it('a refused submit counts zero: 0 / 0 is reported, and reads none', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY } });
    setJobs([{ submit: 'out_of_credits' }], [true]);

    expect(await readUsage(o)).toEqual({
      translation: { totalSpend: 0, monthSpend: 0 },
      variant: 'none',
    });
  });

  it.each(['failed', 'running'] as const)('a %s job is not spend: 0 / 0', async (status) => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY } });
    setJobs([{ status }], [false]);

    expect((await readUsage(o)).translation).toEqual({ totalSpend: 0, monthSpend: 0 });
  });

  it('the queue’s last entry repeats: one refusal, then two successes count two', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY } });
    setJobs([{ submit: 'out_of_credits' }, {}], [true, false, false]);

    expect((await readUsage(o)).translation).toEqual({ totalSpend: 2 * K, monthSpend: 2 * K });
  });

  it('the jobs record the count reads is the mock’s own (unchanged by the read)', async () => {
    const o = await org();
    setEntries({});
    setJobs([{}], [false]);
    const before = readFileSync(jobsPath, 'utf8');

    expect((await wire(o.orgId)).translation).toEqual({ totalSpend: K, monthSpend: K });
    expect(readFileSync(jobsPath, 'utf8')).toBe(before);
  });
});

describe('the rest of the reply', () => {
  it('a translation-only entry leaves every other block as declared — none of them', async () => {
    const o = await org();
    setEntries({ [o.orgId]: { ...BASE_ENTRY, translation: { totalSpend: 1, monthSpend: 1 } } });
    const body = await wire(o.orgId);

    expect(body.balance).toBe(500);
    expect(body.tier).toBeNull();
    expect(body.recentRuns).toEqual({ runs: [], page: 1, pageSize: 20, total: 0 });
    expect(body.monthlyHistory).toEqual([]);
    expect(body.perModel).toEqual([]);
    for (const key of ['search', 'searchRuns', 'agentMachine', 'agentStorage']) {
      expect(key in body, key).toBe(false);
    }
  });

  it('declared sibling blocks are reported exactly as the entry gives them', async () => {
    const o = await org();
    const search = { totalSpend: 40, monthSpend: 12 };
    setEntries({
      [o.orgId]: { ...BASE_ENTRY, search, agents: { machine: 7, storage: 2 }, translation: null },
    });
    const body = await wire(o.orgId);

    expect(body.search).toEqual(search);
    expect(body.agentMachine).toEqual({ totalSpend: 7, monthSpend: 7 });
    expect(body.agentStorage).toEqual({ totalSpend: 2, monthSpend: 2 });
    expect('translation' in body).toBe(false);
  });

  it('two orgs in one fixture each get their own arm, with no bleed', async () => {
    const derived = await org();
    const scripted = await org();
    setEntries({
      [derived.orgId]: { ...BASE_ENTRY },
      [scripted.orgId]: { ...BASE_ENTRY, translation: { totalSpend: 90, monthSpend: 30 } },
    });
    setJobs([{}], [false, false]);

    expect((await wire(derived.orgId)).translation).toEqual({
      totalSpend: 2 * K,
      monthSpend: 2 * K,
    });
    expect((await wire(scripted.orgId)).translation).toEqual({ totalSpend: 90, monthSpend: 30 });
  });
});
