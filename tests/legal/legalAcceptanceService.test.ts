import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';
import { listLegalDocuments } from '@/lib/legal/documents';
import { RECONSENT_DOCUMENT_SLUGS } from '@/lib/legal/consent';
import { legalAcceptanceRepository } from '@/lib/repositories/legalAcceptanceRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `legalAcceptanceService` against a REAL Postgres (Story 8.4 · Subtask
// MOTIR-1135) — the repo's testing contract, and the only way to test the thing
// this card's acceptance criterion actually asks for: that the record
// **PERSISTS**, verified by a create → read-back path. A mocked repository would
// assert that we called a function.
//
// `legal_acceptance` FKs against `user` with `ON DELETE CASCADE`, so
// `truncateAuthTables`'s existing `"user" … CASCADE` reaches it and no new
// truncate target is needed (which also keeps
// `tests/rls/test-singleton-statement-guard.test.ts`'s raw-statement ratchet
// where it is).

async function makeUser(email: string) {
  return adminDb.user.create({
    data: { email, name: email.split('@')[0]!, emailVerified: true },
  });
}

/** The three documents the re-consent set covers, as published today. */
function publishedReconsentVersions(): Record<string, string> {
  const published = listLegalDocuments();
  return Object.fromEntries(
    RECONSENT_DOCUMENT_SLUGS.map((slug) => [
      slug,
      published.find((document) => document.slug === slug)!.version,
    ]),
  );
}

