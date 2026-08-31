import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * MOTIR-3884 — the moved public surfaces leave the application host. Once the
 * public origin is configured (`MOTIR_PUBLIC_SITE_URL` → motir.co), the proxy
 * 308s `/`, `/explore/*`, `/docs/*`, `/legal/*` AND `/p/*` onto it, path and
 * query preserved, and nothing fires while the public origin is unconfigured
 * (a redirect would loop onto this origin).
 */

vi.mock('better-auth/cookies', () => ({
  getSessionCookie: () => null,
}));

const PUBLIC = 'https://motir.co';
const APP = 'https://app.motir.co';

afterEach(() => {
  delete process.env['MOTIR_PUBLIC_SITE_URL'];
  delete process.env['MOTIR_BASE_URL'];
});

const redirect = async (path: string) => {
  const { proxy } = await import('@/proxy');
  return proxy(new NextRequest(`${APP}${path}`));
};

describe('the moved public surfaces 308 to motir.co', () => {
  it('308s the root / to the public site root', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/');
  });

  it('308s /explore with path and query preserved', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/explore?rank=popular');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/explore?rank=popular');
  });

  it('308s a topic landing page', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/explore/topic/design');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/explore/topic/design');
  });

  it('308s /docs and everything beneath it', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/docs/api/getting-started');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/docs/api/getting-started');
  });

  it('308s /legal and a document beneath it', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/legal/privacy');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/legal/privacy');
  });

  it('308s /p/* — its move to motir.co was folded into this redirect set', async () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC;
    process.env['MOTIR_BASE_URL'] = APP;
    const res = await redirect('/p/PROD');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://motir.co/p/PROD');
  });

  it('does not redirect while the public origin is unconfigured (no self-loop)', async () => {
    delete process.env['MOTIR_PUBLIC_SITE_URL'];
    delete process.env['MOTIR_BASE_URL'];
    const res = await redirect('/explore');
    expect(res.status).not.toBe(308);
  });
});

describe('the matcher covers the moved surfaces, including /p', () => {
  it('lists /, /explore, /docs, /legal and /p', async () => {
    const { config, PUBLIC_REDIRECT_SEGMENTS } = await import('@/proxy');
    const segments = config.matcher.map((entry) => entry.replace(/^\//, '').split('/')[0]);
    expect(segments).toContain('');
    expect(segments).toContain('explore');
    expect(segments).toContain('docs');
    expect(segments).toContain('legal');
    expect(segments).toContain('p');
    expect([...PUBLIC_REDIRECT_SEGMENTS]).toEqual(['', 'explore', 'docs', 'legal', 'p']);
  });
});
