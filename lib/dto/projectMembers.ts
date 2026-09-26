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
  accessLevel: 'open' | 'limited' | 'private' | 'public';
}
