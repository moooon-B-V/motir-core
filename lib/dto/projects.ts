// DTOs for the project endpoints + surfaces. These define EXACTLY what
// crosses the HTTP / Server-Action boundary — no Prisma model leaks. Add
// fields here when the UI needs them, never on raw Prisma rows in a
// service return type.

export interface ProjectDTO {
  id: string;
  name: string;
  slug: string;
  identifier: string;
  /**
   * ISO timestamp the project was soft-deleted, or null when active.
   * `listProjects` only ever returns non-archived rows (always null here),
   * but `getActiveProject` can surface an archived pinned project so the
   * shell can flag it — see PRODECT_FINDINGS #29. Consumers branch on this
   * to render the "Archived" pill / "this project is archived" empty state.
   */
  archivedAt: string | null;
  /**
   * The project's browse-access level (Story 6.4 — open / limited / private).
   * Surfaced on the DTO so the active-project consumer branches WITHOUT a
   * second round-trip: the 6.4.6 assignable-users scoping reads this to decide
   * whether the assignee/reporter pickers list project members (`private`) or
   * the whole workspace (`open`/`limited`). The browse/edit POLICY itself is
   * computed server-side (`projectAccessService`); this is only the level.
   */
  accessLevel: 'open' | 'limited' | 'private';
}
