import { test, expect } from './_helpers/promoted-regression';
import type { Page, Route } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAuditCoverage,
  AUDITED_REPO,
  UNAUDITED_REPOS,
  type AuditCoverageSeed,
} from './_helpers/audit-coverage-seed';

// ⚠️ RE-POINTED FOR THE OVERLAY (MOTIR-4732, story MOTIR-4725). The planning
// workspace was a ROUTE at `/planning`; it is a full-screen OVERLAY on the page
// you are already on. So an address that used to BE the workspace is now a host
// page plus four namespaced parameters, and a `waitForURL` that matched the old
// path matches nothing. The assertions about what the workspace DOES are
// unchanged — only how it is reached and how its arrival is detected.
//
// (`/planning?…` still resolves: `app/(authed)/planning/page.tsx` forwards an old
// link to the host page it belonged to. Its own coverage is in
// `tests/integration/planning/planChangeSeams.test.ts`; these specs address the
// overlay directly, which is what a reader would write today.)

// Story MOTIR-2244 — audit coverage, end to end (MOTIR-2253).
//
// The `verification_recipe`, automated: an ADMIN learns from /planning that
// repositories have never been assessed, reaches /code-health in one click, and
// derives an audit for one repo alone — then for the un-audited SET. And the
// negative case, which is half the story: a MEMBER sees no banner at all,
// asserted with a real member session rather than by omitting an assertion.
//
// STUBBING. Only the motir-ai-backed routes are faked, at the `page.route`
// seam the shipped AI acceptance specs use (`acceptance-ai-callout.spec.ts`).
// The pages, the services, the access gates and the database are all REAL — in
// particular the admin gate, so the member's absence of a banner is produced by
// the shipped capability path rather than by the stub.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E waits on the authoritative signal):
// every wait is a role/text landmark or the response of the request the page
// actually issued. There is no bare timeout anywhere in this spec.

test.describe.configure({ timeout: 180_000 });

/** The bodies the page POSTed to the trigger, in order. */
let refreshBodies: { repoKeys?: string[] }[] = [];

// ── The SERVER-side boundary fixture (MOTIR-2253) ────────────────────────────
//
// `/code-health` is server rendered: `loadCodeHealthSurfaces` calls motir-ai
// INSIDE the Next process, where `page.route` cannot reach. `lib/test-code-health-mock`
// (E2E_TEST_CODE_HEALTH=1, wired in this lane's webServer env) answers those
// reads from this file. Rewriting it between steps is how a repo changes state.
const FIXTURE =
  process.env['MOTIR_AI_CODE_HEALTH_FIXTURE_PATH'] ??
  path.join(process.cwd(), 'out', 'e2e-code-health-fixture.json');

function writeFixture(auditedKeys: readonly string[]): void {
  mkdirSync(path.dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        repos: [AUDITED_REPO, ...UNAUDITED_REPOS].map((repoKey) => ({
          repoKey,
          audited: auditedKeys.includes(repoKey),
        })),
        refreshes: [],
      },
      null,
      2,
    ),
  );
}

/** The `repoRef`s the SERVER actually submitted, in order — the authoritative
 *  answer to "which repos did that press pay to derive". */
function submittedRefs(): (string | null)[] {
  try {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      refreshes?: { repoRef: string | null }[];
    };
    return (f.refreshes ?? []).map((r) => r.repoRef);
  } catch {
    return [];
  }
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ⚠️ NOTHING in the app is stubbed in the browser any more.
//
// The audit reads, the convention reads and the derivation trigger all run
// through the REAL routes and the REAL services; only motir-ai itself is faked,
// server-side, by `lib/test-code-health-mock` off the fixture this spec writes.
// An earlier draft stubbed `/api/ai/coding-convention/*` with `page.route` and
// it was worse than useless: the trigger's POST never reached the route handler,
// so the spec asserted its own fake rather than the story.
//
// The one browser-level override left is the FAILURE case below, which forces
// the banner's own read to 502 — a condition the boundary mock cannot express.
async function failCoverageRead(page: Page): Promise<void> {
  await page.route('**/api/ai/coding-convention/audit-coverage', (route) =>
    json(route, { code: 'MOTIR_AI_UNAVAILABLE' }, 502),
  );
}

/** Record the trigger POSTs the BROWSER made, without intercepting them. */
function recordRefreshPosts(page: Page): void {
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/coding-convention/refresh')) {
      const raw = req.postData();
      refreshBodies.push((raw === null ? {} : JSON.parse(raw)) as { repoKeys?: string[] });
    }
  });
}

const banner = (page: Page) => page.getByRole('status').filter({ hasText: 'code-health audit' });
const repoGroup = (page: Page) =>
  page.getByRole('group', { name: /Choose a repository.s audit report/ });
const rowAuditButton = (page: Page, repoKey: string) =>
  page.getByRole('button', { name: `Audit ${repoKey}` });
const bulkButton = (page: Page) =>
  page.getByRole('button', { name: /Audit the \d+ with no report/ });

/** The workspace's own exit chrome — "Back to roadmap" / "Back to {item}" —
 *  is the authoritative "the host mounted" landmark: it renders regardless of
 *  what the canvas is doing, so waiting on it never races the canvas read. */
