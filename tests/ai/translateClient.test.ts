import { describe, expect, it, vi } from 'vitest';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiJobFailedError,
  MotirAiOutOfCreditsError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
  type JobView,
} from '@/lib/ai/errors';
import {
  TRANSLATE_POLL_INTERVAL_MS,
  requestTranslation,
  type TranslateClientDeps,
} from '@/lib/ai/translateClient';
import type { Tenant } from '@/lib/ai/types';
import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';

// `requestTranslation` (Story MOTIR-7735 · MOTIR-8119) with every seam stubbed —
// no network, no database. What it proves is the MAPPING: whatever the boundary
// produces, the door sees one of `ok` / `no_credit` / `failed` / `timeout`, and
// only a programming error escapes as a throw.

const tenant: Tenant = {
  organizationId: 'org-1',
  isMeta: false,
  internalBilling: false,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  projectKey: 'ACME',
};
const actor = { userId: 'user-1' };
const fields = [
  { fieldRef: 'title', text: 'Der Titel' },
  { fieldRef: 'description', text: 'Die Beschreibung' },
];
const good = [
  { fieldRef: 'description', text: 'The description' },
  { fieldRef: 'title', text: 'The title' },
];

function view(partial: Partial<JobView>): JobView {
  return { jobId: 'job-1', status: 'succeeded', result: null, error: null, ...partial };
}

function succeeded(translations: unknown): JobView {
  return view({
    result: {
      envelopeVersion: 'v1',
      jobKind: 'translate',
      summary: '',
      usage: { model: null, inputTokens: 0, outputTokens: 0 },
      translations,
    },
  });
}

/** Deps whose clock only moves when `sleep` is called. */
function makeDeps(views: (JobView | Error)[], overrides: Partial<TranslateClientDeps> = {}) {
  let clock = 1_000;
  const queue = [...views];
  const deps = {
    submitJob: vi.fn(async () => ({ jobId: 'job-1' })),
    getJob: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next;
    }),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: vi.fn(() => clock),
    ...overrides,
  };
  return deps;
}

const run = (deps: TranslateClientDeps, deadlineMs?: number) =>
  requestTranslation({ tenant, actor, targetLanguage: 'en', fields, deadlineMs }, deps);

describe('requestTranslation — the submit', () => {
  it('submits exactly ONE translate job with the tenant, the actor and the fields in order', async () => {
    const deps = makeDeps([succeeded(good)]);
    await run(deps);
    expect(deps.submitJob).toHaveBeenCalledTimes(1);
    expect(deps.submitJob).toHaveBeenCalledWith(
      'translate',
      tenant,
      { translate: { targetLanguage: 'en', fields } },
      actor,
    );
    expect(deps.getJob).toHaveBeenCalledWith('job-1', 'proj-1');
  });
});

describe('requestTranslation — ok', () => {
  it('returns the translations in the order SENT', async () => {
    const deps = makeDeps([
      view({ status: 'queued' }),
      view({ status: 'running' }),
      succeeded(good),
    ]);
    expect(await run(deps)).toEqual({
      status: 'ok',
      translations: [
        { fieldRef: 'title', text: 'The title' },
        { fieldRef: 'description', text: 'The description' },
      ],
    });
    expect(deps.getJob).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledWith(TRANSLATE_POLL_INTERVAL_MS);
  });

  it.each([
    ['a missing fieldRef', [good[0]]],
    ['an extra fieldRef', [...good, { fieldRef: 'x', text: 'X' }]],
    ['a duplicate fieldRef', [...good, good[0]]],
    ['an empty text', [good[0], { fieldRef: 'title', text: '' }]],
    ['no translations at all', undefined],
  ])('a succeeded job with %s is failed: invalid_reply, with no translations', async (_l, t) => {
    expect(await run(makeDeps([succeeded(t)]))).toEqual({
      status: 'failed',
      reason: 'invalid_reply',
    });
  });

  it('a succeeded job with no result at all is failed: invalid_reply', async () => {
    expect(await run(makeDeps([view({ result: null })]))).toEqual({
      status: 'failed',
      reason: 'invalid_reply',
    });
  });
});

