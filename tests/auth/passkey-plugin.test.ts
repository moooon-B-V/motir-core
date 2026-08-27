import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { resolveBaseUrl, resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  PASSKEY_CHALLENGE_TTL_MINUTES,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_NAME_MAX_LENGTH,
  PASSKEY_RESIDENT_KEY,
  PASSKEY_RP_NAME,
  PASSKEY_USER_VERIFICATION,
} from '@/lib/auth/passkeyConfig';

// Story MOTIR-1214 · Subtask MOTIR-3610 — plugin, dependency and schema.
//
// The deliverable is a REGISTRATION and a MIGRATION, so this suite asserts the
// things that can silently be wrong about them — the same three shapes
// `two-factor-plugin.test.ts` pins for `twoFactor`, plus the one that is
// specific to WebAuthn:
//
//   1. The plugin is actually mounted. A `plugins: [...]` entry that throws at
//      module load, or a plugin whose endpoints never register, fails the same
//      way — the app boots and the passkey routes 404 at the moment a user
//      reaches for them.
//   2. The migration and the plugin agree about the table. The plugin addresses
//      `db.passkey` with ten exact camelCase keys through its adapter, and
//      renaming one in schema.prisma breaks it at RUNTIME with no typecheck
//      error. So a row is written and read back here through Prisma.
//   3. `userVerification` is `'required'`. This is the ONE option that decides
//      whether a passkey is one factor or two, SimpleWebAuthn's default is the
//      weaker value, and nothing about a working sign-in reveals which one is in
//      force. Read off the registered options object, never off a comment.
//
// Real Postgres, truncate between tests (CLAUDE.md: never mock the DB). The
// ceremonies themselves are not driven here — they need an authenticator, which
// is what the E2E card (MOTIR-3615) supplies via a CDP virtual authenticator.

type RegisteredPlugin = {
  id?: string;
  options?: {
    rpID?: string;
    rpName?: string;
    origin?: string | string[] | null;
    authenticatorSelection?: { userVerification?: string; residentKey?: string };
  };
};

async function registeredPasskeyPlugin(): Promise<RegisteredPlugin | undefined> {
  const { auth } = await import('@/lib/auth');
  return (auth.options.plugins as RegisteredPlugin[]).find((p) => p.id === 'passkey');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the passkey plugin is registered', () => {
  it('constructs the auth instance without throwing', async () => {
    const { auth } = await import('@/lib/auth');
    expect(auth).toBeDefined();
  });

  it('mounts all seven endpoints the story needs — both ceremonies and the management set', async () => {
    const { auth } = await import('@/lib/auth');

    // Registration: options, then verification (session-authenticated).
    expect(typeof auth.api.generatePasskeyRegistrationOptions).toBe('function');
    expect(typeof auth.api.verifyPasskeyRegistration).toBe('function');

    // Authentication: the PRE-SESSION half. `verifyPasskeyAuthentication` is what
    // mints the session directly — it is the reason a passkey sign-in never
    // reaches the two-factor challenge, and the reason MOTIR-3613's affordance
    // belongs on the sign-in card's email step.
    expect(typeof auth.api.generatePasskeyAuthenticationOptions).toBe('function');
    expect(typeof auth.api.verifyPasskeyAuthentication).toBe('function');

    // Management — the three the Security pane's section drives (MOTIR-3612).
    expect(typeof auth.api.listPasskeys).toBe('function');
    expect(typeof auth.api.updatePasskey).toBe('function');
    expect(typeof auth.api.deletePasskey).toBe('function');
  });

  it('leaves the pre-existing plugins mounted — this is an addition, not a replacement', async () => {
    const { auth } = await import('@/lib/auth');

    // twoFactor (MOTIR-1217) and deviceAuthorization (MOTIR-1865) share the same
    // handler. A plugins-array edit that dropped one would break account 2FA or
    // `motir login` with nothing else failing.
    expect(typeof auth.api.enableTwoFactor).toBe('function');
    expect(typeof auth.api.verifyTOTP).toBe('function');
    expect(typeof auth.api.deviceCode).toBe('function');
    expect(typeof auth.api.getSession).toBe('function');
  });
});

describe('the relying party is derived, never literal', () => {
  it('takes `rpID` from lib/baseUrl.ts as a bare hostname — no scheme, no port', async () => {
    const plugin = await registeredPasskeyPlugin();
    expect(plugin).toBeDefined();

    // The WebAuthn relying-party id is a HOSTNAME. Passing an origin here (or a
    // host:port) makes every ceremony fail with a mismatch the browser reports
    // and the server does not, so pin the derivation rather than the value —
    // the value differs per deployment, which is the whole reason it is derived.
    expect(plugin?.options?.rpID).toBe(new URL(resolveBaseUrl()).hostname);
    expect(plugin?.options?.rpID).not.toContain('://');
    expect(plugin?.options?.rpID).not.toContain(':');
  });

  it('takes `origin` from the same module, trailing slash trimmed', async () => {
    const plugin = await registeredPasskeyPlugin();

    // The plugin's own docstring: "Do NOT include any trailing /".
    expect(plugin?.options?.origin).toBe(resolveBaseUrlTrimmed());
    expect(String(plugin?.options?.origin ?? '').endsWith('/')).toBe(false);
  });

  it('names the product in `rpName` — this is what the OS prompt shows', async () => {
    const plugin = await registeredPasskeyPlugin();
    expect(plugin?.options?.rpName).toBe(PASSKEY_RP_NAME);
  });
});

