import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  GITHUB_RETURN_SURFACES,
  DEFAULT_RETURN_PATH,
  parseReturnSurfaceId,
  resolveReturnPath,
} from '@/lib/github/returnSurface';
import { decodeInstallState, encodeInstallState } from '@/lib/github/installState';

// Story MOTIR-4669 · MOTIR-4676 — WHERE A GIT CONNECT FLOW RETURNS TO.
//
// The whole security argument of this module is that the return target is an
// ID and never a path, so the tests below are not a sanitiser's tests: there is
// no string to sanitise, and what is asserted is that nothing outside the map
// can name a destination at all. The two shapes an open redirect takes — an
// absolute URL and a protocol-relative one — are asserted by name because they
// are the two a reader will look for.
//
// Pure functions and pure crypto; no I/O, no database.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const NOW = 1_700_000_000;

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the surface registry', () => {
  it('maps every registered id to an in-app path', () => {
    for (const [id, path] of Object.entries(GITHUB_RETURN_SURFACES)) {
      expect(path, `${id} must be a root-relative in-app path`).toMatch(/^\/[a-z0-9-]/i);
      // Root-relative and nothing else: no scheme, no protocol-relative form,
      // no backslash, no userinfo, no traversal.
      expect(path).not.toMatch(/^\/\//);
      expect(path).not.toMatch(/[\\@]/);
      expect(path).not.toContain('..');
      expect(path).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
  });

  it('defaults to the path both routes hard-coded before this card', () => {
    // The compatibility claim in one line: an in-flight round trip that started
    // before the deploy lands exactly where it used to.
    expect(DEFAULT_RETURN_PATH).toBe('/settings/workspace/github');
  });
});

describe('parseReturnSurfaceId — nothing outside the map is a destination', () => {
  it('narrows a registered id', () => {
    expect(parseReturnSurfaceId('projectRepositories')).toBe('projectRepositories');
    expect(parseReturnSurfaceId('organizationGit')).toBe('organizationGit');
  });

  it('refuses an ABSOLUTE URL', () => {
    expect(parseReturnSurfaceId('https://evil.example/steal')).toBeNull();
    expect(resolveReturnPath('https://evil.example/steal')).toBe(DEFAULT_RETURN_PATH);
  });

  it('refuses a PROTOCOL-RELATIVE URL', () => {
    expect(parseReturnSurfaceId('//evil.example/steal')).toBeNull();
    expect(resolveReturnPath('//evil.example/steal')).toBe(DEFAULT_RETURN_PATH);
  });

  it('refuses a bare PATH, even one that is a registered surface', () => {
    // The registry is keyed by ID. A path is not a key, so supplying the very
    // path the map contains still resolves to the default — which is the
    // property that makes an encoding trick pointless.
    expect(parseReturnSurfaceId('/settings/project/repositories')).toBeNull();
    expect(resolveReturnPath('/settings/project/repositories')).toBe(DEFAULT_RETURN_PATH);
  });

  it('refuses traversal, a backslash host, and an unknown id', () => {
    for (const hostile of [
      '../../../etc/passwd',
      '/\\evil.example',
      'projectRepositories/../../evil',
      'PROJECTREPOSITORIES',
      '',
      'nope',
    ]) {
      expect(parseReturnSurfaceId(hostile), hostile).toBeNull();
      expect(resolveReturnPath(hostile), hostile).toBe(DEFAULT_RETURN_PATH);
    }
  });

  it('refuses null and undefined', () => {
    expect(resolveReturnPath(null)).toBe(DEFAULT_RETURN_PATH);
    expect(resolveReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
  });
});

describe('the install state carries the origin, SIGNED', () => {
  it('round-trips a registered origin', () => {
    const token = encodeInstallState(
      { workspaceId: 'ws_1', userId: 'usr_1', origin: 'organizationGit' },
      NOW,
    );
    expect(decodeInstallState(token, NOW + 10)).toEqual({
      workspaceId: 'ws_1',
      userId: 'usr_1',
      origin: 'organizationGit',
    });
  });

  it('OMITS the field when there is no origin, so the token is byte-identical to a pre-MOTIR-4676 one', () => {
    // This is what makes the backwards-compatibility claim checkable rather
    // than merely asserted: the two encodings are the same bytes.
    const withoutOrigin = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    const legacyShape = legacyToken({ w: 'ws_1', u: 'usr_1', exp: NOW + 600 });
    expect(withoutOrigin).toBe(legacyShape);
    expect(decodeInstallState(withoutOrigin, NOW + 10)).toEqual({
      workspaceId: 'ws_1',
      userId: 'usr_1',
    });
  });

  it('a FIXTURE envelope minted before this change still verifies, and carries no origin', () => {
    // The live case: somebody clicked "install" before the deploy and comes back
    // after it. The envelope has no `o` at all, and it must decode rather than
    // be rejected — a rejection here reads to the user as a failed install.
    const fixture = legacyToken({ w: 'ws_legacy', u: 'usr_legacy', exp: NOW + 600 });
    const decoded = decodeInstallState(fixture, NOW + 10);
    expect(decoded).toEqual({ workspaceId: 'ws_legacy', userId: 'usr_legacy' });
    expect(decoded?.origin).toBeUndefined();
    expect(resolveReturnPath(decoded?.origin ?? null)).toBe(DEFAULT_RETURN_PATH);
  });

  it('a TAMPERED origin is refused — the whole token fails, it does not fall back quietly', () => {
    // Swapping the origin invalidates the signature, because the origin is
    // INSIDE it rather than beside it. The refusal is the point: a return
    // target that can be edited in transit is an open redirect however it is
    // later validated.
    const token = encodeInstallState(
      { workspaceId: 'ws_1', userId: 'usr_1', origin: 'projectRepositories' },
      NOW,
    );
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8')) as {
      o?: string;
    };
    payload.o = 'organizationGit';
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(decodeInstallState(forged, NOW + 10)).toBeNull();
  });

  it('an UNSIGNED origin cannot be smuggled in beside the token', () => {
    // A payload assembled by hand with no valid signature is malformed, whatever
    // it claims about where to return to.
    const payload = Buffer.from(
      JSON.stringify({ w: 'ws_1', u: 'usr_1', exp: NOW + 600, o: 'organizationGit' }),
    ).toString('base64url');
    expect(decodeInstallState(`${payload}.not-a-signature`, NOW + 10)).toBeNull();
  });

  it('an origin this build no longer registers decodes to NO origin, not to an unknown path', () => {
    // A signed envelope is ours, so it is not hostile — but a surface that was
    // renamed or removed between minting and return must fall back rather than
    // send the person to a route this build cannot serve.
    const token = signPayload({ w: 'ws_1', u: 'usr_1', exp: NOW + 600, o: 'retiredSurface' });
    const decoded = decodeInstallState(token, NOW + 10);
    expect(decoded).toEqual({ workspaceId: 'ws_1', userId: 'usr_1' });
    expect(resolveReturnPath(decoded?.origin ?? null)).toBe(DEFAULT_RETURN_PATH);
  });
});

/** A token in the shape the code minted BEFORE `origin` existed: `{ w, u, exp }`
 *  and nothing else, signed with the same key and context. */
function legacyToken(payload: { w: string; u: string; exp: number }): string {
  return signPayload(payload);
}

function signPayload(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET)
    .update(`github-install-state.v1.${b64}`)
    .digest('base64url');
  return `${b64}.${sig}`;
}
