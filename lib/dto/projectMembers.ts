// DTOs for the project membership + access endpoints (Story 6.4 · 6.4.4).
// These define EXACTLY what crosses the HTTP / Server-Action boundary — no
// Prisma model leaks. The Members UI (6.4.5) renders `ProjectMemberDTO`; the
// Access control reads/writes `ProjectAccessDTO`.

import type { ProjectRole } from '@/lib/projects/roles';

export interface ProjectMemberDTO {
  userId: string;
  name: string;
  email: string;
  /** The member's per-project role (admin / member / viewer). */
  role: ProjectRole;
}

export interface ProjectAccessDTO {
  /** The project's `identifier` ("key", e.g. PROD) — the stable URL handle. */
  key: string;
  accessLevel: 'open' | 'limited' | 'private';
}
