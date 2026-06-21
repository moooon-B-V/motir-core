import { Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';
import { hash, verify } from '@/lib/auth/passwords';
import { assertPasswordStrength } from '@/lib/auth/passwordPolicy';
import { accountRepository } from '@/lib/repositories/accountRepository';
import { sessionRepository } from '@/lib/repositories/sessionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { toUserProfileDto } from '@/lib/mappers/userMappers';
import {
  DuplicateEmailError,
  InvalidAvatarUrlError,
  InvalidProfileNameError,
  NoCredentialPasswordError,
  UserNotFoundError,
  WrongCurrentPasswordError,
} from '@/lib/users/errors';
import { deleteAttachmentBlob, putAttachment } from '@/lib/blob/uploader';
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
      await deleteAttachmentBlob(oldAvatarToDelete);
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
    const { url } = await putAttachment(pathname, file, file.type);
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
};
