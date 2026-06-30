import { describe, it, expect, beforeEach } from 'vitest';
import { verifyServiceBearer } from '@/lib/ai/serviceBearer';

// Pure unit (no DB) for the shared §4a service-bearer check (MOTIR-1451). The
// job-token path's own bearer cases live in jobAuth.test.ts; this pins the
// extracted helper directly, including the fail-closed branch.

const SECRET = 'core-callback-secret-test';

beforeEach(() => {
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

function req(headers: Record<string, string>): Request {
  return new Request('http://internal/api/internal/ai/work-items', { headers });
}

describe('verifyServiceBearer', () => {
  it('accepts the correct service bearer', () => {
    expect(verifyServiceBearer(req({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it('rejects a missing Authorization header', () => {
    expect(verifyServiceBearer(req({}))).toBe(false);
  });

  it('rejects a wrong bearer', () => {
    expect(verifyServiceBearer(req({ authorization: 'Bearer nope' }))).toBe(false);
  });

  it('rejects a non-Bearer scheme even with the right value', () => {
    expect(verifyServiceBearer(req({ authorization: `Basic ${SECRET}` }))).toBe(false);
  });

  it('rejects an empty bearer', () => {
    expect(verifyServiceBearer(req({ authorization: 'Bearer ' }))).toBe(false);
  });

  it('fails closed when CORE_CALLBACK_SECRET is unset', () => {
    delete process.env['CORE_CALLBACK_SECRET'];
    expect(verifyServiceBearer(req({ authorization: 'Bearer anything' }))).toBe(false);
  });
});
