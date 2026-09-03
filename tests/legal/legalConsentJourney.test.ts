import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { listLegalDocuments, type LegalDocument } from '@/lib/legal/documents';
import { RECONSENT_DOCUMENT_SLUGS, outstandingReconsent } from '@/lib/legal/consent';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setLegalManifest } from '../helpers/legalManifest';

// THE CONSENT RECORD, FROM THE DOOR A PERSON ACTUALLY COMES IN THROUGH
// (Story 8.4 · Subtask MOTIR-1137, covering MOTIR-1135).
//
// ── What `legalAcceptanceService.test.ts` already proves, and does not ──────
//
// That suite is thorough about the SERVICE: one row per document at the
// published version, one shared timestamp, idempotency, the materiality rule
// against the real published versions, and the per-account isolation. Every case
// starts from `adminDb.user.create` and calls `recordAcceptance(userId)` itself.
//
// So the one thing it cannot see is the WIRING — whether creating an account
// calls that method at all. That gap is not hypothetical:
// `legalAcceptanceService.recordAcceptance` is reached from ONE production
// seam, better-auth's `databaseHooks.user.create.after`, and a seam nothing
// asserts is a seam that can be dropped by a refactor with every unit still
// green. Bug MOTIR-3713 is what that looks like from the other side: seeded E2E
// users go through `usersService.createUser`, which bypasses the hook, so every
// one of them met the interstitial and twenty-one specs died — the asymmetry
// between the two account-creating paths, discovered in CI rather than here.
//
// ⚠️ AND IT IS THE CREATE-WHITELIST CLASS. A create path that silently drops a
// field is this repository's recurring defect, and the only instrument that
// catches it is a CREATE → READ-BACK through the real entry point. Asserting
// that a service writes a row it was handed proves the service; driving the
// sign-up API and reading the row back proves the product.

const BASE_URL = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
});

// ⚠️ THE MANIFEST IS CONFIGURED FOR THIS SUITE (MOTIR-4007). `lib/legal/documents.ts`
// reads `MOTIR_LEGAL_DOCUMENTS` rather than `content/legal/`, so a test process is
// an UNCONFIGURED deployment and `listLegalDocuments()` answers `[]` — correctly.
// This suite is about the SEAM behaving over a configured set, so it configures
// one; `tests/legal/legalDocuments.test.ts` owns the unconfigured arm.
const restoreManifest = setLegalManifest();

