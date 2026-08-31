import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

/*
 * ACCEPTANCE — the moved public surfaces redirect off the application host
 * (Story MOTIR-3932 · Subtask MOTIR-3886).
 *
 * The whole public JOURNEY (landing → /explore → /docs → /legal → /p/*) is
 * rendered by `motir-marketing` on `motir.co` — a different application this
 * lane does not boot, so this spec walks the half that lives here: the
 * redirects MOTIR-3884 ships. Each moved path on the application host must 308
 * onto the public origin with its path and query preserved.
 *
 * ── THE HOST MECHANISM, named rather than inherited ─────────────────────────
 * The redirect's destination is the config-driven public origin
 * (`lib/publicProjects/urls.ts` `publicSiteOrigin()` → `MOTIR_PUBLIC_SITE_URL`),
 * and it is gated on that origin DIFFERING from the application origin. The
 * acceptance lane sets `MOTIR_PUBLIC_SITE_URL` to a synthetic
 * `https://public.motir.e2e` (see playwright.acceptance.config.ts), so the
 * redirect FIRES here and points at a host that need not be reachable — every
 * assertion reads the response's status and Location header without following
 * it, which is also what distinguishes a 308 from a 302 (they look identical
 * once a browser follows them).
 *
 * ── SIGNED-IN SURFACES ARE UNAFFECTED ───────────────────────────────────────
 * The redirect must not swallow the application: a signed-in visit to `/home`
 * still lands on `/home`, not on the public origin.
 */

test.describe.configure({ timeout: 120_000 });

test('the moved public surfaces 308 off the application host', async ({
  page,
  request,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3932');

  const APP = 'http://localhost:3200';
  const PUBLIC = 'https://public.motir.e2e';

  // A clean tenant, so the sign-up in step 8 meets no duplicate-email state.
  await resetDatabase();

  // ── Step 6 — each moved path 308s, path and query preserved ──────────────
  for (const [label, path, destination] of [
    ['the landing page redirects', '/', '/'],
    ['the ranked explore view redirects', '/explore?rank=popular', '/explore?rank=popular'],
    ['an explore topic redirects', '/explore/topic/design', '/explore/topic/design'],
    ['the API guide redirects', '/docs/api/getting-started', '/docs/api/getting-started'],
    ['a legal page redirects', '/legal/privacy', '/legal/privacy'],
    ['a public project redirects', '/p/PROD', '/p/PROD'],
  ] as const) {
    await chapter(label, async () => {
      const res = await request.get(`${APP}${path}`, { maxRedirects: 0 });
      expect(res.status(), `${path} status`).toBe(308);
      expect(res.headers()['location'], `${path} location`).toBe(`${PUBLIC}${destination}`);
    });
  }

  // ── Step 7 — a signed-in journey is unaffected ────────────────────────────
  await chapter('signed-in surfaces do not redirect', async () => {
    await signUp(page, 'public-redirect-e2e@example.com');
    await expect(page).toHaveURL(/\/home$/);
    await beat();
  });
});
