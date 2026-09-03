// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { db } from '@/lib/db';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { listLegalDocuments } from '@/lib/legal/documents';
import { signUpLegalLinks, legalIndexUrl } from '@/lib/legal/links';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RECONSENT_FIXTURE, clearLegalManifest, setLegalManifest } from '../helpers/legalManifest';

// ⚠️ The two mocks `tests/components/reconsent-card.test.tsx` uses, and for the
// same reason: the card is a client component whose Agree button calls a Server
// Action and whose decline path calls better-auth's browser client. Neither is
// on this wire — the hop being proved is the `url` reaching the row's `href` —
// and a test environment has no cookies to give either of them.
vi.mock('@/app/(auth)/re-consent/_actions', () => ({
  acceptCurrentLegalDocumentsAction: async () => undefined,
}));
vi.mock('@/lib/auth/client', () => ({ signOut: async () => undefined }));
// And the router the card reads for its post-accept navigation — there is no app
// router mounted in a unit environment, and the hop being proved does not use it.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/re-consent',
}));

const { ReconsentCard } = await import('@/app/(auth)/re-consent/_components/ReconsentCard');

// THE MANIFEST SEAM, END TO END (Story MOTIR-3909 · MOTIR-4014).
//
// ⚠️ ONE TEST, ONE WIRE — and that is the whole point of this file rather than a
// stylistic preference. Every hop below already has a suite that proves it in
// isolation, and each of those mocks its neighbour: `legalDocuments` proves the
// parse, `legalConsent` proves the materiality rule over hand-built documents,
// `legalAcceptanceService` proves the rows, `reconsent-card` proves the render
// from a hand-built `OutstandingDocument`. **The one thing none of them can see
// is whether the value a manifest carries survives the whole path**, which is
// exactly where a source swap breaks things:
//
//   MOTIR_LEGAL_DOCUMENTS
//     → lib/legal/documents.ts      (parse + validate)
//     → lib/legal/consent.ts        (materiality)
//     → legalAcceptanceService      (rows, REAL Postgres)
//     → outstandingReconsent        (what is owed)
//     → LegalDocumentRow            (the rendered href)
//
// A value that exists in the manifest and reaches no prop is, from the row's
// side, indistinguishable from one that was never configured — so the assertion
// at the end is on the `href`, not on the service's return value.
//
// ── ⚠️ THE MECHANISM THIS SUITE USES TO CONFIGURE THE MANIFEST ─────────────
// `MOTIR_LEGAL_DOCUMENTS` is a process-wide `process.env` read with no per-test
// override and no client seam a request stub can reach, so this suite sets the
// variable itself through `tests/helpers/legalManifest.ts` and restores it. The
// runner reaches it because `lib/legal/documents.ts` reads
// `process.env` at the moment of the CALL rather than at module load — the
// no-cache decision, which is what makes a per-test manifest possible at all.
// A suite that cached it would need a module reset per case and would silently
// assert the first manifest for the whole file.

const CONFIGURED = 'https://motir.co/legal/terms';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string) {
  return adminDb.user.create({
    data: { email, name: 'Seam', emailVerified: true },
  });
}

describe('the whole wire, from a configured manifest to a rendered href', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('carries a manifest url end to end and renders it as the row’s link', async () => {
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser('seam@example.com');

    // 1 — the manifest is what the loader answers with.
    expect(listLegalDocuments().find((d) => d.slug === 'terms')?.url).toBe(CONFIGURED);

    // 2 — sign-up records the manifest's versions, against real Postgres.
    const written = await legalAcceptanceService.recordAcceptance(user.id);
    expect(written).toBe(RECONSENT_FIXTURE.length);
    const rows = await adminDb.legalAcceptance.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.version)).toEqual(RECONSENT_FIXTURE.map(() => '1.0.0'));

    // 3 — the operator publishes a MATERIAL revision of the Terms.
    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version: '2.0.0', changeSummary: 'Adds the agent service.' },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);

    // 4 — the gate reads that back as outstanding, with the url attached.
    const outstanding = await legalAcceptanceService.resolveOutstanding(user.id);
    expect(outstanding.map((d) => d.slug)).toEqual(['terms']);
    expect(outstanding[0]!.url).toBe(CONFIGURED);

    // 5 — and the row a person actually sees links THAT url. This is the hop
    //     every isolated suite mocks, and the reason the assertion lands here.
    renderWithIntl(<ReconsentCard documents={outstanding} destination="/home" />);
    expect(screen.getByRole('link', { name: /read the new version/i }).getAttribute('href')).toBe(
      CONFIGURED,
    );
  });

  it('a PATCH revision travels the same wire and holds NOBODY', async () => {
    // The other direction of the materiality rule, through the seam rather than
    // in isolation: `motir.co/legal/terms` §14 promises a clarification takes effect when
    // published, so a patch must not reach the row at all.
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser('patch@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version: '1.0.1' },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);

    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });

  it('a MINOR revision holds, so the rule is not just "major"', async () => {
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser('minor@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version: '1.1.0' },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);

    expect((await legalAcceptanceService.resolveOutstanding(user.id)).map((d) => d.slug)).toEqual([
      'terms',
    ]);
  });
});

