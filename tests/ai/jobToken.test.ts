import { describe, it, expect } from 'vitest';
import { mintJobToken, verifyJobToken } from '@/lib/ai/jobToken';

// BETTER_AUTH_SECRET is set by vitest.config.ts's test defaults, so signing works.

const input = { userId: 'user_1', workspaceId: 'ws_1', projectId: 'pj_1' };

describe('job-scoped read-back token', () => {
  it('mints a token that verifies back to its claims', () => {
    const token = mintJobToken(input);
    const claims = verifyJobToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('user_1');
    expect(claims!.workspaceId).toBe('ws_1');
    expect(claims!.projectId).toBe('pj_1');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('does NOT encode a jobId (minted before motir-ai assigns one)', () => {
    const claims = verifyJobToken(mintJobToken(input))!;
    expect(claims).not.toHaveProperty('jobId');
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const token = mintJobToken(input);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...input, sub: 'attacker' })).toString('base64url');
    expect(verifyJobToken(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = mintJobToken({ ...input, ttlSeconds: -1 });
    expect(verifyJobToken(token)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyJobToken('garbage')).toBeNull();
    expect(verifyJobToken('')).toBeNull();
    expect(verifyJobToken('a.b.c')).toBeNull();
  });
});
