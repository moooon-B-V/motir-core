// Typed errors for the users repository. Kept in their own file so callers
// (route handlers, server actions, server components) can import them without
// pulling in the Prisma client. The error shape mirrors what Story 1.1.5's
// sign-up form needs to render — a discriminating `code` plus a human-safe
// `message`.

export class DuplicateEmailError extends Error {
  readonly code = 'DUPLICATE_EMAIL' as const;
  constructor(email: string) {
    super(`A user with email ${email} already exists.`);
    this.name = 'DuplicateEmailError';
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND' as const;
  constructor(identifier: string) {
    super(`No user found for ${identifier}.`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * The submitted display name is empty (after trimming) or longer than the
 * bound (Story 8.8 · Subtask 8.8.21 — the Profile pane's name field). The
 * Profile form renders `message` inline beside the field; the route maps it to
 * a 400.
 */
export class InvalidProfileNameError extends Error {
  readonly code = 'INVALID_PROFILE_NAME' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProfileNameError';
  }
}

/**
 * The submitted avatar `image` URL is not one of OUR Vercel-Blob uploads under
 * the caller's own `avatars/<userId>/` prefix (Story 8.8 · Subtask 8.8.21). A
 * client must upload through the avatar route (which returns a qualifying URL)
 * rather than pass an arbitrary/foreign URL — the gate that prevents pointing
 * an avatar at someone else's blob or hotlinking an external image. → 400.
 */
export class InvalidAvatarUrlError extends Error {
  readonly code = 'INVALID_AVATAR_URL' as const;
  constructor() {
    super('That avatar image is not a valid upload.');
    this.name = 'InvalidAvatarUrlError';
  }
}
