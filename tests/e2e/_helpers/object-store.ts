// The BROWSER-side half of the E2E object-store seam (MOTIR-2395).
//
// There are two halves, at two different layers, and conflating them is what
// this file exists to prevent:
//
//   1. SERVER-side — `lib/test-blob-mock.ts`, installed at the S3 SDK's own
//      transport by `instrumentation.ts` behind `E2E_TEST_BLOB=1`. It answers
//      the app's PUT / HEAD / GET / DELETE without touching the network. It
//      cannot see anything below, because those requests never leave the app.
//   2. BROWSER-side — this file. A **presigned URL is derived client-side** and
//      handed to the browser (the content route 302-redirects to it), so the
//      fetch that follows is made by Chromium against the configured endpoint
//      host. No server-side interception can reach it; a `page.route` can.
//
// Before MOTIR-2395 the gap was closed in the wrong place: `signedDownloadUrl`
// carried an `E2E_TEST_BLOB` branch returning a fabricated, signature-free URL,
// so the suite's "private" downloads proved nothing about access control. The
// branch is gone. The real presigner now runs under E2E, and this fulfiller
// stands in for the store — including the one behaviour that makes the private
// bucket private: **a request with no `X-Amz-Signature` is refused.**
//
// ⚠️ HOST COUPLING. `PRIVATE_STORE_URL` must equal `MOTIR_S3_ENDPOINT` in
// `playwright.config.ts` / `playwright.acceptance.config.ts` (`.invalid` is the
// reserved TLD — it resolves nowhere, by design, so an unrouted request fails
// loudly instead of reaching a real host). The PUBLIC bucket is a different
// origin entirely (`MOTIR_S3_PUBLIC_BASE_URL`) and is deliberately NOT served
// here: a public asset is fetched with no signature at all, which is what
// `tests/e2e/profile.spec.ts` drives as the other half of the two-store split.

import type { Page, Route } from '@playwright/test';

/** The S3 endpoint the app is configured with under E2E — see the host-coupling note. */
export const PRIVATE_STORE_ORIGIN = 'https://e2e.s3.invalid';

/** Every request the browser makes to the private store. */
export const PRIVATE_STORE_URL = /^https:\/\/e2e\.s3\.invalid\//;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 9 9]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);
/** An empty zip — enough for the browser to treat the download as a real file. */
const ZIP_BYTES = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

const BY_EXTENSION: Record<string, { type: string; body: Buffer }> = {
  '.png': { type: 'image/png', body: PNG_BYTES },
  '.pdf': { type: 'application/pdf', body: PDF_BYTES },
  '.zip': { type: 'application/zip', body: ZIP_BYTES },
  '.txt': { type: 'text/plain', body: Buffer.from('e2e') },
};

/**
 * The stored object's bytes, chosen by the KEY's extension. The uploader infixes
 * its random suffix BEFORE the extension precisely so this still works
 * (`shot.png` → `shot-k3f9a1.png`), and the browser's own content-type sniffing
 * depends on the same property.
 */
function bodyFor(pathname: string): { type: string; body: Buffer } {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  return BY_EXTENSION[ext] ?? { type: 'application/octet-stream', body: Buffer.from('e2e') };
}

/** What S3 answers an unsigned GET on a private object with. */
async function refuseUnsigned(route: Route): Promise<void> {
  await route.fulfill({
    status: 403,
    headers: { 'content-type': 'application/xml' },
    body:
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
  });
}

/**
 * Serve the PRIVATE object store to the browser, signature-gated.
 *
 * A request carrying `X-Amz-Signature` gets the object; one without it gets a
 * 403 `AccessDenied`, which is what makes "a private attachment is unreadable
 * without a signature" an assertion rather than a comment. `download: true`
 * binds `response-content-disposition` into the signature (an unsigned override
 * is rejected by S3, so it cannot ride as a bare query suffix) — echoing it back
 * as the response header is what fires the browser's download event.
 *
 * NOTE this validates the signature's PRESENCE, not its cryptographic
 * correctness: the interesting property under test is that the application mints
 * one at all, on the path production uses, and the 302's `Location` is where
 * that is asserted directly.
 */
export async function servePrivateObjectStore(page: Page): Promise<void> {
  await page.route(PRIVATE_STORE_URL, async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.get('X-Amz-Signature')) return refuseUnsigned(route);

    const { type, body } = bodyFor(url.pathname);
    const disposition = url.searchParams.get('response-content-disposition');
    await route.fulfill({
      status: 200,
      body,
      headers: {
        'content-type': type,
        ...(disposition ? { 'content-disposition': disposition } : {}),
      },
    });
  });
}
