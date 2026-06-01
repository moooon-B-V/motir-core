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
}
