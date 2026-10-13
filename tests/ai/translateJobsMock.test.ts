import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import type { Tenant } from '@/lib/ai/types';
import type { AiJobsFixture, TranslateJobOutcome } from '@/lib/test-ai-jobs-mock';

// The in-repo motir-ai mock's `translate` arm (Story MOTIR-7735 · MOTIR-8119),
// crossed on the WIRE by the REAL client: `requestTranslation` with its real
// `submitJob` / `getJob`, the undici intercept the acceptance lane installs, and
// only the clock replaced (so the hung job's deadline passes without waiting).
// It proves the lane can script all four outcomes the door branches on.

const ORIGIN = 'http://motir-ai.translate-mock.test';
let fixturePath: string;
let agent: MockAgent;

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-translate-mock-')), 'jobs.json');
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

const { requestTranslation, TRANSLATE_POLL_INTERVAL_MS } = await import('@/lib/ai/translateClient');
const { getJob, submitJob } = await import('@/lib/ai/motirAiClient');

// An org with no row: its switches evaluate as "no organization", which the
// submit's kill-switch check lets through — nothing here is about the flags.
const tenant: Tenant = {
  organizationId: 'org-translate-mock-none',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  projectKey: 'ACME',
};
const fields = [
  { fieldRef: 'title', text: 'Der Titel' },
  { fieldRef: 'description', text: 'Die Beschreibung' },
];

function declare(translate: TranslateJobOutcome[]): void {
  writeFileSync(fixturePath, JSON.stringify({ translate } satisfies AiJobsFixture));
}

function translate(deadlineMs?: number) {
  let clock = 0;
  return requestTranslation(
    { tenant, actor: { userId: 'user-1' }, targetLanguage: 'en', fields, deadlineMs },
    {
      submitJob,
      getJob,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  );
}

const submitted = () =>
  (JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture).submitted ?? [];

describe('the jobs mock — translate', () => {
  it('ok by default: echoes each field sent, tagged with the target language', async () => {
    expect(await translate()).toEqual({
      status: 'ok',
      translations: [
        { fieldRef: 'title', text: '[en] Der Titel' },
        { fieldRef: 'description', text: '[en] Die Beschreibung' },
      ],
    });
    expect(submitted()).toMatchObject([
      { kind: 'translate', translate: { targetLanguage: 'en', fields } },
    ]);
  });

  it('ok with the declared translations', async () => {
    declare([
      {
        translations: [
          { fieldRef: 'title', text: 'The title' },
          { fieldRef: 'description', text: 'The description' },
        ],
      },
    ]);
    expect(await translate()).toMatchObject({
      status: 'ok',
      translations: [{ text: 'The title' }, { text: 'The description' }],
    });
  });

  it('no_credit when the submit is refused out of credits', async () => {
    declare([{ submit: 'out_of_credits' }]);
    expect(await translate()).toEqual({ status: 'no_credit' });
    expect(submitted()).toMatchObject([{ kind: 'translate', refused: true }]);
  });

  it('failed when the job is declared failed', async () => {
    declare([{ status: 'failed' }]);
    expect(await translate()).toEqual({ status: 'failed', reason: 'job_failed' });
  });

  it('failed: invalid_reply when the declared reply misses a field', async () => {
    declare([{ translations: [{ fieldRef: 'title', text: 'The title' }] }]);
    expect(await translate()).toEqual({ status: 'failed', reason: 'invalid_reply' });
  });

  it('timeout when the job never finishes', async () => {
    declare([{ status: 'running' }]);
    expect(await translate(TRANSLATE_POLL_INTERVAL_MS * 2)).toEqual({ status: 'timeout' });
  });

  it('consumes the queue in order, the last entry repeating', async () => {
    declare([{ submit: 'out_of_credits' }, {}]);
    expect(await translate()).toEqual({ status: 'no_credit' });
    expect((await translate()).status).toBe('ok');
    expect((await translate()).status).toBe('ok');
  });
});
