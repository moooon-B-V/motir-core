import { afterEach, describe, expect, it, vi } from 'vitest';
import { listImageTags } from '../src/index';

// THE ANONYMOUS TAG LISTING (`docs/decisions/agent-image-update.md` Q1 ·
// MOTIR-6949) — how Motir learns which versions of a sandbox profile are
// published. No network: `fetch` is the only fake. Its three answers are pinned
// the way `probeImagePull`'s are: a list, a refusal, and "could not ask", the last
// of which must never read as an empty list.

const REPO = 'ghcr.io/moooon-b-v/motir-sandbox';
const CHALLENGE =
  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:moooon-b-v/motir-sandbox:pull"';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listImageTags', () => {
  it('lists a public repository after the anonymous token dance', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        urls.push(String(rawUrl));
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        if (!auth) return json(401, {}, { 'www-authenticate': CHALLENGE });
        expect(auth).toBe('Bearer anon');
        return json(200, {
          name: 'moooon-b-v/motir-sandbox',
          tags: ['claude', 'claude-0.4.0', 'claude-0.5.0', 7],
        });
      }),
    );
    expect(await listImageTags(REPO)).toEqual({
      ok: true,
      registry: 'ghcr.io',
      repository: 'moooon-b-v/motir-sandbox',
      tags: ['claude', 'claude-0.4.0', 'claude-0.5.0'],
    });
    expect(urls[0]).toBe('https://ghcr.io/v2/moooon-b-v/motir-sandbox/tags/list?n=1000');
    const token = new URL(urls[1]!);
    expect(token.searchParams.get('scope')).toBe('repository:moooon-b-v/motir-sandbox:pull');
  });

  it('answers a registry needing no token, and a body with no tags as an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, {})),
    );
    expect(await listImageTags(REPO)).toMatchObject({ ok: true, tags: [] });
  });

  it('refusals and transport failures are answers, never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string) =>
        new URL(String(rawUrl)).pathname === '/token'
          ? json(401, {})
          : json(401, {}, { 'www-authenticate': CHALLENGE }),
      ),
    );
    expect(await listImageTags(REPO)).toMatchObject({ ok: false, reason: 'unauthorized' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {})),
    );
    expect(await listImageTags(REPO)).toMatchObject({ ok: false, reason: 'unauthorized' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, {})),
    );
    expect(await listImageTags(REPO)).toMatchObject({ ok: false, reason: 'refused' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await listImageTags(REPO)).toMatchObject({ ok: false, reason: 'unreachable' });

    expect(await listImageTags('')).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});
