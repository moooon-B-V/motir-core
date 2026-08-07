// Acceptance E2E — Story MOTIR-2309: the published MCP server documentation
// (Subtask MOTIR-2332).
//
// Runs under `playwright.acceptance.config.ts` (video: 'on'), which discovers
// this file by its `acceptance*.spec.ts` name; the bulk shards `testIgnore` the
// same pattern, so it runs ONCE, in the lane that records.
//
// It closes the Story from the seat that matters: someone who has heard that
// Motir has an MCP server, has never seen this repository, and wants their own
// agent talking to their plan. They must be able to find the page, settle
// whether they want the MCP or the REST API, copy a config for the client they
// actually use, and look up what the tools do — and a user who has just minted
// a token must get there from inside the product.
//
// ⚠️ EVERY NAVIGATION IS A CLICK, never a `goto` to an MCP docs URL. The whole
// premise of this story is that the MCP was undiscoverable from outside the
// repository, so a spec that types `/docs/mcp` would pass while the door was
// bricked up. The rail row and the API-tokens link are the only two things in
// the product that point here, and driving both is the only assertion that
// catches a page that shipped unreachable.
//
// DETERMINISM — no stubs. The catalogue renders from the shipped scope map, and
// the assertions compare against what the surface DERIVES rather than against a
// count typed into this file, so adding a tool to the registry cannot make this
// spec silently stale. Every wait is on an authoritative signal — a URL, a
// heading, an anchor's destination, a clipboard read — never a timeout.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT, and why ────────────────────
// The EMPTY-CATALOGUE state. The catalogue derives from `TOOL_SCOPES` by module
// import, exactly as the API reference derives from its operation registry — so,
// as `acceptance-api-docs.spec.ts` records for the spec-unavailable state, there
// is no seam a browser can reach in to empty it. Triggering it would mean adding
// a test-only switch to production code, which this card's scope boundary
// forbids. It is asserted instead by the story gate, which renders the real page
// with an emptied catalogue and checks the message and the two ways out
// (`tests/api-docs/mcp-pages.test.tsx`). Recorded here rather than left as a
// silent omission.
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedCliConnect } from './_helpers/cli-connect-seed';
import { mcpClients, mcpToolCount, mcpTransportFacts } from '@/lib/apiDocs/mcp';

test.describe.configure({ timeout: 180_000 });

// The client configs copy to the clipboard; grant the permission so the
// confirmation fires deterministically rather than the copy-failed fallback.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async () => {
  await resetDatabase();
});

/** The endpoint every published block must carry — read from the module, not retyped. */
const ENDPOINT = mcpTransportFacts().url;

