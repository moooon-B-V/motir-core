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
  /**
   * Project avatar (Story 6.8) — a preset icon key + a colour-swatch key from
   * the avatar registry (lib/projects/avatar.ts), or null = the shipped
   * mono-identifier rendering (the chip falls back to the identifier letters).
   * Carried on the base DTO because the project switcher + details card both
   * render the chip on every project read; null is the zero-config default.
   */
  avatarIcon: string | null;
  avatarColor: string | null;
  /**
   * ISO timestamp the project was created — the Details surface's "Created" row
   * (Story 6.5.3). OPTIONAL and loaded ONLY on the details-surface read path
   * (alongside `previousKeys`), so the hot reads (switcher list, active-project
   * resolution) keep their single project-row projection with NO `createdAt` on
   * the DTO — the deliberate "the DTO is not a raw Prisma row" decision the
   * create-path shape test enforces. Absent ⇒ "not loaded" (a hot read); a
   * string ⇒ loaded on the details path.
   */
  createdAt?: string;
  /**
   * The project's retired keys (Story 6.8), newest first — the details card's
   * "Previous keys" list. OPTIONAL: only the details-surface read path
   * (`updateDetails` / `changeKey` returns, and a details read) loads +
   * populates it, so the hot project reads (switcher list, active-project
   * resolution) stay a single project-row fetch with no alias join. Absent ⇒
   * "not loaded"; an empty array ⇒ "loaded, no previous keys".
   */
  previousKeys?: PreviousKeyDTO[];
}

/** One retired project key — the key string + when it was retired (ISO). */
export interface PreviousKeyDTO {
  identifier: string;
  retiredAt: string;
}
