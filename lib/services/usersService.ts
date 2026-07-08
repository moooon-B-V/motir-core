import { randomBytes } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';
import { hash, verify } from '@/lib/auth/passwords';
import { assertPasswordStrength } from '@/lib/auth/passwordPolicy';
import { accountRepository } from '@/lib/repositories/accountRepository';
import { sessionRepository } from '@/lib/repositories/sessionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { emailChangeRequestRepository } from '@/lib/repositories/emailChangeRequestRepository';
import { toUserProfileDto } from '@/lib/mappers/userMappers';
import {
  DuplicateEmailError,
  EmailChangeRateLimitedError,
  EmailTakenError,
  InvalidAvatarUrlError,
  InvalidEmailChangeTokenError,
  InvalidEmailError,
  InvalidProfileNameError,
  NoCredentialPasswordError,
  SameEmailError,
  UserNotFoundError,
  WrongCurrentPasswordError,
} from '@/lib/users/errors';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { currentLocale } from '@/lib/i18n/serverLocale';
import { deletePublicAsset, putPublicAsset } from '@/lib/blob/uploader';
import { avatarBlobPrefix, isOwnAvatarBlobUrl } from '@/lib/blob/referencedUrls';
import { MAX_UPLOAD_BYTES, isImageType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import type { PasswordCapabilityDto, UserProfileDto } from '@/lib/dto/users';

/** Upper bound on a profile display name (Subtask 8.8.21). Generous enough for
 *  real names + handles, short enough to keep a row label sane. */
export const MAX_PROFILE_NAME_LENGTH = 80;

/** What `updateProfile` accepts. An OMITTED key (`undefined`) leaves that field
 *  unchanged; `image: null` REMOVES the avatar; `image: <url>` sets it. */
export interface UpdateProfileInput {
  name?: string;
  image?: string | null;
}

// Verified-email-change flow (Subtask 8.8.22) — tunables, mirrored on the
// password-reset flow (1h token, 3/hour). The expiry copy in
// `emailChange.tsx` MUST match `EMAIL_CHANGE_TOKEN_TTL_MS`.
const EMAIL_CHANGE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_CHANGE_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_CHANGE_RATE_MAX = 3; // requests per user per window

// Pragmatic email shape check — the same intent as Better-Auth's signup
// validation: a single `@` with non-empty, whitespace-free local and domain
// parts and a dot in the domain. The real authority is delivery + the confirm
// click; this just rejects obvious garbage before issuing a token.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Users service — business logic for the User entity.
//
// Per CLAUDE.md, this layer:
//   - Owns all transactions
//   - Returns DTOs (or Prisma User where the caller is internal, e.g.
//     Better-Auth's adapter — see findOrCreateOAuthUser comment below)
//   - Translates Prisma errors (P2002 unique violation on email) into
//     typed domain errors (DuplicateEmailError)

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
}