describe('the credential is multi-factor on its own', () => {
  // THE load-bearing assertion of this card. SimpleWebAuthn defaults
  // `userVerification` to `'preferred'`, which accepts an assertion produced with
  // no PIN, no fingerprint and no face — possession only, ONE factor. Registration
  // and sign-in both work perfectly at `'preferred'`, so nothing observable tells
  // you which value is in force; only the registered options do. Story 8.13
  // (MOTIR-1215) counts `passkey` towards a require-2FA policy on the strength of
  // this line, so a silent regression here would quietly downgrade a security
  // policy rather than break a feature.
  it('registers `userVerification: "required"`', async () => {
    const plugin = await registeredPasskeyPlugin();

    expect(plugin).toBeDefined();
    expect(plugin?.options?.authenticatorSelection?.userVerification).toBe('required');
  });

  it('asks for a discoverable credential without demanding one', async () => {
    const plugin = await registeredPasskeyPlugin();

    // `'preferred'`, not `'required'`: a discoverable credential is what makes the
    // passwordless sign-in on the email step possible, but a hardware key with no
    // room for one is still a perfectly good second factor and should still
    // register.
    expect(plugin?.options?.authenticatorSelection?.residentKey).toBe('preferred');
  });
});

describe('the passkey schema', () => {
  async function makeUser(email: string, name: string) {
    return usersService.createUser({ email, password: 'hunter2hunter2', name });
  }

  it('round-trips a Passkey row under the exact field names the plugin adapter uses', async () => {
    const user = await makeUser('ada@example.com', 'Ada');

    // These ten keys are the plugin's own (`@better-auth/passkey`'s
    // `src/schema.ts`). If schema.prisma renamed one, this create would not
    // compile — which is the point of writing them all out rather than spreading
    // a fixture.
    const created = await adminDb.passkey.create({
      data: {
        name: 'MacBook',
        publicKey: 'cHVibGljLWtleQ',
        userId: user.id,
        credentialID: 'Y3JlZGVudGlhbC1pZA',
        counter: 0,
        deviceType: 'multiDevice',
        backedUp: true,
        transports: 'internal,hybrid',
        aaguid: 'adce0002-35bc-c60a-648b-0b25f1f05503',
      },
    });

    const read = await adminDb.passkey.findUniqueOrThrow({ where: { id: created.id } });
    expect(read.name).toBe('MacBook');
    expect(read.publicKey).toBe('cHVibGljLWtleQ');
    expect(read.userId).toBe(user.id);
    expect(read.credentialID).toBe('Y3JlZGVudGlhbC1pZA');
    expect(read.counter).toBe(0);
    expect(read.deviceType).toBe('multiDevice');
    expect(read.backedUp).toBe(true);
    expect(read.transports).toBe('internal,hybrid');
    expect(read.aaguid).toBe('adce0002-35bc-c60a-648b-0b25f1f05503');
    expect(read.createdAt).toBeInstanceOf(Date);
  });

  it('leaves the four optional fields nullable — registration supplies none of them', async () => {
    const user = await makeUser('grace@example.com', 'Grace');

    // `name`, `transports` and `aaguid` are `required: false` in the plugin's
    // schema: a hardware key that advertises no transports and reports no model
    // identifier, registered with no name typed, must still persist.
    const created = await adminDb.passkey.create({
      data: {
        publicKey: 'k',
        userId: user.id,
        credentialID: 'c',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      },
    });

    expect(created.name).toBeNull();
    expect(created.transports).toBeNull();
    expect(created.aaguid).toBeNull();
  });

  it('cascades with the user — a credential is auth substrate, not audit', async () => {
    const user = await makeUser('edsger@example.com', 'Edsger');
    await adminDb.passkey.create({
      data: {
        publicKey: 'k',
        userId: user.id,
        credentialID: 'c',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      },
    });

    await adminDb.user.delete({ where: { id: user.id } });

    expect(await adminDb.passkey.count({ where: { userId: user.id } })).toBe(0);
  });

  it('admits MANY rows for one user — one passkey per device is the shape', async () => {
    // Unlike `two_factor`, where several rows are a lost race, several rows here
    // are the feature: a laptop, a phone and a hardware key. `userId` is indexed
    // and deliberately not unique, and so is `credentialID` — the duplicate case
    // has a typed answer (`PREVIOUSLY_REGISTERED`) rather than a constraint that
    // would throw a raw P2002 inside the plugin.
    const user = await makeUser('barbara@example.com', 'Barbara');

    for (const [name, credentialID] of [
      ['MacBook', 'c1'],
      ['iPhone', 'c2'],
      ['YubiKey', 'c3'],
    ]) {
      await adminDb.passkey.create({
        data: {
          name,
          publicKey: 'k',
          userId: user.id,
          credentialID: credentialID as string,
          counter: 0,
          deviceType: 'singleDevice',
          backedUp: false,
        },
      });
    }

    expect(await adminDb.passkey.count({ where: { userId: user.id } })).toBe(3);
  });
});

describe('the passkey configuration', () => {
  it('mirrors the plugin’s own 5-minute challenge window', () => {
    // Not ours to choose: the plugin hard-codes `MAX_AGE_IN_SECONDS = 300` when it
    // mints the challenge cookie. The pane states it in minutes, so both units are
    // pinned and the minutes are DERIVED — a hand-written `5` beside a changed
    // `300` is exactly the drift this prevents.
    expect(PASSKEY_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(PASSKEY_CHALLENGE_TTL_MINUTES).toBe(5);
  });

  it('bounds the passkey name — the plugin does not', () => {
    expect(PASSKEY_NAME_MAX_LENGTH).toBe(64);
  });

  it('keeps the two authenticator-selection values as the strings WebAuthn defines', () => {
    // These are the constants `lib/auth/index.ts` passes through; asserting them
    // here is what makes the options assertion above a check of the WIRING rather
    // than of a literal it also owns.
    expect(PASSKEY_USER_VERIFICATION).toBe('required');
    expect(PASSKEY_RESIDENT_KEY).toBe('preferred');
  });
});
