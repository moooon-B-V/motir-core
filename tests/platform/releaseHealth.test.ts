import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as releaseHealthRoute } from '@/app/api/health/release/route';

/**
 * WHICH COMMIT IS PRODUCTION RUNNING? (Task MOTIR-3760)
 *
 * ⚠️ THE PROPERTY UNDER TEST IS THAT THE ROUTE DRAWS NO CONCLUSION. It reports
 * one fact about the deployment and nothing else — the comparison against
 * `main`, the age arithmetic and the alarm all live outside, in
 * `.github/workflows/deploy-freshness.yml`, because a deployment cannot be the
 * thing that reports it is behind. So there is deliberately no "stale" arm here
 * to test; what is tested is that the two states it CAN report are
 * distinguishable from the outside by status code alone.
 *
 * ⚠️ AND THE 503 ARM IS THE ONE THAT MATTERS. Until this card, the runner stage
 * of the `Dockerfile` never carried `MOTIR_RELEASE` — its `ARG`/`ENV` pair lives
 * in `builder`, and a Docker `ENV` is scoped to its stage — so the running server
 * genuinely could not name its own commit. A route that answered `200 {release:
 * null}` for that would have made a blind deployment look like a successful read,
 * and the freshness check downstream would have had nothing to go red on.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

async function read(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await releaseHealthRoute();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/health/release', () => {
  it('names the build it was made from, with a 200', async () => {
    const sha = 'a'.repeat(40);
    vi.stubEnv('MOTIR_RELEASE', sha);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body).toEqual({ release: sha, state: 'known' });
  });

  it('answers 503 — NOT a 200 with a null — when the image cannot name its commit', async () => {
    vi.stubEnv('MOTIR_RELEASE', '');
    const { status, body } = await read();
    expect(status).toBe(503);
    expect(body).toEqual({ release: null, state: 'unset' });
  });

  it('treats a whitespace-only value as unset rather than reporting it', async () => {
    // `monitoringRelease()`'s `nonEmpty` is what makes this true, and it is worth
    // pinning here: a build argument that arrived as `" "` would otherwise be
    // published as this deployment's commit and compared against `main` as one.
    vi.stubEnv('MOTIR_RELEASE', '   ');
    const { status } = await read();
    expect(status).toBe(503);
  });

  it('is never cached — a cached answer about which build is running is worse than none', async () => {
    vi.stubEnv('MOTIR_RELEASE', 'b'.repeat(40));
    const res = await releaseHealthRoute();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
