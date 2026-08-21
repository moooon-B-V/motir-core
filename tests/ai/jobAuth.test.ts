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

  it('rejects an expired job token, and the message NAMES THE CLOCK (MOTIR-3288)', () => {
    // This used to assert /invalid or expired/ — one message for two unrelated
    // faults. That ambiguity is the defect: an expired token reads as a
    // credential misconfiguration, so a debugger goes looking at secrets, when
    // the actual cause is that the job outlived its credential. Three real jobs
    // died this way and the first diagnosis attempt went to auth.
    const token = mintJobToken({ ...claims, ttlSeconds: -1 });
    try {
      authenticateJobRequest(
        req({ authorization: `Bearer ${SECRET}`, 'x-motir-job-token': token }),
      );
      expect.unreachable();
    } catch (err) {
      const e = err as JobAuthError;
      // The access decision is unchanged, and the code stays in the frozen
      // contract (tests/ai/contract.test.ts).
      expect(e.code).toBe('token_invalid');
      // The message must say the credential LAPSED, and when.
      expect(e.message).toMatch(/EXPIRED at \d{4}-\d{2}-\d{2}T/);
      // And it must point at the remedy, so the reader does not conclude the
      // token was wrong rather than old.
      expect(e.message).toMatch(/RENEW/);
    }
  });

  it('distinguishes a FORGED token from an expired one in the message (MOTIR-3288)', () => {
    const token = mintJobToken(claims);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'attacker' })).toString(
      'base64url',
    );
    try {
      authenticateJobRequest(
        req({ authorization: `Bearer ${SECRET}`, 'x-motir-job-token': `${forged}.${sig}` }),
      );
      expect.unreachable();
    } catch (err) {
      const e = err as JobAuthError;
      expect(e.code).toBe('token_invalid');
      expect(e.message).toMatch(/signature/);
      // The clock is NOT the story here, and saying so would send the next
      // reader after a timeout that never happened.
      expect(e.message).not.toMatch(/EXPIRED/);
    }
  });

  it('fails closed when CORE_CALLBACK_SECRET is unset', () => {
    delete process.env['CORE_CALLBACK_SECRET'];
    const token = mintJobToken(claims);
    expect(() =>
      authenticateJobRequest(req({ authorization: 'Bearer anything', 'x-motir-job-token': token })),
    ).toThrowError(JobAuthError);
  });
});