afterAll(async () => {
  restoreManifest();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The published set, by slug — the same read the service makes. */
function publishedBySlug(): Map<string, LegalDocument> {
  return new Map(listLegalDocuments().map((document) => [document.slug, document]));
}

describe('creating an account records what was agreed', () => {
  it('persists the accepted version and a timestamp for every document in the set', async () => {
    const email = 'signup-consent@example.com';
    const before = new Date();

    await auth.api.signUpEmail({
      body: { email, password: 'hunter2hunter2', name: 'Consenting Cass' },
      headers: { origin: BASE_URL },
    });

    const user = await adminDb.user.findUnique({ where: { email } });
    expect(user, 'sign-up created the account').not.toBeNull();

    const rows = await adminDb.legalAcceptance.findMany({
      where: { userId: user!.id },
      orderBy: { documentSlug: 'asc' },
    });

    // The SET is derived from the constant and the versions from the loader, so
    // publishing an eighth document or revising one of the three moves this
    // assertion with the product instead of against it.
    const published = publishedBySlug();
    expect(rows.map((row) => row.documentSlug).sort()).toEqual(
      [...RECONSENT_DOCUMENT_SLUGS].sort(),
    );

    for (const row of rows) {
      expect(row.version, `${row.documentSlug} recorded the wrong version`).toBe(
        published.get(row.documentSlug)!.version,
      );
      // ⚠️ THE TIMESTAMP IS ASSERTED AS A VALUE, not merely as non-null. A
      // column defaulting to `now()` is non-null however badly the write went;
      // what makes the row EVIDENCE is that the moment it names is the moment
      // the person agreed. Bounded on both sides, so a default that fires at
      // some unrelated instant is still caught.
      expect(row.acceptedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
      expect(row.acceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    }

    // ONE act, one moment — `motir.co/legal/terms` §15 makes the three documents a single
    // agreement, and three timestamps would misrepresent one decision as three.
    expect(new Set(rows.map((row) => row.acceptedAt.getTime())).size).toBe(1);
  });

  it('leaves a fresh account with nothing outstanding — the gate does not hold it', async () => {
    // The consequence a reader experiences, and the half a row-level assertion
    // cannot state: somebody who has just agreed is not immediately asked again.
    const email = 'signup-not-held@example.com';
    await auth.api.signUpEmail({
      body: { email, password: 'hunter2hunter2', name: 'Fresh Fern' },
      headers: { origin: BASE_URL },
    });

    const user = await adminDb.user.findUnique({ where: { email } });
    const { legalAcceptanceService } = await import('@/lib/services/legalAcceptanceService');
    expect(await legalAcceptanceService.resolveOutstanding(user!.id)).toEqual([]);
  });
});

// ── A DOCUMENT OUTSIDE THE SET MOVES WITHOUT ASKING ANYBODY ─────────────────
//
// `model-providers.md` is a factual roster that changes whenever a gateway
// channel is enabled (`docs/decisions/legal-document-set.md` §7, amended
// 2026-08-27), and `motir.co/legal/terms` §14 already promises that a change
// of that kind "takes effect when published". If a bump there prompted, every
// routing change would ask every user to re-agree — which is both a broken
// promise and the fastest way to teach people to click through the screen.
//
// ⚠️ WHY THIS IS NOT ALREADY GREEN. `legalConsent.test.ts` asserts the SET —
// `isReconsentDocument('model-providers')` is false — and separately that a
// BRAND-NEW slug does not start gating. Both are assertions about the constant.
// Neither drives a version bump of a document that is actually published, so the
// filter that turns that constant into behaviour (`reconsentDocuments()`) is
// never exercised against a moved document. That filter disappearing is the
// failure this describes, and it would leave every existing test green.
//
// The bump is applied to the loader's REAL output rather than to a fabricated
// list, and to whichever documents are outside the set rather than to a named
// one — so it keeps testing the right thing if the roster is renamed or a fifth
// excluded document is published.

describe('publishing a new version of an EXCLUDED document', () => {
  const inSet = (slug: string): boolean =>
    (RECONSENT_DOCUMENT_SLUGS as readonly string[]).includes(slug);

  it('prompts nobody — including for model-providers, the roster that moves most', async () => {
    const published = listLegalDocuments();
    const excluded = published.filter((document) => !inSet(document.slug));

    // Not vacuous: if every published document were in the set there would be
    // nothing to bump and the assertion below would pass having tested nothing.
    expect(excluded.map((document) => document.slug)).toContain('model-providers');

    // A MAJOR bump — the largest move the materiality rule recognises, so this
    // fails for the right reason if the exclusion is ever lost.
    const afterBump = published.map((document) =>
      inSet(document.slug)
        ? document
        : { ...document, version: `${Number(document.version.split('.')[0]) + 1}.0.0` },
    );

    const held = RECONSENT_DOCUMENT_SLUGS.map((slug) => ({
      documentSlug: slug,
      version: published.find((document) => document.slug === slug)!.version,
      acceptedAt: new Date('2026-01-01'),
    }));

    expect(outstandingReconsent(afterBump, held)).toEqual([]);
  });

  it('still prompts when a document INSIDE the set moves — the control', async () => {
    // Without this, the case above passes just as well against a function that
    // never prompts for anything. It is the same shape as the vacuity floors in
    // `legalPagesRender.test.tsx`: an exclusion is only meaningful beside an
    // inclusion that fires.
    const published = listLegalDocuments();
    const afterBump = published.map((document) =>
      inSet(document.slug)
        ? { ...document, version: `${Number(document.version.split('.')[0]) + 1}.0.0` }
        : document,
    );

    const held = RECONSENT_DOCUMENT_SLUGS.map((slug) => ({
      documentSlug: slug,
      version: published.find((document) => document.slug === slug)!.version,
      acceptedAt: new Date('2026-01-01'),
    }));

    expect(outstandingReconsent(afterBump, held).map((entry) => entry.slug)).toEqual([
      ...RECONSENT_DOCUMENT_SLUGS,
    ]);
  });
});
