import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RECONSENT_DOCUMENT_SLUGS } from '@/lib/legal/consent';

// THE RE-CONSENT GATE (Story 8.4 · Subtask MOTIR-1135) — what holds a signed-in
// reader, where it sends them, and the three things it must NEVER do: hold a
// self-hoster, build a redirect out of an unvalidated header, or take the whole
// signed-in product down when the database hiccups.
//
// Real Postgres for the acceptance rows (the repo contract). `next/headers` is
// stubbed because the test environment has no request — the same sanctioned
// exception `getSession` gets, and the header under test is precisely the thing
// being varied.

const requestHeaders = { current: new Headers() };
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { resolveReconsentHold, RECONSENT_PATH } = await import('@/lib/legal/reconsentGate');

async function makeUser(email: string) {
  return adminDb.user.create({
    data: { email, name: email.split('@')[0]!, emailVerified: true },
  });
}

/** A reader who is current on everything — the common case. */
async function makeCurrentUser(email: string) {
  const user = await makeUser(email);
  const { legalAcceptanceService } = await import('@/lib/services/legalAcceptanceService');
  await legalAcceptanceService.recordAcceptance(user.id);
  return user;
}

describe('resolveReconsentHold', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    requestHeaders.current = new Headers();
    vi.stubEnv('MOTIR_CLOUD', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('never holds a SELF-HOSTER, whatever they have accepted', async () => {
    // The card's own acceptance criterion: gating keys off the CLOUD document
    // version, self-hosters set their own. `content/legal/` ships as moooon
    // B.V.'s copy of OUR terms — a self-hoster is their own controller and their
    // own counterparty, so a hold asking them to accept our Terms would be both
    // wrong and unclearable.
    vi.stubEnv('MOTIR_CLOUD', '');
    const user = await makeUser('selfhost@example.com');
    expect(await resolveReconsentHold(user.id)).toBeNull();

    vi.stubEnv('MOTIR_CLOUD', 'false');
    expect(await resolveReconsentHold(user.id)).toBeNull();
  });

  it('lets a reader who is current carry on', async () => {
    const user = await makeCurrentUser('current@example.com');
    expect(await resolveReconsentHold(user.id)).toBeNull();
  });

  it('holds a reader with nothing on record', async () => {
    const user = await makeUser('never@example.com');
    expect(await resolveReconsentHold(user.id)).toEqual({ destination: RECONSENT_PATH });
  });

  it('carries the destination when the edge forwarded a path', async () => {
    // `x-current-path` is set by `proxy.ts` (MOTIR-3652). Landing somebody on a
    // generic dashboard after they clicked a specific link is the failure the
    // header exists to prevent.
    const user = await makeUser('deep-link@example.com');
    requestHeaders.current = new Headers({ 'x-current-path': '/items/MOTIR-1135' });

    expect(await resolveReconsentHold(user.id)).toEqual({
      destination: `${RECONSENT_PATH}?next=%2Fitems%2FMOTIR-1135`,
    });
  });

  it('falls back cleanly when the header is ABSENT — the state on main today', async () => {
    // The header is advisory and absent for any path off the matcher, which is
    // every path until MOTIR-3652 merges. The gate must be correct in that
    // world, not merely correct once the other card lands.
    const user = await makeUser('no-header@example.com');
    expect(await resolveReconsentHold(user.id)).toEqual({ destination: RECONSENT_PATH });
  });

  it('REFUSES a forged header rather than building an open redirect from it', async () => {
    // A client can send anything. An unvalidated redirect target taken from a
    // request header is an open redirect, and it is the one way this gate could
    // ship a vulnerability — so every one of these falls back to the bare path.
    const user = await makeUser('forged@example.com');
    for (const forged of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'items/MOTIR-1',
      '',
    ]) {
      requestHeaders.current = new Headers({ 'x-current-path': forged });
      expect(await resolveReconsentHold(user.id), forged).toEqual({
        destination: RECONSENT_PATH,
      });
    }
  });

  it('lets the request through when the acceptance read FAILS', async () => {
    // Fail open, deliberately: a database hiccup must not hold the entire
    // signed-in product at a legal interstitial. The record is still owed, and
    // the next page load asks again.
    const user = await makeUser('broken@example.com');
    const { legalAcceptanceService } = await import('@/lib/services/legalAcceptanceService');
    const spy = vi
      .spyOn(legalAcceptanceService, 'resolveOutstanding')
      .mockRejectedValueOnce(new Error('connection reset'));

    expect(await resolveReconsentHold(user.id)).toBeNull();
    spy.mockRestore();
  });

  it('holds a reader who is behind on one document of the three', async () => {
    const user = await makeCurrentUser('partly-behind@example.com');
    // Rewind ONE document to a version a major behind.
    await adminDb.legalAcceptance.deleteMany({
      where: { userId: user.id, documentSlug: RECONSENT_DOCUMENT_SLUGS[0] },
    });
    await adminDb.legalAcceptance.create({
      data: {
        userId: user.id,
        documentSlug: RECONSENT_DOCUMENT_SLUGS[0]!,
        version: '0.1.0',
        acceptedAt: new Date('2026-01-01'),
      },
    });

    expect(await resolveReconsentHold(user.id)).toEqual({ destination: RECONSENT_PATH });
  });
});