test('a reader with no session reaches the MCP page from the rail and leaves able to wire an agent', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2309');

  await chapter('Arrive at the documentation with no account', async () => {
    await page.goto('/docs/api');
    await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
    // Anonymous throughout: the marketing bar still offers sign-in, so nothing
    // on this surface assumes a session.
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
    await beat();
  });

  await chapter('Find the MCP server in the rail — by CLICKING it', async () => {
    const rail = page.getByRole('navigation', { name: 'Documentation' });
    await rail.getByRole('link', { name: 'MCP server' }).click();
    await page.waitForURL('**/docs/mcp');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The row marks itself current, which is what makes the area read as one
    // surface rather than pages that happen to look alike.
    await expect(rail.getByRole('link', { name: 'MCP server' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await beat();
  });

  await chapter('Settle the first question: this, or the REST API?', async () => {
    // The fork is the first thing under the lede because it is the first choice
    // a reader makes, and the expensive one to get wrong.
    //
    // ⚠️ `.filter({ visible: true })` because the shipped `DocTable` renders every
    // row TWICE — a wide `<table>` and a stack of narrow cards, each `display:
    // none` at the other width — so a bare `getByText` resolves to two elements
    // and trips strict mode. Filtering by visibility asserts what the reader at
    // THIS viewport can actually see, and stays correct at either width.
    await expect(
      page.getByText('Expected to change', { exact: false }).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Additive only', { exact: false }).filter({ visible: true }),
    ).toBeVisible();
    // …and the other half is one click away for the reader who took it.
    await expect(page.locator('main a[href="/docs/api"]').first()).toBeVisible();
    await beat();
  });

  await chapter('Read the four facts every client needs', async () => {
    const main = page.locator('main');
    await expect(main.getByText(ENDPOINT).first()).toBeVisible();
    await expect(main.getByText('Streamable HTTP', { exact: false }).first()).toBeVisible();
    await beat();
  });

  await chapter('Copy the config for the client you actually use', async () => {
    // ⚠️ THE POINT OF THE CLIENT MATRIX (ADR Amendment 12 Q3a). Motir does not
    // ship the agent — the reader brings their own — so every named client has
    // a block, and each one names the same endpoint.
    for (const client of mcpClients()) {
      await expect(
        page.getByRole('heading', { name: client.label, exact: false }).first(),
        `no wiring block for ${client.label}`,
      ).toBeVisible();
    }

    // Copy one for real, and check the whole thing arrives — a copy button that
    // quietly yields half a config looks identical to one that works.
    const first = mcpClients()[0]!;
    await page.getByRole('button', { name: 'Copy' }).first().click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(ENDPOINT);
    expect(copied).toContain('Authorization');
    // The placeholder is obvious, never a plausible-looking token a reader
    // would paste and then debug as an auth failure.
    expect(copied).not.toMatch(/motir_pat_[A-Za-z0-9]{10,}/);
    expect(first.config).toContain(ENDPOINT);
    await beat();
  });

  await chapter('Learn what the token can call before minting one', async () => {
    // The scope legend, and the one scope a new token does NOT get — the fact
    // most likely to break a reader's first run if they never see it.
    await expect(page.locator('main').getByText('work_items:delete').first()).toBeVisible();
    await beat();
  });

  await chapter('Open the catalogue — every tool, from the sub-area’s own tier', async () => {
    const rail = page.getByRole('navigation', { name: 'Documentation' });
    // The MCP's SECOND TIER — it exists only inside `/docs/mcp/*`, and this is
    // the click that proves it (Amendment 12 Q1).
    await rail.getByRole('link', { name: 'Tools', exact: true }).click();
    await page.waitForURL('**/docs/mcp/tools');

    // THE CATALOGUE IS WHOLE. Compared against what the surface DERIVES, so a
    // tool added to the registry cannot leave this spec quietly passing.
    const rows = page.locator('main table tbody tr');
    await expect(rows).toHaveCount(mcpToolCount());

    // …and a named tool a reader would actually look for is findable.
    await expect(page.locator('main').getByText('claim_next_ready').first()).toBeVisible();
    await beat();
  });

  await chapter('No REST operation index frames either page', async () => {
    // Live, not at the component level: the prefix rule (Amendment 11 Q2) is
    // what decides it, and this is the seat it has to hold from.
    const rail = page.getByRole('navigation', { name: 'Documentation' });
    await expect(rail.locator('[data-operation-id]')).toHaveCount(0);
    await expect(rail.locator('input[type="search"]')).toHaveCount(0);

    await rail.getByRole('link', { name: 'MCP server' }).click();
    await page.waitForURL('**/docs/mcp');
    await expect(rail.locator('[data-operation-id]')).toHaveCount(0);
    await beat();
  });

  await chapter('And from inside: the door on the API-tokens page', async () => {
    const seed = await seedCliConnect(`mcp-docs-${Date.now()}@example.com`);
    await signIn(page, seed.email, seed.password);
    await page.goto('/settings/account/api-tokens');
    await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();
    await beat();

    // ⚠️ THE HANDOFF THIS STORY EXISTS TO FIX. This link used to leave the
    // product for a raw markdown file on a source-code host, handed to a user at
    // the exact moment they have just minted their first token. It now lands on
    // the published guide, inside the app.
    await page.getByRole('link', { name: 'Read the MCP setup guide' }).click();
    await page.waitForURL('**/docs/mcp');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The wiring page, not the catalogue — this reader has a credential and no
    // client yet.
    expect(new URL(page.url()).pathname).toBe('/docs/mcp');
    await beat();
  });
});
