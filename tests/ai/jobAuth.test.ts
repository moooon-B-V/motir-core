import { describe, it, expect, beforeEach } from 'vitest';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { mintJobToken } from '@/lib/ai/jobToken';

// Pure unit test (no DB): the §4a service bearer + §4b job-token gate.
// BETTER_AUTH_SECRET is set by vitest.config; we set CORE_CALLBACK_SECRET here.

const SECRET = 'core-callback-secret-test';
const claims = { userId: 'user_1', workspaceId: 'ws_1', projectId: 'pj_1' };

beforeEach(() => {
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

function req(headers: Record<string, string>): Request {
  return new Request('http://internal/api/internal/ai/plan-tree', { headers });
}

describe('authenticateJobRequest', () => {
  it('accepts a valid service bearer + job token and returns the acting ctx', () => {
    const token = mintJobToken(claims);
    const auth = authenticateJobRequest(
      req({ authorization: `Bearer ${SECRET}`, 'x-motir-job-token': token }),
    );
    expect(auth.projectId).toBe('pj_1');
    expect(auth.ctx).toEqual({ userId: 'user_1', workspaceId: 'ws_1' });
  });

  it('rejects a missing service bearer with service_unauthorized', () => {
    const token = mintJobToken(claims);
    try {
      authenticateJobRequest(req({ 'x-motir-job-token': token }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JobAuthError);
      expect((err as JobAuthError).code).toBe('service_unauthorized');
      expect((err as JobAuthError).httpStatus).toBe(401);
    }
  });

  it('rejects a wrong service bearer', () => {
    const token = mintJobToken(claims);
    expect(() =>
      authenticateJobRequest(req({ authorization: 'Bearer nope', 'x-motir-job-token': token })),
    ).toThrowError(JobAuthError);
  });

  it('rejects a missing job token with token_invalid', () => {
    try {
      authenticateJobRequest(req({ authorization: `Bearer ${SECRET}` }));
      expect.unreachable();
    } catch (err) {
      expect((err as JobAuthError).code).toBe('token_invalid');
    }
  });

  it('rejects an expired job token', () => {
    const token = mintJobToken({ ...claims, ttlSeconds: -1 });
    expect(() =>
      authenticateJobRequest(
        req({ authorization: `Bearer ${SECRET}`, 'x-motir-job-token': token }),
      ),
    ).toThrowError(/invalid or expired/);
  });

  it('fails closed when CORE_CALLBACK_SECRET is unset', () => {
    delete process.env['CORE_CALLBACK_SECRET'];
    const token = mintJobToken(claims);
    expect(() =>
      authenticateJobRequest(req({ authorization: 'Bearer anything', 'x-motir-job-token': token })),
    ).toThrowError(JobAuthError);
  });
});