export const usersService = {
  /**
   * Resolve a user's own display-safe profile by id — the read behind the MCP
   * `whoami` tool (Story 7.9 · Subtask 7.9.1), which the CLI uses so
   * `motir auth status` can show the PAT owner. Returns null when the id has
   * no user (a deleted account whose token somehow survived); the caller
   * surfaces that as a not-found. The actor is the token owner resolving
   * THEMSELVES, so there is no cross-user exposure here.
   */
  async getProfile(userId: string): Promise<UserProfileDto | null> {
    const user = await userRepository.findById(userId);
    return user ? toUserProfileDto(user) : null;
  },

  /**
   * Whether the user can CHANGE a password (true) or must SET one via the
   * reset-link path (false). True iff a credential Account row with a stored
   * hash exists; OAuth-only users (Google sign-in, no credential row) are
   * false. The Account › Profile security pane (Subtask 8.8.24) branches on
   * this; the profile read (8.8.21) may surface it alongside name/email.
   */
  async getPasswordCapability(userId: string): Promise<PasswordCapabilityDto> {
    const credential = await accountRepository.findCredentialByUserId(userId);
    return { hasPassword: Boolean(credential?.password) };
  },

  /**
   * Change a credential user's password: verify the current password, then
   * store an argon2id hash of the new one. Wired for the in-app "Change
   * password" setting (Subtask 8.8.23).
   *
   *   - Strength-validates the new password FIRST (typed WeakPasswordError)
   *     and hashes it before opening the transaction, so the row lock is held
   *     only for the verify + write, not the (CPU-heavy) argon2 hash.
   *   - Locks the credential Account row `FOR UPDATE` and re-reads inside the
   *     tx (lock-before-read-derived-update): two concurrent changes serialize
   *     instead of one clobbering the other.
   *   - OAuth-only users (no credential row) → NoCredentialPasswordError; the
   *     UI should have routed them to the set-password path via `hasPassword`.
   *   - Wrong current password → WrongCurrentPasswordError (never a raw
   *     argon2/Prisma error).
   *   - `revokeOtherSessions` (optional) deletes every OTHER session, keeping
   *     the caller's current one (`currentSessionToken`) signed in — no cookie
   *     rotation needed. Returns the number of sessions revoked.
   *
   * Hashing uses lib/auth/passwords.ts (the single argon2id primitive), so the
   * stored hash is byte-compatible with the sign-in verify path.
   */
  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionToken?: string | null;
    revokeOtherSessions?: boolean;
  }): Promise<{ revokedSessions: number }> {
    assertPasswordStrength(input.newPassword);
    const newPasswordHash = await hash(input.newPassword);

    return db.$transaction(async (tx) => {
      const credential = await accountRepository.lockCredentialByUserId(input.userId, tx);
      if (!credential?.password) {
        throw new NoCredentialPasswordError();
      }

      const currentOk = await verify(input.currentPassword, credential.password);
      if (!currentOk) {
        throw new WrongCurrentPasswordError();
      }

      await accountRepository.updatePassword(credential.id, newPasswordHash, tx);

      let revokedSessions = 0;
      if (input.revokeOtherSessions && input.currentSessionToken) {
        revokedSessions = await sessionRepository.deleteOthersForUser(
          input.userId,
          input.currentSessionToken,
          tx,
        );
      }
      return { revokedSessions };
    });
  },

  /**
   * Update the session user's OWN personal details — name and/or avatar (Story
   * 8.8 · Subtask 8.8.21, behind the Account › Profile pane 8.8.24). Both fields
   * are independently optional: an omitted key is untouched; `image: null`
   * removes the avatar; `image: <url>` sets it.
   *
   * Validation: a present `name` must be non-empty (trimmed) and within
   * {@link MAX_PROFILE_NAME_LENGTH}; a present non-null `image` must be one of
   * OUR Vercel-Blob uploads under THIS user's `avatars/<userId>/` prefix
   * (`isOwnAvatarBlobUrl`), so a foreign/arbitrary URL is rejected rather than
   * stored. Name + avatar are keyed by the session user id and set to absolute
   * values (not read-derived), so there is no lost-update hazard and no
   * `FOR UPDATE` is needed (email uniqueness, which DOES race, is handled
   * separately in 8.8.22). The single write runs in one `$transaction`.
   *
   * Avatar GC: when the update REPLACES or REMOVES a prior avatar that was our
   * own-avatar blob, the old blob is `del`'d — but ONLY after the row commits
   * (external I/O outside the tx), and ONLY when it is ours: a provider URL from
   * an OAuth signup (e.g. a Google avatar) is never deleted.
   */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserProfileDto> {
    const before = await userRepository.findById(userId);
    if (!before) throw new UserNotFoundError(userId);

    const data: { name?: string; image?: string | null } = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new InvalidProfileNameError('Name is required.');
      }
      if (name.length > MAX_PROFILE_NAME_LENGTH) {
        throw new InvalidProfileNameError(
          `Name must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.`,
        );
      }
      data.name = name;
    }

    let oldAvatarToDelete: string | null = null;
    if (input.image !== undefined) {
      const image = input.image; // string (set) | null (remove)
      if (image !== null && !isOwnAvatarBlobUrl(image, userId)) {
        throw new InvalidAvatarUrlError();
      }
      data.image = image;
      // The prior avatar is ours to garbage-collect iff it's actually changing
      // AND it's one of our own-avatar blobs (never a foreign/OAuth provider URL).
      if (before.image && before.image !== image && isOwnAvatarBlobUrl(before.image, userId)) {
        oldAvatarToDelete = before.image;
      }
    }

    const updated = await db.$transaction((tx) => userRepository.updateProfile(tx, userId, data));

    // Delete the replaced/removed blob AFTER the row commits (CLAUDE.md: external
    // side-effects live outside the transaction), so a rolled-back update can
    // never orphan a still-referenced avatar.
    if (oldAvatarToDelete) {
      await deletePublicAsset(oldAvatarToDelete);
    }

    return toUserProfileDto(updated);
  },

  /**
   * Store an uploaded avatar image and return its public URL (Story 8.8 ·
   * Subtask 8.8.21) — the backend the Profile pane's `AvatarField` (8.8.24)
   * POSTs a file to. Gates size + image-only MIME (the shared upload allowlist),
   * then writes to the per-user `avatars/<userId>/` prefix so the URL passes
   * `updateProfile`'s `isOwnAvatarBlobUrl` gate. Unlike an attachment upload
   * this keeps NO audit row — an avatar is transient personal substrate, its
   * lifecycle owned entirely by the user row's `image` column (and its GC by
   * `updateProfile`). The caller then PATCHes the returned URL as `image`.
   */
  async uploadAvatar(file: File, userId: string): Promise<{ url: string }> {
    if (file.size > MAX_UPLOAD_BYTES) throw new FileTooLargeError(MAX_UPLOAD_BYTES);
    if (!isImageType(file.type)) throw new UnsupportedFileTypeError(file.type);

    const pathname = `${avatarBlobPrefix(userId)}${file.name}`;
    const { url } = await putPublicAsset(pathname, file, file.type);
    return { url };
  },

  /**
   * Email/password signup. Hashes the password, creates the User and a
   * paired credential Account in one transaction. The credential Account
   * row is what `verifyPassword` reads, and what Better-Auth's
   * email/password sign-in path expects to find.
   *
   * Returns the raw Prisma User — there is no public-API DTO for this
   * yet because the only callers are tests and `findOrCreateOAuthUser`.
   * When a user-facing signup endpoint lands (Story 1.1 already covers
   * it via Better-Auth's own routes), if it needs to return user fields
   * to the client, this is where we'd add a `toUserDTO` mapper.
   */
  async createUser(input: CreateUserInput): Promise<User> {
    const email = normalizeEmail(input.email);
    const name = input.name ?? email.split('@')[0]!;
    const passwordHash = await hash(input.password);
    try {
      return await db.$transaction(async (tx) => {
        return userRepository.createWithCredentialAccount({ email, name, passwordHash }, tx);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateEmailError(email);
      }
      throw err;
    }
  },

  /**
   * Returns true iff the email maps to a user with a credential Account
   * whose stored hash verifies against `plain`. Returns false (never
   * throws) on user-not-found, account-not-found, hash-mismatch, or
   * malformed-hash — same return shape across all failure modes prevents
   * user-enumeration via timing/error differences.
   */
  async verifyPassword(email: string, plain: string): Promise<boolean> {
    const user = await userRepository.findByEmailWithCredentialAccount(email);
    const credential = user?.accounts[0];
    if (!credential?.password) return false;
    return verify(plain, credential.password);
  },

  /**
   * The OAuth auto-link gate. Resolves a (provider, providerAccountId)
   * pair to a User row, creating one if necessary. Three branches:
   *
   *   1. If an Account already exists for (provider, providerAccountId),
   *      return its linked User. Token fields are refreshed in case the
   *      provider rotated them. Idempotent on repeat sign-ins.
   *   2. Else, if a User exists with this email, link a new Account row
   *      to that User. Mark emailVerified = true since the OAuth
   *      provider has already verified the address. Return that User.
   *   3. Else, create a new User (password hash null — OAuth-only signup)
   *      and link the Account in the same transaction.
   *
   * v1's threat model accepts the Google-account-compromise →
   * local-account-takeover risk in branch (2); see Story 1.1's
   * decisions log for the why.
   */
  async findOrCreateOAuthUser(input: {
    provider: string;
    providerAccountId: string;
    email: string;
    name?: string;
    image?: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: Date;
  }): Promise<User> {
    const email = normalizeEmail(input.email);
    const tokens = {
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
    };

    return db.$transaction(async (tx) => {
      // (1) Existing OAuth account → return its user, refresh tokens.
      const existingAccount = await accountRepository.findByProviderAndAccountId(
        input.provider,
        input.providerAccountId,
      );
      if (existingAccount) {
        await accountRepository.updateTokens(existingAccount.id, tokens, tx);
        return existingAccount.user;
      }

      // (2) Existing local user with the same email → link this OAuth account.
      const existingUser = await userRepository.findByEmail(email);
      if (existingUser) {
        await accountRepository.create(
          {
            userId: existingUser.id,
            providerId: input.provider,
            providerAccountId: input.providerAccountId,
            ...tokens,
          },
          tx,
        );
        if (!existingUser.emailVerified) {
          return userRepository.setEmailVerified(existingUser.id, true, tx);
        }
        return existingUser;
      }

      // (3) Brand-new OAuth signup.
      return userRepository.createOAuthUser(
        {
          email,
          name: input.name ?? email.split('@')[0]!,
          image: input.image ?? null,
          providerId: input.provider,
          providerAccountId: input.providerAccountId,
          ...tokens,
        },
        tx,
      );
    });
  },

  /**
   * Link an additional OAuth provider Account to an existing User.
   * Currently unused — the OAuth callback flow goes through
   * `findOrCreateOAuthUser` — but kept around because the original
   * Story 1.1.4 implementation exposed it and tests may rely on it.
   */
  async linkOAuthAccount(input: {
    userId: string;
    provider: string;
    providerAccountId: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: Date;
  }): Promise<void> {
    await db.$transaction(async (tx) => {
      await accountRepository.create(
        {
          userId: input.userId,
          providerId: input.provider,
          providerAccountId: input.providerAccountId,
          accessToken: input.accessToken ?? null,
          refreshToken: input.refreshToken ?? null,
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
        },
        tx,
      );
    });
  },

  /**
   * Step 1 of a verified email change (Subtask 8.8.22): record a pending request
   * and email a confirm link to the NEW address. Returns the result of the DB
   * step so the caller / tests can assert it; the confirmation email is enqueued
   * AFTER the transaction commits (see below). The email swap itself happens in
   * `confirmEmailChange` when the link is clicked.
   *
   * THE CONTENDED WRITE. `User.email` is `@unique`, so a naive "is it free? →
   * write it" races. The race is closed by the DB, not by app-level checks: the
   * insert into `email_change_request` carries `new_email @unique`, so two
   * concurrent requests for the SAME new address can't both succeed — the loser
   * gets `P2002`, which we translate to a typed `EmailTakenError` (the
   * CLAUDE.md "translate raw DB races to typed errors" contract). The
   * `lockById` FOR UPDATE serialises a single user's own concurrent submits and
   * gives the uniqueness re-read a stable snapshot.
   *
   * Order inside the transaction: lock self → validate (same-email, rate-limit,
   * not-already-taken) → clear our own / expired stale claims on this address →
   * insert (the guarded write). The confirmation email is a post-commit
   * side-effect (CLAUDE.md "side-effects outside the tx"): a send failure must
   * NOT roll back the request, so the enqueue runs after the `$transaction`
   * resolves and rides the best-effort `sendEvent` (which swallows transport
   * errors — the durable `email.send` job owns retries).
   */
  async requestEmailChange(
    userId: string,
    newEmail: string,
  ): Promise<{ token: string; newEmail: string; recipientName: string }> {
    const normalized = normalizeEmail(newEmail);
    if (!EMAIL_RE.test(normalized)) {
      throw new InvalidEmailError(newEmail);
    }

    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const user = await userRepository.lockById(userId, tx);
      if (!user) throw new UserNotFoundError(userId);

      // Resolve the locked user's current email for the same-email guard +
      // the email recipient name (lockById returns only the id). Read inside
      // the locked transaction for a consistent snapshot.
      const self = await userRepository.findById(userId, tx);
      if (!self) throw new UserNotFoundError(userId);
      if (self.email === normalized) throw new SameEmailError();

      const recent = await emailChangeRequestRepository.countRecentForUser(
        userId,
        new Date(now.getTime() - EMAIL_CHANGE_RATE_WINDOW_MS),
        tx,
      );
      if (recent >= EMAIL_CHANGE_RATE_MAX) throw new EmailChangeRateLimitedError();

      // Fast, friendly reject when the address is ALREADY owned by a confirmed
      // user (the common, non-racy case). The DB unique index below is what
      // actually closes the concurrent race.
      const owner = await userRepository.findByEmail(normalized, tx);
      if (owner) throw new EmailTakenError(normalized);

      // Don't let our own prior claim, or an expired abandoned one, make this
      // request spuriously lose the unique race.
      await emailChangeRequestRepository.clearReusableForEmail(
        { userId, newEmail: normalized, now },
        tx,
      );

      const token = randomBytes(32).toString('hex');
      try {
        await emailChangeRequestRepository.create(
          {
            userId,
            newEmail: normalized,
            token,
            expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TOKEN_TTL_MS),
          },
          tx,
        );
      } catch (err) {
        // Lost the concurrent race for this address → typed error, not raw P2002.
        if (isUniqueViolation(err)) throw new EmailTakenError(normalized);
        throw err;
      }

      return { token, newEmail: normalized, recipientName: self.name };
    });

    // Post-commit side-effect: enqueue the confirmation email. Best-effort —
    // `sendEvent` swallows transport failures, and delivery runs in the durable
    // `email.send` job — so a mail outage never fails an already-committed
    // request.
    await sendEvent('email.send', {
      workspaceId: null,
      idempotencyKey: result.token,
      to: result.newEmail,
      template: 'email-change',
      data: {
        recipientName: result.recipientName,
        newEmail: result.newEmail,
        confirmUrl: `${resolveBaseUrlTrimmed()}/api/account/confirm-email-change?token=${result.token}`,
        locale: await currentLocale(),
      },
    });

    return result;
  },

  /**
   * Step 2 of a verified email change (Subtask 8.8.22): the user clicked the
   * emailed link. Validates the single-use token, then swaps `User.email` (and
   * re-keys the credential account's `accountId` so a freed address can be
   * reused at signup — see `accountRepository.updateCredentialAccountId`).
   *
   * The token is consumed (deleted) whether or not it's still valid in time, so
   * a leaked link can't be replayed. A second guard against the `User.email`
   * unique index catches the narrow window where a FRESH signup grabbed the
   * address between request and confirm → `EmailTakenError`. Unknown / used /
   * expired tokens all surface as one `InvalidEmailChangeTokenError` (no
   * token-probing oracle).
   */
  async confirmEmailChange(token: string): Promise<{ userId: string; newEmail: string }> {
    const now = new Date();

    // We must throw AFTER the transaction, not inside it: throwing inside the
    // `$transaction` rolls back the single-use `deleteByToken`, so an
    // invalid/expired token would survive and be replayable. So the tx returns a
    // tagged OUTCOME (committing the consume for every terminal case) and we map
    // it to a result/throw once it has committed.
    type Outcome =
      | { kind: 'invalid' }
      | { kind: 'expired' }
      | { kind: 'taken'; newEmail: string }
      | { kind: 'ok'; userId: string; newEmail: string };

    const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
      const request = await emailChangeRequestRepository.findByToken(token, tx);
      if (!request) return { kind: 'invalid' };

      // Single-use: consume the token now. Because we RETURN (never throw) for
      // the terminal cases below, this delete commits with the transaction.
      await emailChangeRequestRepository.deleteByToken(token, tx);
      if (request.expiresAt.getTime() < now.getTime()) return { kind: 'expired' };

      // Serialise against a concurrent confirm by the same user + give the
      // uniqueness re-read a stable snapshot.
      await userRepository.lockById(request.userId, tx);

      // Re-read uniqueness to handle the common "address taken since request"
      // case WITHOUT provoking a P2002 — a constraint violation would abort the
      // Postgres transaction and roll back the consume above.
      const owner = await userRepository.findByEmail(request.newEmail, tx);
      if (owner && owner.id !== request.userId) {
        return { kind: 'taken', newEmail: request.newEmail };
      }

      try {
        await userRepository.updateEmail(request.userId, request.newEmail, tx);
        await accountRepository.updateCredentialAccountId(request.userId, request.newEmail, tx);
      } catch (err) {
        // Backstop for the narrow race where a fresh signup claimed the address
        // between the re-read and the swap. The tx aborts here, so the consume
        // rolls back too — acceptable: the address is genuinely gone.
        if (isUniqueViolation(err)) return { kind: 'taken', newEmail: request.newEmail };
        throw err;
      }

      return { kind: 'ok', userId: request.userId, newEmail: request.newEmail };
    });

    switch (outcome.kind) {
      case 'invalid':
      case 'expired':
        throw new InvalidEmailChangeTokenError();
      case 'taken':
        throw new EmailTakenError(outcome.newEmail);
      case 'ok':
        return { userId: outcome.userId, newEmail: outcome.newEmail };
    }
  },
};
