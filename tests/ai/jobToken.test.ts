import { describe, it, expect } from 'vitest';
import { inspectJobToken, mintJobToken, refreshJobToken, verifyJobToken } from '@/lib/ai/jobToken';

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

  // ── MOTIR-3288 ────────────────────────────────────────────────────────────
  // The token's lifetime has to track the WORK, not the wall clock at submit.
  // Three real jobs died at the write-back because it did not.

  describe('a verdict distinguishes EXPIRED from FORGED (MOTIR-3288)', () => {
    it('reports `expired` with the moment it lapsed, so the message can name the clock', () => {
      const token = mintJobToken({ ...input, ttlSeconds: -1 });
      const verdict = inspectJobToken(token);
      expect(verdict.ok).toBe(false);
      // The discriminated shape is the point: an access decision collapses these
      // to "no", and the operator-facing message must not.
      if (verdict.ok || verdict.reason !== 'expired')
        throw new Error('expected an expired verdict');
      expect(verdict.expiredAt).toBe(verdict.claims.exp);
      expect(verdict.claims.sub).toBe('user_1');
    });

    it('reports `bad_signature` for a forged payload — NOT `expired`', () => {
      const token = mintJobToken(input);
      const [, sig] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...input, sub: 'attacker' })).toString(
        'base64url',
      );
      const verdict = inspectJobToken(`${forged}.${sig}`);
      expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('reports `malformed` for junk', () => {
      expect(inspectJobToken('garbage')).toEqual({ ok: false, reason: 'malformed' });
      expect(inspectJobToken('')).toEqual({ ok: false, reason: 'malformed' });
    });

    it('checks the signature BEFORE the expiry, so `expiredAt` is never attacker-chosen', () => {
      // A forged payload claiming a past expiry must come back `bad_signature`.
      // If the order were reversed we would report an attacker's `expiredAt` as
      // though it were ours.
      const forged = Buffer.from(JSON.stringify({ ...input, iat: 0, exp: 1 })).toString(
        'base64url',
      );
      expect(inspectJobToken(`${forged}.nonsense`)).toEqual({ ok: false, reason: 'bad_signature' });
    });
  });

  describe('renewal keeps the window short while the work runs (MOTIR-3288)', () => {
    it('mints a NEW window carrying the SAME identity', () => {
      const original = verifyJobToken(mintJobToken({ ...input, ttlSeconds: 1 }))!;
      const renewed = verifyJobToken(refreshJobToken(original))!;
      expect(renewed.sub).toBe(original.sub);
      expect(renewed.workspaceId).toBe(original.workspaceId);
      expect(renewed.projectId).toBe(original.projectId);
      expect(renewed.exp).toBeGreaterThan(original.exp);
    });

    it('cannot widen scope — every claim is re-derived from the presented token', () => {
      const claims = verifyJobToken(mintJobToken(input))!;
      const renewed = verifyJobToken(refreshJobToken(claims))!;
      // No parameter exists by which a caller could ask for a different user,
      // workspace or project; this pins that there is nothing to ask with.
      expect({
        sub: renewed.sub,
        workspaceId: renewed.workspaceId,
        projectId: renewed.projectId,
      }).toEqual({ sub: claims.sub, workspaceId: claims.workspaceId, projectId: claims.projectId });
    });

    it('keeps the DEFAULT window at fifteen minutes — renewal is not a longer TTL', () => {
      // The fix must not quietly become "raise the number", which would spend
      // the blast-radius property the short TTL exists for.
      const claims = verifyJobToken(refreshJobToken(verifyJobToken(mintJobToken(input))!))!;
      expect(claims.exp - claims.iat).toBe(15 * 60);
    });
  });

  describe('the 15-minute boundary, from both sides (MOTIR-3288 AC5)', () => {
    it('a job that finishes INSIDE the window still works untouched', () => {
      // 14m59s of work: the original token is still good, no renewal needed.
      const claims = verifyJobToken(mintJobToken({ ...input, ttlSeconds: 15 * 60 }))!;
      const atFourteenFiftyNine = claims.iat + 14 * 60 + 59;
      expect(claims.exp).toBeGreaterThan(atFourteenFiftyNine);
    });

    it('a job that CROSSES the window survives if it renewed, and dies if it did not', () => {
      // The failure, reproduced: a token minted 19 minutes ago is refused.
      const stale = mintJobToken({ ...input, ttlSeconds: -(4 * 60) });
      expect(verifyJobToken(stale)).toBeNull();

      // The fix: the holder renewed while it worked, so the credential it
      // presents at the write-back was minted recently even though the JOB is
      // nineteen minutes old.
      const identity = { sub: 'user_1', workspaceId: 'ws_1', projectId: 'pj_1', iat: 0, exp: 0 };
      const renewed = verifyJobToken(refreshJobToken(identity));
      expect(renewed).not.toBeNull();
      expect(renewed!.sub).toBe('user_1');
    });
  });
});