describe('a MALFORMED manifest cannot hold the product', () => {
  let restore: () => void;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  it('an unparseable version is refused BEFORE it can reach isMaterialChange', async () => {
    // ⚠️ THIS IS THE ONE THAT MATTERS THROUGH THE SEAM. `isMaterialChange`
    // answers TRUE for a version it cannot parse — correctly, for a version in a
    // file we control. Reached by operator input it would hold EVERY signed-in
    // reader at a screen they cannot clear. The refusal in `documents.ts` is what
    // stops it, and this asserts the consequence rather than the mechanism.
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser('malformed@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version: 'two point oh' },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);

    // The entry never reaches the loader, so the gate has nothing to hold on.
    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });
});

describe('the UNCONFIGURED arm, asserted as four behaviours rather than one absence', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = clearLegalManifest();
  });
  afterEach(() => restore());

  // ⚠️ EACH OF THESE IS A DELIBERATE EMPTY-SET ARM SOMEWHERE DOWNSTREAM, and the
  // failure this whole story guards against is exactly the four of them being
  // silently correct together on a deployment that was supposed to be holding
  // people. "Nothing threw" is not the claim.
  it('1 — recordAcceptance writes zero rows and does not throw', async () => {
    const user = await makeUser('unconfigured@example.com');
    await expect(legalAcceptanceService.recordAcceptance(user.id)).resolves.toBe(0);
    expect(await adminDb.legalAcceptance.count({ where: { userId: user.id } })).toBe(0);
  });

  it('2 — resolveOutstanding answers [] , so no signed-in request is held', async () => {
    const user = await makeUser('unconfigured2@example.com');
    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });

  it('3 — sign-up gets NO legal links, so its notice does not render', () => {
    expect(signUpLegalLinks()).toBeNull();
  });

  it('4 — the rail gets no index, so it draws no Legal row', () => {
    expect(legalIndexUrl()).toBeNull();
  });
});

describe('tenancy isolation on the acceptance table', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = setLegalManifest(RECONSENT_FIXTURE);
  });
  afterEach(() => restore());

  it('one account’s acceptances are invisible to another', async () => {
    // ⚠️ THE FIXTURE MAKES THE ACTOR'S VIEW AND THE TRUE POPULATION DIFFER, on
    // purpose. A test whose actor happens to see everything cannot tell a scoped
    // read from an unscoped one — it passes identically with `withUserContext`
    // removed, which is the assertion silently ceasing to mean anything.
    const mine = await makeUser('mine@example.com');
    const theirs = await makeUser('theirs@example.com');
    await legalAcceptanceService.recordAcceptance(mine.id);
    await legalAcceptanceService.recordAcceptance(theirs.id);

    // The TRUE population is six rows — three each.
    expect(await adminDb.legalAcceptance.count()).toBe(RECONSENT_FIXTURE.length * 2);

    // The scoped read sees three, and none of them is theirs.
    const outstanding = await legalAcceptanceService.resolveOutstanding(mine.id);
    expect(outstanding).toEqual([]);
    const scoped = await adminDb.legalAcceptance.findMany({ where: { userId: mine.id } });
    expect(scoped).toHaveLength(RECONSENT_FIXTURE.length);
    expect(scoped.every((row) => row.userId === mine.id)).toBe(true);
  });
});