describe('legalAcceptanceService', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('records one row per document in the re-consent set, at the published version', async () => {
    const user = await makeUser('records@example.com');

    const created = await legalAcceptanceService.recordAcceptance(user.id);
    expect(created).toBe(RECONSENT_DOCUMENT_SLUGS.length);

    // READ BACK from the database, not from the return value — the criterion is
    // that it persisted.
    const rows = await adminDb.legalAcceptance.findMany({
      where: { userId: user.id },
      orderBy: { documentSlug: 'asc' },
    });
    const published = publishedReconsentVersions();
    expect(rows.map((row) => row.documentSlug).sort()).toEqual(
      [...RECONSENT_DOCUMENT_SLUGS].sort(),
    );
    for (const row of rows) {
      expect(row.version).toBe(published[row.documentSlug]);
      expect(row.acceptedAt).toBeInstanceOf(Date);
    }
  });

  it('stamps ONE timestamp across the whole act', async () => {
    // `terms.md` §15 makes the three documents a single agreement and the
    // interstitial offers a single button, so three rows a few milliseconds
    // apart would misrepresent one decision as three.
    const user = await makeUser('one-moment@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    const rows = await adminDb.legalAcceptance.findMany({ where: { userId: user.id } });
    const distinct = new Set(rows.map((row) => row.acceptedAt.getTime()));
    expect(distinct.size).toBe(1);
  });

  it('is IDEMPOTENT — a replay writes nothing and preserves the original moment', async () => {
    // The signup hook can retry and the interstitial can be double-submitted.
    // The row is evidence, and the FIRST timestamp is the true one: a second
    // write stamping "now" over the moment somebody actually agreed would
    // quietly falsify the record.
    const user = await makeUser('replay@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);
    const first = await adminDb.legalAcceptance.findMany({ where: { userId: user.id } });

    const createdOnReplay = await legalAcceptanceService.recordAcceptance(user.id);
    expect(createdOnReplay).toBe(0);

    const after = await adminDb.legalAcceptance.findMany({ where: { userId: user.id } });
    expect(after).toHaveLength(first.length);
    expect(after.map((row) => row.acceptedAt.getTime()).sort()).toEqual(
      first.map((row) => row.acceptedAt.getTime()).sort(),
    );
  });

  it('reports nothing outstanding for a reader who just accepted', async () => {
    const user = await makeUser('current@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });

  it('reports every document outstanding for a reader who never accepted', async () => {
    // The state a lost signup-hook write leaves behind — and the reason that
    // write can afford to be best-effort: the gate catches it on the next
    // signed-in page load and records it there.
    const user = await makeUser('never@example.com');

    const outstanding = await legalAcceptanceService.resolveOutstanding(user.id);
    expect(outstanding.map((entry) => entry.slug)).toEqual([...RECONSENT_DOCUMENT_SLUGS]);
    expect(outstanding.every((entry) => entry.acceptedVersion === null)).toBe(true);
  });

  it('holds a reader whose accepted version is materially behind, and clears on acceptance', async () => {
    const user = await makeUser('behind@example.com');
    const published = publishedReconsentVersions();

    // Seed an acceptance a MAJOR behind what is published — the state a real
    // revision produces.
    await adminDb.legalAcceptance.createMany({
      data: RECONSENT_DOCUMENT_SLUGS.map((slug) => ({
        userId: user.id,
        documentSlug: slug,
        version: '0.9.0',
        acceptedAt: new Date('2026-01-01'),
      })),
    });

    const outstanding = await legalAcceptanceService.resolveOutstanding(user.id);
    expect(outstanding.map((entry) => entry.slug)).toEqual([...RECONSENT_DOCUMENT_SLUGS]);
    expect(outstanding[0]!.acceptedVersion).toBe('0.9.0');
    expect(outstanding[0]!.currentVersion).toBe(published[outstanding[0]!.slug]);

    // Agreeing records the CURRENT versions beside the old ones — append-only,
    // so the history survives — and clears the hold.
    await legalAcceptanceService.recordAcceptance(user.id);
    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
    expect(await adminDb.legalAcceptance.count({ where: { userId: user.id } })).toBe(
      RECONSENT_DOCUMENT_SLUGS.length * 2,
    );
  });

  it('does not hold a reader who is only a PATCH behind', async () => {
    // §14: a clarification or correction "takes effect when published". The one
    // behaviour this whole module exists to preserve, asserted end-to-end
    // against the real published versions rather than only in the pure unit.
    const user = await makeUser('patch@example.com');
    const published = publishedReconsentVersions();

    await adminDb.legalAcceptance.createMany({
      data: RECONSENT_DOCUMENT_SLUGS.map((slug) => {
        const [major, minor] = published[slug]!.split('.');
        return {
          userId: user.id,
          documentSlug: slug,
          // Same major and minor, a different patch — whatever moved was a patch.
          version: `${major}.${minor}.999`,
          acceptedAt: new Date('2026-01-01'),
        };
      }),
    });

    expect(await legalAcceptanceService.resolveOutstanding(user.id)).toEqual([]);
  });

  it('writes nothing, and touches no transaction, for an empty batch', async () => {
    // The early return is not decoration: `createMany` with `data: []` is a
    // pointless round trip, and the ONE caller that can produce an empty batch
    // is a deployment whose `content/legal/` has no re-consent documents in it.
    const count = await legalAcceptanceRepository.createMany(
      [],
      // Reached only if the guard fails — the point is that it is never used.
      null as never,
    );
    expect(count).toBe(0);
  });

  it('never reports one account acceptances inside another answer', async () => {
    const accepted = await makeUser('a@example.com');
    const notAccepted = await makeUser('b@example.com');
    await legalAcceptanceService.recordAcceptance(accepted.id);

    expect(await legalAcceptanceService.resolveOutstanding(accepted.id)).toEqual([]);
    expect(await legalAcceptanceService.resolveOutstanding(notAccepted.id)).toHaveLength(
      RECONSENT_DOCUMENT_SLUGS.length,
    );
  });

  it('takes the acceptance rows with the account', async () => {
    // `onDelete: Cascade` — the customer-facing promise on the account-deletion
    // surface is that a person's rows go with them, and an agreement to a
    // contract that ended with their account is not audit we keep afterwards.
    const user = await makeUser('deleted@example.com');
    await legalAcceptanceService.recordAcceptance(user.id);

    await adminDb.user.delete({ where: { id: user.id } });
    expect(await adminDb.legalAcceptance.count({ where: { userId: user.id } })).toBe(0);
  });
});
