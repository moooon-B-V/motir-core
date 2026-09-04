// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { db } from '@/lib/db';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { listLegalDocuments } from '@/lib/legal/documents';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT } from '../helpers/importGraph';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RECONSENT_FIXTURE, clearLegalManifest, setLegalManifest } from '../helpers/legalManifest';

// THE MANIFEST SEAM, RE-DRIVEN AFTER THE DELETION
// (Story MOTIR-4101 · Subtask MOTIR-4104).
//
// ⚠️ THIS IS NOT A COPY OF `legalManifestSeam.test.tsx`, AND THE DIFFERENCE IS
// THE WHOLE REASON THE FILE EXISTS. That file is MOTIR-4014's, under Story
// MOTIR-3909, and it owns the configured-arm seam, the malformed-manifest guard
// and the tenancy fixture — none of which is re-asserted here. It drove this
// wire while `content/legal/` was STILL IN THE TREE. A manifest that returns
// documents returns them whether or not something else is also reading files, so
// that run is silent, by construction, about whether the old source is gone.
// This one drives the same wire with the directory deleted.
//
// ⚠️ AND HERE IS WHAT MAKES THE RE-DRIVE MORE THAN A GESTURE, because it is not
// obvious and it is easy to write this file believing something false. With the
// documents deleted, a SURVIVING filesystem read is not silently wrong — it is
// LOUD. `readdirSync('content/legal')` on a directory that does not exist throws
// `ENOENT`; it does not return `[]`. So the assertions that would catch one are
// exactly the ones that say a call SUCCEEDS and answers an empty set — the
// unconfigured arm at the bottom of this file. Before the deletion those same
// assertions could not have caught anything, because the read would have
// succeeded and returned seven documents.
//
// That is why the structural guard (`./contentLegalReader.test.ts`) and this
// behavioural one are both owed and neither substitutes for the other: the guard
// says no module NAMES the old source, and this says the wire still WORKS with
// nothing behind it.
//
// ── ⚠️ THE MECHANISM THIS SUITE USES TO CONFIGURE THE MANIFEST ─────────────
// `MOTIR_LEGAL_DOCUMENTS` is a **server-side, process-wide `process.env` read**
// with no per-test override and no client seam a request stub could reach. This
// suite therefore sets the variable itself, through
// `tests/helpers/legalManifest.ts` (`setLegalManifest` / `clearLegalManifest`),
// and restores whatever was there before.
//
// **The runner reaches it** because `lib/legal/documents.ts` reads `process.env`
// at the moment of the CALL rather than at module load — its "NO MODULE-LEVEL
// CACHE, DELIBERATELY" decision — so a manifest set inside a test is the
// manifest the next call sees. A module that cached it would need a module reset
// per case, and a suite that forgot would silently assert the FIRST manifest for
// the whole file: green, and measuring one case N times. Nothing here needs a
// harness of its own, and nothing here asserts about the harness.

const CONFIGURED_TERMS_URL = 'https://motir.co/legal/terms';

// The two mocks `legalManifestSeam.test.tsx` and `reconsent-card.test.tsx` use,
// for the same reason: the card is a client component whose Agree button calls a
// Server Action and whose decline path calls better-auth's browser client.
// Neither is on the wire being proved — the hop is the `url` reaching the row's
// `href` — and a test environment has no cookies to give either of them.
vi.mock('@/app/(auth)/re-consent/_actions', () => ({
  acceptCurrentLegalDocumentsAction: async () => undefined,
}));
vi.mock('@/lib/auth/client', () => ({ signOut: async () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/re-consent',
}));

const { ReconsentCard } = await import('@/app/(auth)/re-consent/_components/ReconsentCard');

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
  return adminDb.user.create({ data: { email, name: 'Post-deletion', emailVerified: true } });
}

/** The premise this whole file measures under, asserted rather than assumed. */
function contentLegalIsAbsent(): boolean {
  return !existsSync(join(REPO_ROOT, 'content', 'legal'));
}

describe('the premise: content/legal/ is absent from the tree this process runs in', () => {
  it('has no content/legal directory on disk', () => {
    // ⚠️ ASSERTED IN THIS PROCESS, not inferred from a merged pull request. Every
    // assertion below is about behaviour "with the documents gone", and a suite
    // that never checked would keep making that claim on a checkout where they
    // had come back — reporting green about a state it was not in.
    expect(contentLegalIsAbsent(), `${join(REPO_ROOT, 'content', 'legal')} still exists`).toBe(
      true,
    );
    expect(existsSync(join(REPO_ROOT, 'content'))).toBe(false);
  });
});

