import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitJob, getJob, parseSseFrame, type RequestActor } from '@/lib/ai/motirAiClient';
import { verifyJobToken } from '@/lib/ai/jobToken';
import {
  MotirAiConfigError,
  MotirAiBadRequestError,
  MotirAiUnavailableError,
  MotirAiJobNotFoundError,
} from '@/lib/ai/errors';

const tenant = {
  organizationId: 'org_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  projectKey: 'MOTIR',
};
const actor: RequestActor = { userId: 'user_1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

beforeEach(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('config fail-fast', () => {
  it('throws MotirAiConfigError when MOTIR_AI_URL is unset', async () => {
    delete process.env['MOTIR_AI_URL'];
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(MotirAiConfigError);
  });

  it('throws MotirAiConfigError when the service token is unset', async () => {
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
    await expect(getJob('job_1')).rejects.toBeInstanceOf(MotirAiConfigError);
  });
});

describe('submitJob', () => {
  it('posts a valid v1 envelope with a fresh job-scoped token and returns the jobId', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ jobId: 'job_42', status: 'queued' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const { jobId } = await submitJob('noop', tenant, { prompt: 'hi' }, actor);
    expect(jobId).toBe('job_42');

    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(reqUrl).toBe('https://ai.example.test/v1/jobs');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-token');

    const body = JSON.parse(init.body);
    expect(body.envelopeVersion).toBe('v1');
    expect(body.jobKind).toBe('noop');
    expect(body.tenant).toEqual(tenant);
    expect(body.context).toEqual({ prompt: 'hi' });
    // the minted read-back token verifies and is scoped to the actor + project
    const claims = verifyJobToken(body.readBackToken);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('user_1');
    expect(claims!.projectId).toBe('pj_1');
  });

  it('maps a 400 problem+json to MotirAiBadRequestError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'bad', status: 400, code: 'validation_error', detail: 'nope' },
            400,
          ),
        ),
    );
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });

  it('maps a network failure to MotirAiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(submitJob('noop', tenant, {}, actor)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('getJob', () => {
  it('returns a succeeded view with the result and no error', async () => {
    const result = {
      envelopeVersion: 'v1',
      jobKind: 'noop',
      planDelta: { operations: [] },
      summary: 'ok',
      usage: { model: null, inputTokens: 0, outputTokens: 0 },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ jobId: 'job_1', status: 'succeeded', result, error: null }),
        ),
    );
    const view = await getJob('job_1');
    expect(view.status).toBe('succeeded');
    expect(view.result).toEqual(result);
    expect(view.error).toBeNull();
  });

  it('maps a failed job error into a typed error on the view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobId: 'job_1',
          status: 'failed',
          result: null,
          error: { type: 't', title: 'failed', status: 500, code: 'ai_job_failed', detail: 'boom' },
        }),
      ),
    );
    const view = await getJob('job_1');
    expect(view.status).toBe('failed');
    expect(view.error).toBeInstanceOf(MotirAiUnavailableError);
  });

  it('throws MotirAiJobNotFoundError on a 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { type: 't', title: 'nf', status: 404, code: 'not_found', jobId: 'job_x' },
            404,
          ),
        ),
    );
    await expect(getJob('job_x')).rejects.toBeInstanceOf(MotirAiJobNotFoundError);
  });
});

describe('parseSseFrame', () => {
  it('parses an event + JSON data frame', () => {
    const ev = parseSseFrame('event: status\ndata: {"jobId":"job_1","status":"running"}');
    expect(ev).toEqual({ event: 'status', data: { jobId: 'job_1', status: 'running' } });
  });

  it('defaults the event name and keeps non-JSON data as a string', () => {
    expect(parseSseFrame('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('returns null for a comment-only / dataless frame', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: status')).toBeNull();
  });
});