describe('requestTranslation — no_credit', () => {
  it('when submitJob throws MotirAiOutOfCreditsError', async () => {
    const deps = makeDeps([succeeded(good)], {
      submitJob: vi.fn(async () => {
        throw new MotirAiOutOfCreditsError('balance 0');
      }),
    });
    expect(await run(deps)).toEqual({ status: 'no_credit' });
    expect(deps.getJob).not.toHaveBeenCalled();
  });

  it("when a failed job's error is MotirAiOutOfCreditsError", async () => {
    const deps = makeDeps([
      view({ status: 'failed', error: new MotirAiOutOfCreditsError('balance 0') }),
    ]);
    expect(await run(deps)).toEqual({ status: 'no_credit' });
  });
});

describe('requestTranslation — failed', () => {
  const secret = 'connect ECONNREFUSED 10.0.0.7:8080 internal-host';

  it.each([
    ['a failed job', view({ status: 'failed', error: new MotirAiUnavailableError(secret) })],
    ['a canceled job', view({ status: 'canceled' })],
  ])('%s is failed: job_failed', async (_l, v) => {
    const result = await run(makeDeps([v]));
    expect(result).toEqual({ status: 'failed', reason: 'job_failed' });
    expect(JSON.stringify(result)).not.toContain('10.0.0.7');
  });

  it.each([
    ['MotirAiUnavailableError', new MotirAiUnavailableError(secret), 'unavailable'],
    ['MotirAiJobFailedError', new MotirAiJobFailedError(secret, {} as never), 'job_failed'],
    ['MotirAiBadRequestError', new MotirAiBadRequestError(secret), 'rejected'],
    ['MotirAiConfigError', new MotirAiConfigError(secret), 'misconfigured'],
    ['MotirAiUnauthorizedError', new MotirAiUnauthorizedError(secret), 'misconfigured'],
  ])('%s from the submit maps to its reason without the detail', async (_l, err, reason) => {
    const deps = makeDeps([succeeded(good)], {
      submitJob: vi.fn(async () => {
        throw err;
      }),
    });
    const result = await run(deps);
    expect(result).toEqual({ status: 'failed', reason });
    expect(JSON.stringify(result)).not.toContain('internal-host');
  });

  it('MotirAiUnavailableError from a POLL is failed: unavailable', async () => {
    const deps = makeDeps([view({ status: 'running' }), new MotirAiUnavailableError(secret)]);
    expect(await run(deps)).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  it('a flag-off organisation is failed: disabled, not a server error', async () => {
    const deps = makeDeps([succeeded(good)], {
      submitJob: vi.fn(async () => {
        throw new OrgFeatureDisabledError('org-1', 'ai_planning');
      }),
    });
    expect(await run(deps)).toEqual({ status: 'failed', reason: 'disabled' });
  });

  it('an unknown future status ends the call at once as failed, without waiting', async () => {
    const deps = makeDeps([view({ status: 'paused' as never })]);
    expect(await run(deps)).toEqual({ status: 'failed', reason: 'job_failed' });
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe('requestTranslation — timeout', () => {
  it('stops at the deadline and never polls after it', async () => {
    const deps = makeDeps([view({ status: 'running' })]);
    const deadlineMs = TRANSLATE_POLL_INTERVAL_MS * 3 + 100;
    expect(await run(deps, deadlineMs)).toEqual({ status: 'timeout' });
    // Polls at t=0, 1×, 2×, 3× the interval; the last sleep is the 100ms
    // remainder, after which the deadline has passed and nothing is read.
    expect(deps.getJob).toHaveBeenCalledTimes(4);
    expect(vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([
      TRANSLATE_POLL_INTERVAL_MS,
      TRANSLATE_POLL_INTERVAL_MS,
      TRANSLATE_POLL_INTERVAL_MS,
      100,
    ]);
    expect(deps.now()).toBe(1_000 + deadlineMs);
  });

  it('a queued job past the deadline is a timeout too', async () => {
    const deps = makeDeps([view({ status: 'queued' })]);
    expect(await run(deps, 10)).toEqual({ status: 'timeout' });
    expect(deps.getJob).toHaveBeenCalledTimes(1);
  });
});

describe('requestTranslation — a programming error', () => {
  it('a non-MotirAiError from the submit is rethrown', async () => {
    const bug = new TypeError('boom');
    const deps = makeDeps([succeeded(good)], {
      submitJob: vi.fn(async () => {
        throw bug;
      }),
    });
    await expect(run(deps)).rejects.toBe(bug);
  });

  it('a non-MotirAiError from a poll is rethrown', async () => {
    const bug = new RangeError('boom');
    await expect(run(makeDeps([bug]))).rejects.toBe(bug);
  });
});
