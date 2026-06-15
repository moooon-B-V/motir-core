// User DTOs — the API-boundary shape for the User entity.
//
// The only public read of a user's own identity today is the MCP `whoami`
// tool (Story 7.9 · Subtask 7.9.1): the CLI resolves "who does this PAT
// belong to?" so `motir auth status` can show the owning user. Kept minimal
// and display-safe — never the password hash or any credential field.

export interface UserProfileDto {
  id: string;
  /** Display name; may be empty for a freshly-provisioned account. */
  name: string;
  email: string;
}