// ⚠️ The exit chrome is a BUTTON labelled `Close` since MOTIR-4729 — an overlay
// has no destination to name, which is what `Back to …` was doing.
const exitChrome = (page: Page) => page.getByRole('button', { name: /^Close/ });

async function openPlanning(page: Page): Promise<void> {
  await page.goto('/roadmap?plan=project&planFrom=project');
  await expect(exitChrome(page)).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
  refreshBodies = [];
  writeFixture([AUDITED_REPO]);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('an admin is told, reaches /code-health, and audits one repo then the rest', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2244');

  const seed: AuditCoverageSeed = await seedAuditCoverage(`audit-coverage-${Date.now()}`);
  recordRefreshPosts(page);
  await signIn(page, seed.adminEmail, seed.password);

  await chapter('The planning workspace says two repositories were never assessed', async () => {
    await openPlanning(page);

    // One line, naming the COUNT — and it links onward rather than acting here.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('2 repositories have no code-health audit.');
    await expect(page.getByRole('link', { name: 'Review code health' })).toBeVisible();
    await beat();
  });

  await chapter('Its link reaches the code-health audit tab in one click', async () => {
    await page.getByRole('link', { name: 'Review code health' }).click();
    await page.waitForURL('**/code-health');

    // The repo list is the arrival state: every connected repo, with the
    // un-audited ones carrying their own trigger.
    await expect(repoGroup(page)).toBeVisible();
    await expect(page.getByText('Not audited yet').first()).toBeVisible();
    await beat();
  });

  await chapter('Auditing ONE repository derives that repository alone', async () => {
    const target = UNAUDITED_REPOS[0]!;
    const posted = page.waitForResponse(
      (r) => r.url().includes('/coding-convention/refresh') && r.request().method() === 'POST',
    );
    await rowAuditButton(page, target).click();
    expect((await posted).status()).toBe(202);

    // The request the page ACTUALLY issued named that repo and nothing else…
    expect(refreshBodies.at(-1)).toEqual({ repoKeys: [target] });
    // …and the SERVER submitted exactly one derivation, for that repo. This is
    // the fact the story turns on, read back from the boundary rather than
    // inferred from the browser.
    expect(submittedRefs()).toEqual([target]);

    // That row is deriving, and its trigger is gone — removed, not disabled.
    await expect(repoGroup(page).getByText('Deriving…')).toBeVisible();
    await expect(rowAuditButton(page, target)).toHaveCount(0);
    await beat();
  });

  await chapter('And one action audits every repository with no report', async () => {
    // The boundary records EVERY submission for the life of the test, so the
    // bulk press is measured against a mark rather than the whole history —
    // the per-repo run above is already in there.
    const before = submittedRefs().length;

    // Back to a settled page so the bulk action is offered again.
    await page.reload();
    await expect(repoGroup(page)).toBeVisible();

    const posted = page.waitForResponse(
      (r) => r.url().includes('/coding-convention/refresh') && r.request().method() === 'POST',
    );
    await expect(bulkButton(page)).toBeVisible();
    await bulkButton(page).click();
    expect((await posted).status()).toBe(202);

    // Exactly the un-audited repos — the one that already has a report is not
    // re-derived, which is the whole point of the story.
    const body = refreshBodies.at(-1)!;
    expect([...(body.repoKeys ?? [])].sort()).toEqual([...UNAUDITED_REPOS].sort());
    expect(body.repoKeys).not.toContain(AUDITED_REPO);
    // The boundary agrees: one derivation per un-audited repo, and the repo that
    // already HAS a report was never re-derived — the whole point of the story.
    const queued = submittedRefs().slice(before);
    expect([...queued].sort()).toEqual([...UNAUDITED_REPOS].sort());
    expect(queued).not.toContain(AUDITED_REPO);
    await beat();
  });
});

test('a project MEMBER is never shown the banner', async ({ page }) => {
  const seed = await seedAuditCoverage(`audit-coverage-member-${Date.now()}`);
  await signIn(page, seed.memberEmail, seed.password);

  await openPlanning(page);

  // Not a disabled control, not a quieter variant: nothing at all. The admin
  // case above proves the same seed DOES produce a banner, so this is the
  // capability gate rather than an empty fixture.
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Review code health' })).toHaveCount(0);
});

test('no banner when every repository already has a report', async ({ page }) => {
  const seed = await seedAuditCoverage(`audit-coverage-all-${Date.now()}`);
  writeFixture([AUDITED_REPO, ...UNAUDITED_REPOS]);
  await signIn(page, seed.adminEmail, seed.password);

  await openPlanning(page);

  await expect(banner(page)).toHaveCount(0);
});

test('a FAILED coverage read shows no banner and no error strip', async ({ page }) => {
  const seed = await seedAuditCoverage(`audit-coverage-fail-${Date.now()}`);
  await failCoverageRead(page);
  await signIn(page, seed.adminEmail, seed.password);

  await openPlanning(page);

  // A planning workspace must not gain an error banner because a background
  // read timed out — the workspace is intact and simply says nothing.
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByText(/couldn.t load|something went wrong/i)).toHaveCount(0);
  await expect(exitChrome(page)).toBeVisible();
});
