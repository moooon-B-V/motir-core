import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { SUSPENDED_ACCOUNT_MESSAGE, assertAccountNotSuspended } from '@/lib/auth/accountSuspension';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The SIGN-IN half of an account suspension (MOTIR-1167).
 *
 * `platformSupportService.setSuspended` revokes the sessions already open —
 * `platformSupportService.test.ts` asserts that. This file is the other
 * direction: the next attempt to open one.
 *
 * ⚠️ THE PLACEMENT IS THE PROPERTY, AND IT IS ASSERTED STRUCTURALLY. Motir has
 * four ways in — email + password, Google, the two-factor challenge, and the
 * RFC 8628 device grant behind `motir login` — none of which shares an endpoint
 * with the others, and all of which end in a `session` row. A check on one
 * endpoint lets a suspended account in through the next; a check on all four is
 * a check somebody has to remember to add to the fifth. So the last case below
 * reads `lib/auth/index.ts` and asserts the guard hangs off the ONE seam they
 * all funnel through, because that is the thing a future refactor can quietly
 * undo without failing any behavioural test.
 */

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the guard', () => {
  it('lets an ordinary account open a session', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await expect(assertAccountNotSuspended(user.id)).resolves.toBeUndefined();
  });

  it('refuses a suspended account, with a message the person can act on', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.user.update({
      where: { id: user.id },
      data: { suspendedAt: new Date(), suspendedReason: 'suspected payment fraud' },
    });

    await expect(assertAccountNotSuspended(user.id)).rejects.toMatchObject({
      body: { code: 'ACCOUNT_SUSPENDED', message: SUSPENDED_ACCOUNT_MESSAGE },
    });
  });

  it('⚠️ never leaks the OPERATOR’S reason to the person being refused', async () => {
    // The reason is written for other operators. "Reason: suspected payment
    // fraud" is not a sentence to hand a customer through a login form — and it
    // is the one string on the row that a well-meaning "make the error helpful"
    // change would reach for.
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.user.update({
      where: { id: user.id },
      data: { suspendedAt: new Date(), suspendedReason: 'suspected payment fraud' },
    });

    const err = await assertAccountNotSuspended(user.id).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain('suspected payment fraud');
    expect(SUSPENDED_ACCOUNT_MESSAGE).not.toContain('fraud');
  });

  it('lets the account back in the moment the suspension is lifted', async () => {
    const user = await createTestUser({ email: 'ada@example.com' });
    await adminDb.user.update({
      where: { id: user.id },
      data: { suspendedAt: new Date(), suspendedReason: 'abuse' },
    });
    await expect(assertAccountNotSuspended(user.id)).rejects.toBeDefined();

    await adminDb.user.update({
      where: { id: user.id },
      data: { suspendedAt: null, suspendedReason: null },
    });
    // ⚠️ READ FRESH, NOT CACHED. A suspension applied — or lifted — thirty
    // seconds ago must bite on the next attempt, not on the next deploy. This is
    // the same reason `platformStaffRepository` reads `platformRole` fresh per
    // request instead of caching it into the session.
    await expect(assertAccountNotSuspended(user.id)).resolves.toBeUndefined();
  });

  it('stays quiet for an id that names no account', async () => {
    // Better-Auth is mid-flight creating a session for a principal it has
    // already resolved. Inventing a refusal for a row that is not there would
    // turn an unrelated fault into a misleading "you are suspended"; the insert
    // fails on its own foreign key instead.
    await expect(assertAccountNotSuspended('user_does_not_exist')).resolves.toBeUndefined();
  });
});

describe('where it is wired', () => {
  it('hangs off `session.create.before` — the ONE seam every sign-in path ends at', () => {
    const source = readFileSync('lib/auth/index.ts', 'utf8');
    // A structural assertion, and it is here because the alternative placements
    // all BEHAVE correctly for the path they cover. A guard moved onto
    // `signInEmail` would pass every behavioural test above and let a suspended
    // account in through Google.
    const hook = /session:\s*\{\s*create:\s*\{\s*before:/;
    expect(source).toMatch(hook);
    expect(source).toContain('assertAccountNotSuspended(session.userId)');
  });

  it('both credential sign-in surfaces tell the person, instead of blaming the password', () => {
    // ⚠️ THE BUG THIS PINS WAS REAL AND WAS FOUND BY RENDERING IT. Both forms map
    // ANY failed credential sign-in to "that password isn't right" — a unified
    // message, deliberately, so the form enumerates no accounts. For a suspended
    // account that message is FALSE: the password WAS right, so the person
    // resets a working password, still gets in nowhere, and the suspension an
    // operator applied is invisible to the only person it happened to.
    //
    // Distinguishing it enumerates nothing, because of WHEN the code is raised:
    // the guard hangs off `session.create`, which runs only after the credential
    // has verified. (The other credential surface — the public auth dialog —
    // moved to motir-marketing in MOTIR-3951, so only the sign-in card remains
    // in this repository to assert.)
    const source = readFileSync('app/(auth)/sign-in/_components/SignInCard.tsx', 'utf8');
    expect(source).toContain("code === 'ACCOUNT_SUSPENDED'");
    expect(source).toContain('signInErrorKey(result.error)');
  });

  it('the message it renders is the same one the guard raises', () => {
    // A constant in `lib/auth` and a catalogue key in `messages/*.json` is
    // exactly the pair that drifts, and the drift is silent — the form would
    // simply render a different sentence than the API returned. Asserted for
    // BOTH catalogues, since a key present in `en` and missing in `zh` is a
    // runtime miss on one locale only.
    const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as {
      auth: { accountSuspended: string; wrongPassword: string };
    };
    const zh = JSON.parse(readFileSync('messages/zh.json', 'utf8')) as {
      auth: { accountSuspended: string };
    };
    expect(en.auth.accountSuspended).toBe(SUSPENDED_ACCOUNT_MESSAGE);
    expect(zh.auth.accountSuspended).toBeTruthy();
    expect(en.auth.accountSuspended).not.toBe(en.auth.wrongPassword);
  });

  it('throws rather than returning `false`', () => {
    // ⚠️ THE ONE THING THE FRAMEWORK MAKES EASY IS THE WRONG THING.
    // `createWithHooks` treats a `false` return as "skip the insert" and
    // resolves the whole call to `null`, so the endpoint would answer with a
    // successful shape carrying no session and the browser would land on a
    // signed-out app with no explanation. `APIError` is the framework's own
    // refusal channel and becomes the HTTP response.
    const source = readFileSync('lib/auth/accountSuspension.ts', 'utf8');
    expect(source).toContain('throw new APIError(');
    expect(source.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/return\s+false/);
  });
});
