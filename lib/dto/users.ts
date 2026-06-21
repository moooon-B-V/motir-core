// User DTOs — the API-boundary shape for the User entity.
//
// First read of a user's own identity was the MCP `whoami` tool (Story 7.9 ·
// Subtask 7.9.1): the CLI resolves "who does this PAT belong to?" so `motir
// auth status` can show the owning user. Story 8.8 (Subtask 8.8.21) extends it
// to back the Account › Profile pane (name + avatar + email read/update). Kept
// display-safe — never the password hash or any credential field.

export interface UserProfileDto {
  id: string;
  /** Display name; may be empty for a freshly-provisioned account. */
  name: string;
  email: string;
  /**
   * Avatar URL — an `image/*` blob the user uploaded (under our Vercel-Blob
   * `avatars/<userId>/` prefix), or a provider URL from an OAuth signup
   * (e.g. Google), or `null` when the account has no avatar. The Profile
   * pane (8.8.24) renders it; an `<Avatar>` falls back to initials on null.
   */
  image: string | null;
}

/**
 * The user's password capability — what the Account › Profile security pane
 * (Subtask 8.8.24) branches on. `hasPassword` is true iff the user has a
 * credential (`providerId="credential"`) Account row with a stored hash:
 *   - true  → render the "Change password" form (current + new).
 *   - false → OAuth-only account; render "Set a password" which sends the
 *             reset-link via the shipped request-password-reset flow.
 */
export interface PasswordCapabilityDto {
  hasPassword: boolean;
}
