import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintJobToken, verifyJobToken } from '@/lib/ai/jobToken';
import { POST as refreshPOST } from '@/app/api/internal/ai/job-token/refresh/route';

// MOTIR-3288 — the renewal endpoint, through the REAL route handler.
//
// The defect it closes: the job token is minted at SUBMIT and spent at the
// WRITE-BACK, so queue wait + run time share one 15-minute budget. Three real
// planning jobs did their LLM work, were billed for it, and then failed at the
// append with `token_invalid`.
//
// The fix is renewal rather than a longer TTL, so the tests that matter here are
// the ones pinning what renewal must NOT become: a way to widen scope, and a way
// to revive a dead token.

const SERVICE_SECRET = 'core-callback-secret-test';
const CLAIMS = { userId: 'user_1', workspaceId: 'ws_1', projectId: 'pj_1' };

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/internal/ai/job-token/refresh', {
    method: 'POST',
    headers,
  });
}

function authed(token: string): Request {
  return req({ authorization: `Bearer ${SERVICE_SECRET}`, 'x-motir-job-token': token });
}

beforeEach(() => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/internal/ai/job-token/refresh (MOTIR-3288)', () => {
  it('exchanges a live token for a new window carrying the same identity', async () => {
    const original = mintJobToken({ ...CLAIMS, ttlSeconds: 60 });
    const res = await refreshPOST(authed(original));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { token: string; exp: number };
    const renewed = verifyJobToken(body.token);
    expect(renewed).not.toBeNull();
    expect(renewed!.sub).toBe('user_1');
    expect(renewed!.workspaceId).toBe('ws_1');
    expect(renewed!.projectId).toBe('pj_1');

    // The window genuinely moved — this is the whole point.
    expect(verifyJobToken(original)!.exp).toBeLessThan(renewed!.exp);
    // And the advertised expiry is the one the verifier will enforce, not a
    // number the handler computed separately.
    expect(body.exp).toBe(renewed!.exp);
  });

  it('REFUSES an expired token — renewal must not revive a dead credential', async () => {
    // The security property the short TTL is bought for. If a lapsed token could
    // be refreshed, the TTL would be unbounded in practice and a leaked token
    // would be permanent. The holder's obligation is to renew BEFORE expiry.
    const dead = mintJobToken({ ...CLAIMS, ttlSeconds: -1 });
    const res = await refreshPOST(authed(dead));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('token_invalid');
    // And it says WHY, so a job that renewed too late learns that it was late.
    expect(body.error).toMatch(/EXPIRED at/);
  });

  it('REFUSES without the service bearer — a leaked job token alone cannot renew', async () => {
    const live = mintJobToken(CLAIMS);
    const res = await refreshPOST(req({ 'x-motir-job-token': live }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('service_unauthorized');
  });

  it('REFUSES a forged token even with a valid bearer', async () => {
    const token = mintJobToken(CLAIMS);
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, sub: 'attacker', iat: 0, exp: 9_999_999_999 }),
    ).toString('base64url');
    const res = await refreshPOST(authed(`${forged}.${sig}`));
    expect(res.status).toBe(401);
  });

  it('cannot be asked to widen scope — there is no request body to ask with', async () => {
    // A refresh re-derives every claim from the presented token. This pins that
    // a body naming a different user is simply ignored rather than honoured.
    const original = mintJobToken(CLAIMS);
    const res = await refreshPOST(
      new Request('http://localhost/api/internal/ai/job-token/refresh', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': original,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: 'attacker', projectId: 'pj_other' }),
      }),
    );
    expect(res.status).toBe(200);
    const renewed = verifyJobToken((await res.json()).token)!;
    expect(renewed.sub).toBe('user_1');
    expect(renewed.projectId).toBe('pj_1');
  });

  it('keeps the window at fifteen minutes — renewal is not a longer TTL', async () => {
    const res = await refreshPOST(authed(mintJobToken(CLAIMS)));
    const renewed = verifyJobToken((await res.json()).token)!;
    expect(renewed.exp - renewed.iat).toBe(15 * 60);
  });
});
