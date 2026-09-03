import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCS_URL_ENV, docsIndexUrl } from '@/lib/docs/links';

// WHERE THE RAIL'S `Docs` ROW POINTS (MOTIR-4167).
//
// The resolver mirrors `lib/legal/links.ts`: every answer is NULLABLE, and
// `null` is the unconfigured build rather than an error — the state every
// self-hoster runs on day one, and the arm
// `design/shell/rail-bottom-section.mock.html` draws as the section's floor. So
// the unconfigured assertions are as load-bearing as the configured one, and the
// REFUSAL arm is the one this card is about: a relative value is the defect.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('docsIndexUrl — configured, absent, or refused', () => {
  it('answers the configured absolute url, verbatim', () => {
    vi.stubEnv(DOCS_URL_ENV, 'https://motir.co/docs');
    expect(docsIndexUrl()).toBe('https://motir.co/docs');
  });

  it('trims padding around the value', () => {
    vi.stubEnv(DOCS_URL_ENV, '  https://motir.co/docs  ');
    expect(docsIndexUrl()).toBe('https://motir.co/docs');
  });

  it('accepts a plain http url — a self-hoster’s mirror need not be TLS', () => {
    vi.stubEnv(DOCS_URL_ENV, 'http://docs.internal.example/motir');
    expect(docsIndexUrl()).toBe('http://docs.internal.example/motir');
  });

  it('answers null when nothing is configured', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    expect(docsIndexUrl()).toBeNull();
  });

  it("answers null for an EMPTY value — a secret cleared to '' is not a destination", () => {
    vi.stubEnv(DOCS_URL_ENV, '   ');
    expect(docsIndexUrl()).toBeNull();
  });

  // ⚠️ THE ARM THIS CARD EXISTS FOR. A relative path names a route this
  // application does not serve — it is exactly what the row carried when it
  // 404ed — so it is refused rather than rendered, and refused LOUDLY: silently
  // treating it as unset would hide the operator's mistake behind the same
  // absent row a deliberate unset produces.
  it('REFUSES a relative path, and says so at error level', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv(DOCS_URL_ENV, '/docs');
    expect(docsIndexUrl()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain(DOCS_URL_ENV);
    expect(error.mock.calls[0]?.[0]).toContain('/docs');
  });

  it('refuses a non-http scheme — the row is a navigation, not a protocol handler', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv(DOCS_URL_ENV, 'mailto:docs@example.com');
    expect(docsIndexUrl()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain(DOCS_URL_ENV);
  });

  it('logs nothing on the two legitimate arms', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv(DOCS_URL_ENV, undefined);
    docsIndexUrl();
    vi.stubEnv(DOCS_URL_ENV, 'https://motir.co/docs');
    docsIndexUrl();
    expect(error).not.toHaveBeenCalled();
  });
});
