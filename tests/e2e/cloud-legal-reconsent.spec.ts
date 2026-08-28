import { test, expect, type Page } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp, POST_AUTH_LANDING } from './_helpers/shell-session';
import { listLegalDocuments } from '@/lib/legal/documents';
import { RECONSENT_DOCUMENT_SLUGS } from '@/lib/legal/consent';

// THE RE-CONSENT JOURNEY, END TO END (Story 8.4 · Subtask MOTIR-1137, covering
// MOTIR-1135): a reader who is materially behind is HELD, agreeing RECORDS what
// they agreed to, and the screen does not come back.
//
// ── ⚠️ WHY THIS RIDES THE CLOUD LANE AND NOT A BULK SHARD ──────────────────
//
// `lib/legal/reconsentGate.ts` opens with `if (!isMotirCloud()) return null` —
// a self-hoster is their own controller and their own counterparty, so holding
// their users at a screen asking them to accept moooon B.V.'s Terms would be
// both wrong and unclearable. `playwright.config.ts` does not set `MOTIR_CLOUD`;
// `playwright.cloud.config.ts` does. So a copy of this spec on a bulk shard would
// pass against a build where the gate CANNOT FIRE — permanently, vacuously green,
// and green in exactly the way that made bug MOTIR-3713 invisible until it had
// red-lighted twenty-one acceptance specs.
//
// The vacuity is self-detecting here rather than merely argued: the first
// assertion of the journey is that the reader IS at `/re-consent`, so running
// this off-cloud fails loudly instead of passing quietly.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT ────────────────────────────
//
// **That a `model-providers.md` version bump prompts nobody.** It is the card's
// clause and it is covered — in `tests/legal/legalConsentJourney.test.ts`, where
// a version can actually be bumped. Driving it here would mean writing to
// `content/legal/` while the webServer serves it, which is a mutation of shared
// state under a lane that runs specs in one process against one deployment. The
// evidence is stronger at the integration tier anyway: there the bump is applied
// to the loader's REAL output and the exclusion is asserted over every document
// outside the set, not over one named file.
//
// **The data-subject-request journey.** That is 8.4.25's (MOTIR-3706), including
// the Privacy Policy §7 link into `/settings/account/data`. Stated so a later
// reader does not absorb it here.

test.describe.configure({ timeout: 120_000 });

const EMAIL = 'e2e-reconsent@example.com';
const RECONSENT_PATH = '/re-consent';

/** A MAJOR behind whatever is published — the state a real revision produces. */
const STALE_VERSION = '0.9.0';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** The versions published right now, by slug — the same read the service makes. */
function publishedVersions(): Map<string, string> {
  return new Map(listLegalDocuments().map((document) => [document.slug, document.version]));
}

/**
 * Put this account materially BEHIND, the way a published revision would.
 *
 * ⚠️ The rows are REWRITTEN rather than deleted, and that is the point of the
 * fixture. Deleting them produces a never-accepted reader, which is a different
 * (and already covered) state: the interstitial then renders its "New — version
 * x" arm and the acceptance table has no history to append to. What this card
 * asks for is the reader who agreed to an EARLIER version — the one whose row
 * has to survive beside the new one, because the agreement happened.
 */
async function makeStale(userId: string): Promise<void> {
  const updated = await adminDb.legalAcceptance.updateMany({
    where: { userId },
    data: { version: STALE_VERSION },
  });
  // Not vacuous: if sign-up ever stops recording acceptance, this would silently
  // update zero rows and the hold below would fire for the WRONG reason (a
  // never-accepted reader), quietly turning this into a different test.
  expect(updated.count, 'sign-up recorded acceptance to make stale').toBe(
    RECONSENT_DOCUMENT_SLUGS.length,
  );
}

async function acceptanceRows(userId: string) {
  return adminDb.legalAcceptance.findMany({
    where: { userId },
    orderBy: [{ documentSlug: 'asc' }, { version: 'asc' }],
  });
}

