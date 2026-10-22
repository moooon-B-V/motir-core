import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import type { Tenant } from '@/lib/ai/types';
import type { AiJobsFixture, AskJobOutcome } from '@/lib/test-ai-jobs-mock';

// The in-repo motir-ai mock's two `ask_project` arms added for Story MOTIR-9216's
// acceptance receipt (MOTIR-9234), crossed on the WIRE by the REAL client
// (`submitJob` / `getJob`) through the undici intercept the acceptance lane
// installs: an ask submit refused out of credits, and a `codeUnreadable` signal
// that names WHICH outage it was. Without them the lane could not reach the
// not-indexed repository or the paywall on an ask, and a spec asserting either
// would have nothing to stand on.

const ORIGIN = 'http://motir-ai.ask-mock.test';
let fixturePath: string;
let agent: MockAgent;

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-ask-mock-')), 'jobs.json');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  agent = new MockAgent();
  agent.disableNetConnect();
  agent.enableNetConnect(/localhost|127\.0\.0\.1/);
  setGlobalDispatcher(agent);
  const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
});

beforeEach(() => writeFileSync(fixturePath, '{}'));

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
});

const { getJob, submitJob } = await import('@/lib/ai/motirAiClient');

// An org with no row: its switches evaluate as "no organization", which the
// submit's kill-switch check lets through — nothing here is about the flags.
const tenant: Tenant = {
  organizationId: 'org-ask-mock-none',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  projectKey: 'ACME',
};

function declare(ask: AskJobOutcome[]): void {
  writeFileSync(fixturePath, JSON.stringify({ ask } satisfies AiJobsFixture));
}

const submitted = () =>
  (JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? [];

const ask = () => submitJob('ask_project', tenant, { prompt: 'how?' }, { userId: 'user-1' });

describe('the ask arms of the jobs mock (MOTIR-9234)', () => {
  it('refuses an ask submit declared out of credits with the client’s typed error, and takes the next', async () => {
    declare([
      { intent: 'ask', submit: 'out_of_credits' },
      { intent: 'ask', answer: 'Here.' },
    ]);

    await expect(ask()).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
    const { jobId } = await ask();

    expect(submitted()).toEqual([
      expect.objectContaining({ kind: 'ask_project', refused: true }),
      expect.objectContaining({ kind: 'ask_project', jobId }),
    ]);
    expect(submitted()[0]!.jobId).toBeUndefined();
    const job = await getJob(jobId, 'proj-1');
    expect(job.result).toMatchObject({ ask: { intent: 'ask', answer: 'Here.' } });
  });

  it.each([
    [true, 'snapshot_integrity'],
    ['hydrate_failed', 'hydrate_failed'],
    ['not_indexed', 'not_indexed'],
  ] as const)('codeUnreadable %s settles with the signal naming %s', async (declared, reason) => {
    declare([{ intent: 'ask', answer: 'Without the code.', codeUnreadable: declared }]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    expect(job.result).toMatchObject({
      ask: { intent: 'ask', answer: 'Without the code.' },
      codeUnreadable: { halt: 'code_unreadable', repoRef: 'acme/web', reason },
    });
  });

  it('an ask with neither arm declared is unchanged: accepted, no signal', async () => {
    declare([{ intent: 'ask', answer: 'Plain.' }]);
    const { jobId } = await ask();

    const job = await getJob(jobId, 'proj-1');

    expect(submitted()).toEqual([expect.objectContaining({ kind: 'ask_project', jobId })]);
    expect(job.result).toEqual({ ask: { intent: 'ask', answer: 'Plain.', citations: [] } });
  });
});
