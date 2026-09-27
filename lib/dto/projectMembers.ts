// DTOs for the project membership + access endpoints (Story 6.4 · 6.4.4).
// These define EXACTLY what crosses the HTTP / Server-Action boundary — no
// Prisma model leaks. The Members UI (6.4.5) renders `ProjectMemberDTO`; the
// Access control reads/writes `ProjectAccessDTO`.

/**
 * A person added to the project. It carries no role (Story MOTIR-6168 ·
 * MOTIR-6464): what they may do here is their WORKSPACE role, the same in every
 * project, read from the workspace's Members list.
 */
export interface ProjectMemberDTO {
  userId: string;
  name: string;
  email: string;
}

export interface ProjectAccessDTO {
  /** The project's `identifier` ("key", e.g. PROD) — the stable URL handle. */
  key: string;
  /**
   * Who may ENTER the project (Story MOTIR-6169): `workspace` (Open to the
   * workspace), `members` (Members only) or `public`. Derived from the legacy
   * level while the stored mode is NULL.
   */
  accessMode: 'workspace' | 'members' | 'public';
  /** @deprecated The legacy level, written beside the mode until the contract story drops it. */
  accessLevel: 'open' | 'limited' | 'private' | 'public';
}

/**
 * One person a change of access mode would LOCK OUT (Story MOTIR-6169 ·
 * MOTIR-6544) — a row of the Members-only confirm (MOTIR-6540 panel A2), which
 * shows the person's workspace role beside their name. Every row is a Full-scope
 * member by definition, so no scope is carried.
 */
export interface AccessLossPersonDTO {
  userId: string;
  name: string;
  email: string;
  /** The person's workspace role — for a custom role, its tier (`member`). */
  workspaceRole: 'manager' | 'member' | 'viewer';
  /** The workspace custom role's name, or null for a built-in role. */
  customRoleName: string | null;
}
