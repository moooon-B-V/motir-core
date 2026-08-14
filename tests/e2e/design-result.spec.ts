import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedDesignResult, type DesignResultSeed } from './_helpers/design-result-seed';

// Story MOTIR-2664 — the design result on the work item (MOTIR-2672).
//
// The story's `verification_recipe`, driven in a browser, and its ACCEPTANCE
// RECEIPT: what this story ships is something a person LOOKS at, so the proof
// that it works is a recording of someone reading a design result in Motir.
//
// Two tests, split by what each can honestly prove.
//
// The FIRST is the recording: the panel, the rendered note, the sandboxed frame
// and the lightbox, driven the way a person drives them. Its artifact bytes are
// served at the app's own content route — see the block inside it for why a
// sandboxed frame leaves no other option.
//
// The SECOND runs unstubbed and asserts the hop the first one skips: the content
// route does not serve bytes, it 302s to a signed URL on the store. Between them
// the whole read path is covered, and neither test claims the other's ground.
//
// (Why the PUBLISH half is seeded rather than driven is written down in
// `_helpers/design-result-seed.ts` — the server cannot `head` an object in a
// store whose host resolves nowhere.)
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered landmark,
// an iframe `load`, or an element's own visible state. The only holds are
// `chapter()`/`beat()`'s pacing, which run AFTER each phase has already asserted.

test.describe.configure({ timeout: 240_000 });

/** A 1x1 PNG — enough for the lightbox to show a real image rather than a glyph. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A self-contained mock in the shape this feature publishes: inline CSS, no
 * `<script>`, no remote URL — and deliberately taller than the panel's 32rem
 * frame, so scrolling INSIDE it is a thing the recording can show.
 */
