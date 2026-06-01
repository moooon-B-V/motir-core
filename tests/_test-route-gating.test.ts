import { afterEach, describe, expect, it, vi } from 'vitest';
// NOTE: the on-disk folder is `%5Ftest` (URL-encoded `_`), NOT `_test`. Next.js
// App Router treats a literal `_`-prefixed folder as PRIVATE (excluded from
// routing → every `_test/*` URL 404s); `%5Ftest` is the documented escape that
// renders the literal `/api/_test/...` URL while staying routable. See the
// route files' header + PRODECT_FINDINGS for the gory details.
import * as workItemsRoute from '@/app/api/%5Ftest/work-items/route';
import * as workItemLinksRoute from '@/app/api/%5Ftest/work-item-links/route';

// Production-build gating for the throwaway `_test/*` route handlers (Subtask
// 1.4.8). Every handler returns 404 (NOT 403/501) when NODE_ENV === 'production'
// — the durable mechanism that keeps these endpoints out of production builds.
// The 404 preserves the no-existence-leak contract (a prod probe of `_test/*`
// is indistinguishable from any other unknown path).
//
// The gate is the FIRST thing each handler runs, BEFORE auth/session — so this
// test needs no session, cookies, or DB: flipping NODE_ENV to 'production' and
// invoking the handler is sufficient. The gate reads process.env['NODE_ENV']
// dynamically (not a build-inlined constant), so the runtime flip below takes
// effect against the imported handlers.
//
// (The Playwright spec deliberately SKIPS the production-gating scenario and
// cites this file — gating is a unit-test concern; the E2E server runs in
// development, where the gate is open.)

// `process.env.NODE_ENV` is typed read-only, so flip it through vi.stubEnv
// (which mutates process.env so the handlers' dynamic read sees 'production')
// and restore via unstubAllEnvs.
afterEach(() => {
  vi.unstubAllEnvs();
});

type Handler = (req: Request) => Promise<Response>;

async function assertGated(handler: Handler, url: string): Promise<void> {
  const res = await handler(new Request(url, { method: 'GET' }));
  expect(res.status).toBe(404);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe('NOT_FOUND');
}

describe('_test/work-items route — production gating', () => {
  it('returns 404 for GET/POST/PATCH/DELETE when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = 'http://localhost/api/_test/work-items?id=anything';
    await assertGated(workItemsRoute.GET, url);
    await assertGated(workItemsRoute.POST, url);
    await assertGated(workItemsRoute.PATCH, url);
    await assertGated(workItemsRoute.DELETE, url);
  });
});

describe('_test/work-item-links route — production gating', () => {
  it('returns 404 for GET/POST/DELETE when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const url = 'http://localhost/api/_test/work-item-links?workItemId=anything';
    await assertGated(workItemLinksRoute.GET, url);
    await assertGated(workItemLinksRoute.POST, url);
    await assertGated(workItemLinksRoute.DELETE, url);
  });
});
