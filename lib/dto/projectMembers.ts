// DTOs for the project membership + access endpoints (Story 6.4 · 6.4.4).
// These define EXACTLY what crosses the HTTP / Server-Action boundary — no
// Prisma model leaks. The Members UI (6.4.5) renders `ProjectMemberDTO`; the
// Access control reads/writes `ProjectAccessDTO`.

import type { ProjectRole } from '@/lib/projects/roles';

export interface ProjectMemberDTO {
  userId: string;
  name: string;
  email: string;
  /**
   * The member's per-project TIER (admin / member / viewer).
   *
   * ⚠️ NOT NECESSARILY THE ROLE THEY WEAR (MOTIR-2257 · MOTIR-2485). A member on
   * a custom role carries `CUSTOM_ROLE_TIER` here — `member` — because the tier
   * and the pointer are written as a pair. So this field alone cannot answer
   * "what role is this person on"; `roleDefinition` does, and a renderer that
   * ignores it draws every custom-role holder as a Member.
   */
  role: ProjectRole;
  /**
   * The CUSTOM role the member holds, or `null` when they hold a built-in — the
   * two things the row's chip needs: the role's name, and (by being null) whether
   * it is built-in. Only the id and the name cross: the picker already has the
   * project's catalog, and a member row has no use for a permission array.
   */
  roleDefinition: { id: string; name: string } | null;
}

export interface ProjectAccessDTO {
  /** The project's `identifier` ("key", e.g. PROD) — the stable URL handle. */
  key: string;
  accessLevel: 'open' | 'limited' | 'private' | 'public';
}
