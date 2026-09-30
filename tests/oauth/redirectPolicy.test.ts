import { describe, expect, it } from 'vitest';
import {
  isAllowedRedirectUri,
  isLoopbackHostname,
  matchesRegisteredRedirect,
} from '@/lib/oauth/redirectPolicy';

// The redirect policy for dynamically registered clients (MOTIR-6982): https, or
// http on loopback; loopback matched port-agnostically (RFC 8252 §7.3).

describe('isAllowedRedirectUri', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://example.com/cb?x=1',
    'http://127.0.0.1:53682/callback',
    'http://localhost:3000/cb',
    'http://LOCALHOST/cb',
    'http://[::1]:8080/cb',
  ])('admits %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    'http://example.com/cb',
    'http://127.0.0.2/cb',
    'http://localhost.example.com/cb',
    'myapp://callback',
    'javascript:alert(1)',
    'https://claude.ai/cb#fragment',
    'not a url',
    '',
  ])('refuses %s', (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });
});

describe('isLoopbackHostname', () => {
  it('knows exactly the three loopback names', () => {
    expect(['localhost', '127.0.0.1', '[::1]'].every(isLoopbackHostname)).toBe(true);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
    expect(isLoopbackHostname('app.localhost')).toBe(false);
  });
});

describe('matchesRegisteredRedirect', () => {
  const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:53682/callback'];

  it('matches an exact registration', () => {
    expect(matchesRegisteredRedirect(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(
      true,
    );
  });

  it('ignores the port on a loopback registration only', () => {
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:61000/callback')).toBe(true);
    expect(matchesRegisteredRedirect(['http://localhost/cb'], 'http://localhost:4000/cb')).toBe(
      true,
    );
    expect(
      matchesRegisteredRedirect(registered, 'https://claude.ai:8443/api/mcp/auth_callback'),
    ).toBe(false);
  });

  it('holds scheme, host, path and query exact on loopback', () => {
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:61000/other')).toBe(false);
    expect(matchesRegisteredRedirect(registered, 'http://localhost:53682/callback')).toBe(false);
    expect(matchesRegisteredRedirect(registered, 'https://127.0.0.1:53682/callback')).toBe(false);
    expect(matchesRegisteredRedirect(registered, 'http://127.0.0.1:53682/callback?x=1')).toBe(
      false,
    );
  });

  it('refuses garbage', () => {
    expect(matchesRegisteredRedirect(registered, 'not a url')).toBe(false);
    expect(matchesRegisteredRedirect(['not a url'], 'http://127.0.0.1/cb')).toBe(false);
  });
});