const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Design result mock</title>
<style>
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; color:#1f2330; background:#fff; }
  section { padding:24px 28px; border-bottom:1px solid #e6e8ef; }
  h2 { margin:0 0 6px; font-size:15px; }
  p { margin:0; color:#5b6172; }
  .swatch { height:120px; border-radius:10px; background:#eef1f8; margin-top:12px; }
</style></head><body>
${Array.from(
  { length: 12 },
  (_, i) =>
    `<section><h2>Panel ${i + 1}</h2><p>A published design mock, rendered inside the sandboxed frame.</p><div class="swatch"></div></section>`,
).join('\n')}
<section><h2>End of the mock</h2><p>Scrolled to the bottom, inside the frame.</p></section>
</body></html>`;

let seed: DesignResultSeed;

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedDesignResult('design-result@example.com');
});

test('a design result is published from CI and read on the work item', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2664');

  // ⚠️ THE ARTIFACTS ARE SERVED AT THE APP'S CONTENT ROUTE, NOT AT THE STORE,
  // and the reason is a browser limitation rather than a shortcut.
  //
  // The mock renders in a frame with `sandbox=""`, so its document loads into an
  // OPAQUE origin — and Chromium does not surface that frame's navigation to
  // Playwright's request interception, at `page.route` OR `context.route`. Both
  // were measured: the request escapes to the real network and dies
  // `ERR_NAME_NOT_RESOLVED` against the `.invalid` host. So the frame can be
  // sandboxed or be stubbed at the store, not both — and the sandbox is the
  // property under test. The screenshot is routed the same way for a plainer
  // reason: this recording is a RECEIPT someone watches, and a broken-image
  // glyph in it would misrepresent a feature that works.
  //
  // Nothing is lost by moving the stub one hop closer. Everything the video
  // exists to show is still real — the panel, the rendered note, the bounded
  // frame, the scrolling, the sandbox attribute itself, the lightbox. The one
  // hop skipped is content-route → signed URL → store, and that hop is asserted
  // directly, unstubbed, on this same artifact by the sibling test below.
  for (const [id, type] of [
    [seed.mockAttachmentId, 'text/html'],
    [seed.imageAttachmentId, 'image/png'],
  ] as const) {
    await page.route(`**/api/attachments/${id}/content`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': type },
        body: type === 'text/html' ? MOCK_HTML : PNG_BYTES,
      });
    });
  }

  await signIn(page, seed.email, seed.password);

  await chapter('Open the design subtask that CI published a result for', async () => {
    await page.goto(`/items/${seed.publishedKey}`);
    await expect(page.getByRole('heading', { name: seed.publishedTitle })).toBeVisible();
    // The panel is present on the card that PRODUCED the design — not rolled up
    // to its story, which would pile unrelated surfaces onto one panel.
    await expect(page.getByText('Design result', { exact: false }).first()).toBeVisible();
    await beat();
  });

  await chapter('Read the design note, rendered as Markdown', async () => {
    // The note goes through the single shipped Markdown renderer, so the `##`
    // section arrives as a real heading rather than as literal hashes.
    await expect(page.getByRole('heading', { name: seed.noteHeading })).toBeVisible();
    await expect(page.getByText(seed.noteBody, { exact: false })).toBeVisible();
    await beat();
  });

  await chapter('The mock renders inside a sandboxed frame', async () => {
    const frame = page.locator('iframe').first();
    await expect(frame).toBeVisible();

    // THE SECURITY PROPERTY, read off the real browser rather than the source.
    // `sandbox=""` grants nothing: with neither `allow-scripts` nor
    // `allow-same-origin`, a published mock cannot run code and cannot reach the
    // app's origin. This is the assertion that would catch someone loosening the
    // attribute to "just make a mock work".
    const sandbox = await frame.getAttribute('sandbox');
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');

    // The document actually loaded and rendered inside the frame.
    const inner = page.frameLocator('iframe').first();
    // `exact` matters: without it "Panel 1" also matches Panel 10, 11 and 12.
    await expect(inner.getByRole('heading', { name: 'Panel 1', exact: true })).toBeVisible();
    await beat();
  });

  await chapter('Scroll the mock — the page behind it stays put', async () => {
    const frame = page.locator('iframe').first();
    const inner = page.frameLocator('iframe').first();
    const end = inner.getByRole('heading', { name: 'End of the mock' });

    // ⚠️ A REAL WHEEL GESTURE, not `scrollIntoViewIfNeeded()`. Playwright drives
    // that helper by running its injected script INSIDE the target frame, and
    // `sandbox=""` withholds `allow-scripts` — so it cannot run and the call
    // hangs until the test times out. (Measured: 240s, on the assertion below.)
    // Nothing is lost: a wheel over the frame is what a reader actually does,
    // and it is dispatched by the browser rather than by script, so the sandbox
    // is irrelevant to it.
    //
    // The pair of assertions is the point. `toBeInViewport()` is a geometric
    // check Playwright makes from the OUTSIDE, so it also needs no script in the
    // frame — the bottom of a 13-section mock is out of view until the frame
    // itself scrolls, and in view afterwards.
    await expect(end).not.toBeInViewport();
    const pageScrollBefore = await page.evaluate(() => window.scrollY);

    await frame.hover();
    await expect(async () => {
      await page.mouse.wheel(0, 600);
      await expect(end).toBeInViewport({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    // The frame scrolled to its own end…
    await expect(end).toBeInViewport();
    // …and the document behind it did not move. A tall mock in an unbounded
    // container would have dragged the whole page instead.
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    await beat();
  });

  await chapter('Open the screenshot in the lightbox, and close it', async () => {
    await page.getByRole('button', { name: /design-result\.png/ }).click();
    const lightbox = page.getByRole('dialog');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('img', { name: 'design-result.png' })).toBeVisible();
    await beat();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await beat();
  });

  await chapter('The provenance says which run produced it', async () => {
    await expect(page.getByText(seed.commitSha, { exact: false })).toBeVisible();
    await expect(page.getByText(seed.producedByKey, { exact: false })).toBeVisible();
    await beat();
  });

  await chapter('A design subtask with nothing published reads as empty, not broken', async () => {
    await page.goto(`/items/${seed.emptyKey}`);
    await expect(page.getByRole('heading', { name: seed.emptyTitle })).toBeVisible();
    // The most-seen state for a long while — every design subtask that shipped
    // before this feature. It must say where a result comes from, so nobody
    // hunts for an upload control that does not exist.
    await expect(page.getByText('Design result', { exact: false }).first()).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    await beat();
  });
});

test('a design artifact is unreadable without a signature', async ({ page }) => {
  // The other half of the read path, asserted directly rather than implied: the
  // content route does not serve bytes, it 302s to a URL the store will only
  // honour when it carries a signature. Driven WITHOUT the store stub, so an
  // unsigned fetch has nothing to fall back to.
  await signIn(page, seed.email, seed.password);
  await page.goto(`/items/${seed.publishedKey}`);
  await expect(page.getByRole('heading', { name: seed.publishedTitle })).toBeVisible();

  const attachmentUrl = await page.locator('iframe').first().getAttribute('src');
  expect(attachmentUrl).toMatch(/^\/api\/attachments\/[^/]+\/content$/);

  const res = await page.request.get(attachmentUrl!, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const location = res.headers()['location'];
  // Off the app's origin, onto the store, carrying a signature.
  expect(location).toContain('e2e.s3.invalid');
  expect(location).toContain('X-Amz-Signature');
});
