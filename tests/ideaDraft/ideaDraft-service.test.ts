import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ideaDraftService } from '@/lib/services/ideaDraftService';
import { ideaDraftRepository } from '@/lib/repositories/ideaDraftRepository';
import { DraftNotFoundError, EmptyIdeaError } from '@/lib/ideaDraft/errors';
import { MAX_PENDING_IDEA_LENGTH } from '@/lib/onboarding/pendingIdea';
import { truncateAuthTables } from '@/tests/helpers/db';

// Service tests for the cross-origin idea-draft handoff (Subtask 7.22.2 /
// MOTIR-1458), against real Postgres — create, single-use claim, TTL expiry, and
// the shared size/empty bound. The route layer's CORS / rate-limit / cookie is
// covered in ideaDraft-routes.test.ts.

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

/** Seed a draft directly with an explicit expiry (to simulate an expired row). */
async function seedDraft(idea: string, expiresAt: Date): Promise<string> {
  const row = await db.$transaction((tx) => ideaDraftRepository.create({ idea, expiresAt }, tx));
  return row.id;
}

describe('ideaDraftService.createDraft', () => {
  it('stores a draft and returns its opaque id', async () => {
    const { draftId } = await ideaDraftService.createDraft(
      'a tool for freelancers to send invoices',
    );
    expect(draftId).toBeTruthy();

    const row = await ideaDraftRepository.findByIdUnsafe(draftId);
    expect(row?.idea).toBe('a tool for freelancers to send invoices');
    // TTL is in the future (short-lived, but well beyond test wall-clock).
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('trims and clamps the idea to the shared cookie bound', async () => {
    const long = 'x'.repeat(MAX_PENDING_IDEA_LENGTH + 500);
    const { draftId } = await ideaDraftService.createDraft(`   ${long}   `);
    const row = await ideaDraftRepository.findByIdUnsafe(draftId);
    expect(row?.idea).toHaveLength(MAX_PENDING_IDEA_LENGTH);
  });

  it('rejects an empty / whitespace-only idea', async () => {
    await expect(ideaDraftService.createDraft('   ')).rejects.toBeInstanceOf(EmptyIdeaError);
    await expect(ideaDraftService.createDraft(undefined)).rejects.toBeInstanceOf(EmptyIdeaError);
    await expect(ideaDraftService.createDraft(42)).rejects.toBeInstanceOf(EmptyIdeaError);
  });
});

describe('ideaDraftService.claimDraft', () => {
  it('returns the idea and consumes the draft (single-use)', async () => {
    const { draftId } = await ideaDraftService.createDraft('an invoicing tool');

    const { idea } = await ideaDraftService.claimDraft(draftId);
    expect(idea).toBe('an invoicing tool');

    // The row is deleted on claim — a second claim finds nothing.
    expect(await ideaDraftRepository.findByIdUnsafe(draftId)).toBeNull();
    await expect(ideaDraftService.claimDraft(draftId)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it('rejects an unknown / forged id', async () => {
    await expect(ideaDraftService.claimDraft('does-not-exist')).rejects.toBeInstanceOf(
      DraftNotFoundError,
    );
  });

  it('treats an expired draft as absent and deletes it (no residue, no probe)', async () => {
    const id = await seedDraft('a stale idea', new Date(Date.now() - 1000));

    await expect(ideaDraftService.claimDraft(id)).rejects.toBeInstanceOf(DraftNotFoundError);
    // Expired row is swept even though the claim "failed" — no probing oracle.
    expect(await ideaDraftRepository.findByIdUnsafe(id)).toBeNull();
  });
});

describe('ideaDraftRepository.deleteExpired', () => {
  it('sweeps only rows past their TTL', async () => {
    const live = await ideaDraftService.createDraft('live idea');
    const stale = await seedDraft('stale idea', new Date(Date.now() - 1000));

    const removed = await db.$transaction((tx) =>
      ideaDraftRepository.deleteExpired(new Date(), tx),
    );
    expect(removed).toBe(1);
    expect(await ideaDraftRepository.findByIdUnsafe(stale)).toBeNull();
    expect(await ideaDraftRepository.findByIdUnsafe(live.draftId)).not.toBeNull();
  });
});