async function userId(email: string): Promise<string> {
  const user = await adminDb.user.findUnique({ where: { email } });
  expect(user, 'the account exists after sign-up').not.toBeNull();
  return user!.id;
}

/** Every settled destination the authed entry can produce, so nothing races. */
async function enterTheApp(page: Page): Promise<void> {
  await page.goto(POST_AUTH_LANDING);
  await page.waitForURL(
    (url) => url.pathname.startsWith(RECONSENT_PATH) || url.pathname.endsWith(POST_AUTH_LANDING),
    { timeout: 30_000 },
  );
}

test('a reader behind the current version is held, records their agreement, and is not asked again', async ({
  page,
}) => {
  // ── 1. A fresh account is CURRENT and is not held ────────────────────────
  // `signUp` settles on `/home`, which is itself the assertion: the hook
  // recorded acceptance, so the gate let this reader straight through. It is
  // also the control for step 3 — without it, "the prompt cleared" would be
  // indistinguishable from "the prompt never appears on this build".
  await signUp(page, EMAIL);
  const id = await userId(EMAIL);
  expect(new URL(page.url()).pathname).toContain(POST_AUTH_LANDING);

  // ── 2. Behind on all three ⇒ HELD at the interstitial ────────────────────
  await makeStale(id);
  await enterTheApp(page);

  expect(
    new URL(page.url()).pathname,
    'a materially behind reader was not held — is MOTIR_CLOUD set on this lane?',
  ).toContain(RECONSENT_PATH);

  // The screen names what moved. Three documents ⇒ the "all" arm of the label,
  // whose three forms are the copy's own (`legal.reconsent.agree*`).
  const agree = page.getByRole('button', { name: /^Agree (and|to both and|to all and) continue$/ });
  await expect(agree).toBeVisible();

  const published = publishedVersions();
  for (const slug of RECONSENT_DOCUMENT_SLUGS) {
    // The delta chip — `{from} → {to}` — is what makes this a NOTICE rather
    // than a formality, so it is asserted rather than taken on trust.
    await expect(
      page.getByText(`${STALE_VERSION} → ${published.get(slug)}`).first(),
      `${slug}'s version delta is not on the screen`,
    ).toBeVisible();
    // And the way to read what changed, per the design's own requirement.
    await expect(page.locator(`a[href="/legal/${slug}"]`)).toBeVisible();
  }

  // ── 3. Agreeing records the CURRENT versions and lets them through ───────
  await agree.click();
  await page.waitForURL(`**${POST_AUTH_LANDING}`, { timeout: 30_000 });
  await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });

  // ⚠️ READ THE RECORD BACK, not just the redirect. Being let through proves the
  // gate re-read; it does not prove a row was written, and the row is the whole
  // deliverable — it is the evidence Motir would have to produce if anyone asked
  // whether this person agreed to these terms.
  const rows = await acceptanceRows(id);
  expect(rows.length, 'the old rows survived beside the new ones').toBe(
    RECONSENT_DOCUMENT_SLUGS.length * 2,
  );
  for (const slug of RECONSENT_DOCUMENT_SLUGS) {
    const forSlug = rows.filter((row) => row.documentSlug === slug);
    expect(forSlug.map((row) => row.version).sort(), `${slug}'s acceptance history`).toEqual(
      [STALE_VERSION, published.get(slug)!].sort(),
    );
  }
  // ONE act, one moment — the three new rows share a timestamp.
  const accepted = rows.filter((row) => row.version !== STALE_VERSION);
  expect(new Set(accepted.map((row) => row.acceptedAt.getTime())).size).toBe(1);

  // ── 4. The prompt does not recur ─────────────────────────────────────────
  await enterTheApp(page);
  expect(new URL(page.url()).pathname, 'the interstitial came back').toContain(POST_AUTH_LANDING);
  await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });
});
