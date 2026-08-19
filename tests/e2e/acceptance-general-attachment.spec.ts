import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { PRIVATE_STORE_ORIGIN, servePrivateObjectStore } from './_helpers/object-store';
import {
  FINDINGS_FILENAME,
  FINDINGS_MARKDOWN,
  seedGeneralAttachment,
  type GeneralAttachmentSeed,
} from './_helpers/general-attachment-seed';

// Story MOTIR-3000 — an agent can put ANY deliverable on the card (MOTIR-3061).
//
// The story's `verification_recipe`, driven in a browser, and its ACCEPTANCE
// RECEIPT. Every other card in this story is invisible from outside the
// codebase — a route, a tool, an enum value, a query predicate — and this is the
// one that shows the OUTCOME rather than the mechanism: a file sent by a token
// is on the card a person is already looking at.
//
// ⚠️ THIS IS NOT THE DESIGN JOURNEY, and the difference is why the card was
// re-scoped. "A design card's rendered asset appears on the work item" is
// MOTIR-2664's journey, shipped 2026-08-12 and already driven by
// `design-result.spec.ts`. Re-deriving it here would cost the same and prove
// something already proven, while leaving what this story actually adds
// untested end to end. So the deliverable under test is deliberately the one
// with NO lifecycle behind it — a findings document, nobody's special case,
// which is exactly what had no path before.
//
// ⚠️ NO REAL CODING AGENT IS LAUNCHED. The upload is performed by the test
// against the real v1 route with a real token. Spawning an agent would make this
// slow, expensive, model-dependent and non-deterministic in the way that gets a
// spec quarantined — and what it would test is the agent's judgement, not
// Motir's behaviour. The instruction an agent receives is a string, pinned by a
// unit test on MOTIR-3059, several altitudes cheaper.
//
// Blob plumbing, as `attachments.spec.ts` documents it: the dev server runs with
// `E2E_TEST_BLOB=1`, so the SERVER-side store calls are intercepted at the SDK
// transport, while the BROWSER's read follows the content route's 302 to a real
// presigned URL that `servePrivateObjectStore` refuses unless it is signed.
// Nothing leaves localhost in either direction.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered landmark
// or a response the test armed BEFORE the action. The only holds are
// `chapter()` / `beat()`'s pacing, which run after each phase has asserted.

test.describe.configure({ timeout: 180_000 });

test.describe('the general attachment door', () => {
  let seed: GeneralAttachmentSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedGeneralAttachment('robin.vale@general-door.test');
  });

  test('a deliverable uploaded through the public API is on the card, with no pull request opened', async ({
    page,
    request,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-3000');
    await servePrivateObjectStore(page);

    // Hoisted: the last chapter reads the row the FIRST chapter created.
    let attachmentId = '';

    await chapter('An agent finishes a spike and has a document to hand back', async () => {
      // The upload an AGENT makes: a bearer token, no session, no cookie. This is
      // the request the whole story exists to make possible, and it is issued from
      // Playwright's API context precisely because a browser cannot make it.
      const upload = await request.post(
        `${baseURL}/api/v1/work-items/${seed.itemKey}/attachments`,
        {
          headers: { Authorization: `Bearer ${seed.token}` },
          multipart: {
            file: {
              name: FINDINGS_FILENAME,
              mimeType: 'text/markdown',
              buffer: Buffer.from(FINDINGS_MARKDOWN, 'utf8'),
            },
          },
        },
      );
      expect(upload.status(), await upload.text()).toBe(201);
      const created = (await upload.json()) as {
        id: string;
        source: string;
        workItemKey: string;
      };
      attachmentId = created.id;
      expect(created.source).toBe('api');
      expect(created.workItemKey).toBe(seed.itemKey);
      await beat();
    });

    await chapter(
      'The reviewer opens the work item — and the document is simply there',
      async () => {
        await signIn(page, seed.email, seed.password);
        await page.goto(`/items/${seed.itemKey}`);
        await expect(page.getByRole('heading', { name: seed.itemTitle })).toBeVisible();

        // The claim, in the form a person checks it: the file is in the panel they
        // were already looking at. Nobody opened a pull request to get here.
        const attachmentCard = page.getByText(FINDINGS_FILENAME, { exact: false });
        await expect(attachmentCard).toBeVisible();
        await beat();
      },
    );

    await chapter(
      'It is attributed to whoever holds the token, with no special treatment',
      async () => {
        // The panel already names an uploader for every attachment, which is what
        // makes an agent's upload legible WITHOUT any component change — the
        // agent/person distinction stayed DATA (attachment-api-door.md §2).
        await expect(page.getByText('Robin Vale').first()).toBeVisible();
        await beat();
      },
    );

    await chapter('Opening it reads the file through the signed content path', async () => {
      // The browser fetches `/api/attachments/<id>/content`; the server mints a
      // signed URL and 302s to the private store, which refuses anything unsigned.
      // ⚠️ Asserted at the REDIRECT, not by following it. The 302 points at the
      // private store's host, which resolves nowhere by design — and Playwright's
      // API context does not pass through the `page.route` interception that
      // serves it to the BROWSER. So the contract under test is the hop itself:
      // the app hands back a signed URL on the store rather than serving bytes.
      const redirect = await page.request.get(`/api/attachments/${attachmentId}/content`, {
        maxRedirects: 0,
      });
      expect(redirect.status()).toBe(302);
      const location = redirect.headers()['location'] ?? '';
      expect(location).toContain(PRIVATE_STORE_ORIGIN);
      // Signed, not a bare object URL — the store refuses anything unsigned.
      expect(location).toContain('X-Amz-Signature');
      await beat();
    });
  });

  test('a token from another workspace cannot reach the item, and reveals nothing', async ({
    request,
    baseURL,
  }) => {
    // The security property, kept out of the recording because it is a claim
    // about a REFUSAL and there is nothing to watch.
    const other = await seedGeneralAttachment('mallory@elsewhere.test', 'ELSE');

    const refused = await request.post(`${baseURL}/api/v1/work-items/${seed.itemKey}/attachments`, {
      headers: { Authorization: `Bearer ${other.token}` },
      multipart: {
        file: { name: 'probe.md', mimeType: 'text/markdown', buffer: Buffer.from('probe') },
      },
    });

    expect(refused.status()).toBe(404);
    const body = await refused.text();
    // Nothing about the other tenant's item survives into the answer.
    expect(body).not.toContain(seed.itemTitle);
    expect(body).not.toContain(seed.workspaceId);
  });
});
