import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import {
  IMAGE_SOURCE_PATH,
  MOCK_HTML,
  MOCK_SOURCE_PATH,
  NOTE_BODY,
  NOTE_HEADING,
  NOTE_MD,
  NOTE_SOURCE_PATH,
  PNG_BYTES,
  seedDesignPublish,
  type DesignPublishSeed,
} from './_helpers/design-publish-seed';

// Story MOTIR-3780 — a design result reaches its card because the AGENT
// publishes it (MOTIR-3788).
//
// The story's `verification_recipe`, driven in a browser, and its ACCEPTANCE
// RECEIPT. What this story ships is something a person LOOKS at, so the proof is
// a recording of a reviewer reading a design result that no CI job produced.
//
// ⚠️ WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT — the sibling owns it.
// `design-result.spec.ts` (MOTIR-2672) already drives the panel's READ half at
// two altitudes: the rendered Markdown note, the `sandbox=""` frame and the
// opaque-origin property read off the real browser, the lightbox, and — in its
// second, unstubbed test — the content-route → signed-URL → store hop, asserting
// the store refuses a request with no `X-Amz-Signature`. **None of that is
// re-derived here.** A story-level test card that re-runs its siblings' suite is
// the failure mode this one was written to avoid, and the split is by what each
// can honestly prove: that spec proves the panel READS, this one proves the
// result GOT THERE through the tool.
//
// ⚠️ THE PUBLISH IS REAL, AND THE SCAFFOLD WAS VERIFIED BEFORE A LINE WAS
// WRITTEN (MOTIR-3788's scaffold clause). `design-result-seed.ts` says the
// register path is unreachable under E2E because the server `head`s a store
// whose host resolves nowhere. That was true when it was written and is not now:
// MOTIR-2389 / MOTIR-2395 replaced the fabricated-URL branch with an IN-PROCESS
// transport at the S3 SDK's `requestHandler` (`lib/test-blob-mock.ts`, installed
// by `instrumentation.ts` behind `E2E_TEST_BLOB=1`), and that mock answers HEAD
// from what PUT stored. So this spec publishes through the REAL tool over the
// REAL `/api/mcp` route with a REAL token, and the row it asserts on is one the
// product wrote. The full finding is in `_helpers/design-publish-seed.ts`.
//
// ⚠️ NO STUB ON THE PUBLISH SIDE, deliberately. A `page.route` would make the
// spec assert its own harness: the entire claim is that a token-holding agent —
// in a repository with no publisher script and no design lane — can put a design
// result on a card, and a stubbed transport proves nothing about the gate, the
// permission map, or the service's own refusals.
//
// The BROWSER's read of the `.png` still follows the content route's 302 to a
// real presigned URL, which `servePrivateObjectStore` refuses unless it is
// signed. Nothing leaves localhost in either direction.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered landmark,
// a response the test armed BEFORE the action, or an element's own visible
// state. There is no `waitForTimeout`. The only holds are `chapter()` /
// `beat()`'s pacing, which run AFTER each phase has already asserted.

test.describe.configure({ timeout: 240_000 });

const b64 = (b: Buffer) => b.toString('base64');

/** Open an MCP session as an AGENT would — a bearer, no cookie, no session. */
async function agentSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'design-publish-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function publish(client: Client, key: string): Promise<CallToolResult> {
  return client.callTool({
    name: 'publish_design_result',
    arguments: {
      key,
      assets: [
        {
          kind: 'mock',
          sourcePath: MOCK_SOURCE_PATH,
          contentType: 'text/html',
          contentBase64: b64(Buffer.from(MOCK_HTML)),
        },
        {
          kind: 'image',
          sourcePath: IMAGE_SOURCE_PATH,
          contentType: 'image/png',
          contentBase64: b64(PNG_BYTES),
        },
        {
          kind: 'note_file',
          sourcePath: NOTE_SOURCE_PATH,
          contentType: 'text/markdown',
          contentBase64: b64(Buffer.from(NOTE_MD)),
        },
      ],
      // The SECTIONS this card wrote — the responsibility the ADR's Q2 moved on
      // to the agent, and the thing the prompt now names.
      noteMd: NOTE_MD,
      producedByKey: key,
    },
  }) as Promise<CallToolResult>;
}