describe('the configured wire still carries a manifest url end to end, with nothing in content/', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('runs manifest → documents → consent → service → rows → outstanding → the rendered href', async () => {
    expect(contentLegalIsAbsent()).toBe(true);
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser('post-deletion-seam@example.com');

    // 1 — the loader answers from the manifest, and from nothing else. There is
    //     no directory left for it to have merged a second source in from.
    expect(listLegalDocuments().find((d) => d.slug === 'terms')?.url).toBe(CONFIGURED_TERMS_URL);
    expect(listLegalDocuments()).toHaveLength(RECONSENT_FIXTURE.length);

    // 2 — sign-up records the manifest's versions, against real Postgres.
    expect(await legalAcceptanceService.recordAcceptance(user.id)).toBe(RECONSENT_FIXTURE.length);
    const rows = await adminDb.legalAcceptance.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.documentSlug).sort()).toEqual(
      RECONSENT_FIXTURE.map((d) => d.slug).sort(),
    );

    // 3 — the operator publishes a MATERIAL revision of the Terms.
    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version: '2.0.0', changeSummary: 'Adds the agent service.' },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);

    // 4 — the gate reads it back as outstanding, with the url attached.
    const outstanding = await legalAcceptanceService.resolveOutstanding(user.id);
    expect(outstanding.map((d) => d.slug)).toEqual(['terms']);
    expect(outstanding[0]!.url).toBe(CONFIGURED_TERMS_URL);

    // 5 — and the row a person actually sees links THAT url. The assertion lands
    //     on the `href` rather than on the service's return value because a value
    //     that reaches no prop is, from the row's side, indistinguishable from one
    //     that was never configured.
    renderWithIntl(<ReconsentCard documents={outstanding} destination="/home" />);
    expect(screen.getByRole('link', { name: /read the new version/i }).getAttribute('href')).toBe(
      CONFIGURED_TERMS_URL,
    );
  });
});

describe('the materiality rule survives with nothing in the tree — both directions, through the seam', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** Accept the fixture as it stands, then publish `version` for the Terms. */
  async function republishTerms(email: string, version: string) {
    restore = setLegalManifest(RECONSENT_FIXTURE);
    const user = await makeUser(email);
    await legalAcceptanceService.recordAcceptance(user.id);
    restore();
    restore = setLegalManifest([
      { ...RECONSENT_FIXTURE[0]!, version },
      RECONSENT_FIXTURE[1]!,
      RECONSENT_FIXTURE[2]!,
    ]);
    return legalAcceptanceService.resolveOutstanding(user.id);
  }

  it('a MINOR bump HOLDS the reader — asserted through the seam, not over consent.ts alone', async () => {
    // MINOR rather than MAJOR on purpose: a rule implemented as `major >
    // accepted.major` passes a major-bump test and fails every reader on a minor
    // one, which `motir.co/legal/terms` §14 calls material.
    expect(
      (await republishTerms('minor@post-deletion.example', '1.1.0')).map((d) => d.slug),
    ).toEqual(['terms']);
  });

  it('a MAJOR bump HOLDS the reader', async () => {
    expect(
      (await republishTerms('major@post-deletion.example', '2.0.0')).map((d) => d.slug),
    ).toEqual(['terms']);
  });

  it('a PATCH bump holds NOBODY — §14 says a clarification takes effect when published', async () => {
    expect(await republishTerms('patch@post-deletion.example', '1.0.1')).toEqual([]);
  });
});

describe('the UNCONFIGURED arm, with no manifest AND no content/legal/', () => {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    restore = clearLegalManifest();
  });
  // `restore?.()` rather than `restore()`: when the outer `beforeEach` throws —
  // a sibling vitest re-provisioning the per-worker databases mid-run is the one
  // that actually happens here — this hook runs with `restore` still undefined,
  // and a bare call replaces the real cause with `TypeError: restore is not a
  // function` on every case in the block.
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  // ⚠️ THIS IS THE DETECTOR. Each of the three is a deliberate empty-set arm
  // somewhere downstream, and *silently correct* is this story's whole failure
  // mode — so each says what the call DOES, never that nothing threw. But note
  // what "does not throw" buys HERE specifically, which it did not buy before
  // MOTIR-4103: with `content/legal/` deleted, a surviving `readdirSync` of it
  // raises `ENOENT` rather than answering `[]`. These three calls are therefore
  // the behavioural half of the absence claim — the structural guard says no
  // module NAMES the old source, and these say the wire completes with nothing
  // behind it.

  it('1 — recordAcceptance writes zero rows, and answers 0 rather than raising', async () => {
    const user = await makeUser('unconfigured-1@post-deletion.example');
    await expect(legalAcceptanceService.recordAcceptance(user.id)).resolves.toBe(0);
    expect(await adminDb.legalAcceptance.count({ where: { userId: user.id } })).toBe(0);
  });

  it('2 — resolveOutstanding answers [] , so a signed-in request is not held', async () => {
    const user = await makeUser('unconfigured-2@post-deletion.example');
    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });

  it('3 — the loader answers [] , which is the self-hoster’s state and not an error', async () => {
    // The top of the wire, asserted separately from the two service calls
    // because it is the one that would raise if a filesystem source had
    // survived: the service methods reach it through `reconsentDocuments()`, so
    // a throw there would be attributed to the service rather than to the read.
    expect(listLegalDocuments()).toEqual([]);
  });
});
