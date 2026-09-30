import { describe, expect, it } from 'vitest';
import { isOAuthAuthorizeHandoff, oauthAuthorizeNext } from '@/lib/oauth/authorizeReturn';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';
import { mcpResourceUrl } from '@/lib/oauth/config';

// The sign-in page's hand-back to the authorize endpoint (MOTIR-6982).

const handoff = () =>
  new URLSearchParams({
    response_type: 'code',
    client_id: 'abc',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'ch',
    code_challenge_method: 'S256',
    state: 's',
    exp: '123',
    ba_iat: '456',
    ba_pl: 'x',
    sig: 'signature',
  });

describe('oauthAuthorizeNext', () => {
  it('points back at the authorize endpoint with the request and without the signature', () => {
    const next = oauthAuthorizeNext(handoff())!;
    const url = new URL(next, 'http://localhost:3000');
    expect(url.pathname).toBe('/api/auth/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('abc');
    // The provider's signed redirect drops RFC 8707's `resource`; it is restored.
    expect(url.searchParams.get('resource')).toBe(mcpResourceUrl());
    expect(url.searchParams.get('state')).toBe('s');
    for (const gone of ['sig', 'exp', 'ba_iat', 'ba_pl'])
      expect(url.searchParams.has(gone)).toBe(false);
  });

  it('is a same-origin path the post-auth resolver accepts', () => {
    const next = oauthAuthorizeNext(handoff())!;
    expect(sanitizeNextPath(next)).toBe(next);
  });

  it('drops prompt=login/create so the return does not loop back to sign-in', () => {
    const p = handoff();
    p.set('prompt', 'login consent');
    expect(new URL(oauthAuthorizeNext(p)!, 'http://x').searchParams.get('prompt')).toBe('consent');
    p.set('prompt', 'login');
    expect(new URL(oauthAuthorizeNext(p)!, 'http://x').searchParams.has('prompt')).toBe(false);
  });

  it('is null for an ordinary sign-in', () => {
    expect(oauthAuthorizeNext(new URLSearchParams({ next: '/items' }))).toBeNull();
    const unsigned = handoff();
    unsigned.delete('sig');
    expect(isOAuthAuthorizeHandoff(unsigned)).toBe(false);
  });
});