test.describe('an agent publishes a design result and a reviewer reads it', () => {
  let seed: DesignPublishSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignPublish('robin.vale@design-publish.test');
  });

  test('the design result arrives from a tool call, not from CI', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-3780');

    await servePrivateObjectStore(page);

    // ⚠️ THE MOCK'S BYTES ARE SERVED AT THE APP'S CONTENT ROUTE, and the reason
    // is a browser limitation rather than a shortcut — the same one
    // `design-result.spec.ts` documents. The mock renders in a frame with
    // `sandbox=""`, so its document loads into an OPAQUE origin; the content
    // route's 302 is interceptable, but the fetch that FOLLOWS it is made by
    // the frame against the store host and escapes `page.route` entirely,
    // dying `ERR_NAME_NOT_RESOLVED` against the `.invalid` TLD. (Observed on
    // this spec's first run.) A receipt someone watches must not show a broken
    // frame for a feature that works.
    //
    // Nothing the spec is ABOUT is stubbed: the publish is real, and the `.png`
    // below keeps its real content-route → signed-URL → store hop, which is why
    // this handler passes every non-HTML response straight through.
    await page.route('**/api/attachments/*/content', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';
      if (location.includes('.html')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: MOCK_HTML,
        });
        return;
      }
      await route.fulfill({ response });
    });

    await chapter('A design card, with nothing published on it yet', async () => {
      await signIn(page, seed.email, seed.password);
      await page.goto(`/items/${seed.emptyKey}`);
      await expect(page.getByRole('heading', { name: seed.emptyTitle })).toBeVisible();
      // The empty state, driven rather than assumed — the panel is exercised
      // across its states, not only its happy one.
      await expect(page.getByText('No design result published yet')).toBeVisible();
      await beat();
    });

    await chapter('The agent publishes — one call, a bearer token, no browser', async () => {
      // ⚠️ The credential holds exactly `CLI_TOKEN_GRANT` (see the seed), so a
      // green run here is evidence about the door a DISPATCHED run comes
      // through — not about a workspace PAT that can do anything.
      const client = await agentSession(seed.token, baseURL!);
      const result = await publish(client, seed.publishedKey);

      expect(
        result.isError,
        `the CLI grant could not publish: ${JSON.stringify(result)}`,
      ).toBeFalsy();
      const payload = result.structuredContent as { assetCount?: number; workItemKey?: string };
      expect(payload.workItemKey).toBe(seed.publishedKey);
      expect(payload.assetCount).toBe(3);

      await client.close();
      await beat();
    });

    await chapter('The reviewer opens the card and the result is there', async () => {
      await page.goto(`/items/${seed.publishedKey}`);
      await expect(page.getByRole('heading', { name: seed.publishedTitle })).toBeVisible();

      // The panel exists on the card that PRODUCED the design — the leaf, never
      // rolled up to its story.
      await expect(page.getByText('Design result', { exact: false }).first()).toBeVisible();

      // The NOTE the agent chose to send. Its `##` arrives as a real heading,
      // which is what makes "send the sections, not the file" a readable
      // outcome rather than a size limit.
      // `exact` because a heading name matches by SUBSTRING, and the belt to
      // the seed's braces: the constant is already chosen to share no words
      // with either card title.
      await expect(page.getByRole('heading', { name: NOTE_HEADING, exact: true })).toBeVisible();
      await expect(page.getByText(NOTE_BODY, { exact: false })).toBeVisible();
      await beat();
    });

    await chapter('All three artifacts are on the card', async () => {
      // The mock, present as the sandboxed frame the sibling spec inspects in
      // depth — asserted here only as ARRIVED, since what is new is that a tool
      // put it there.
      await expect(page.locator('iframe').first()).toBeVisible();

      // The screenshot, addressed by the accessible name the panel gives it —
      // the asset's own basename — and fetched by the BROWSER through the
      // content route's 302 to a signed URL the store would refuse unsigned.
      await expect(page.getByRole('img', { name: 'readiness-rail.png' })).toBeVisible();
      await beat();
    });

    await chapter('The reviewer withdraws it, and the card is empty again', async () => {
      // The terminal / destructive action (MOTIR-3215's route). It is
      // SESSION-authed on purpose: publishing is something a build does,
      // withdrawing is a judgement somebody MAKES, so the record must be able
      // to name a person. `page.request` carries the signed-in context's
      // cookies, which is exactly that person.
      const response = await page.request.delete(
        `/api/work-items/${seed.publishedKey}/design-evidence`,
        { data: { reason: 'Published against the wrong card.' } },
      );
      expect(response.status(), await response.text()).toBe(200);

      await page.reload();
      await expect(page.getByRole('heading', { name: seed.publishedTitle })).toBeVisible();
      // A withdrawn result is not current, so the panel falls back to the empty
      // state — the row survives, which is settled law in this domain, but the
      // card stops claiming a design it did not earn.
      await expect(page.getByText('No design result published yet')).toBeVisible();
      await beat();
    });
  });
});
