/**
 * Component DTOs (Story 5.4 · Subtask 5.4.3) — the wire shapes of the
 * admin-managed component taxonomy. Two tiers:
 *
 *   * {@link ComponentDto} — what the issue rail's chips and the picker
 *     options render (the detail-read slot). `defaultAssigneeId` stays a raw
 *     id here: the rail never displays it, and the server-side `nameLower`
 *     uniqueness key never crosses the API boundary (the LabelDto rule).
 *   * {@link ComponentWithCountDto} — the Project settings → Components
 *     admin list row: the default assignee RESOLVED to a renderable user
 *     (Avatar · name, or null = the muted "None") plus the in-use item
 *     count the list and the delete dialog name.
 */

/** The default assignee as the admin list renders it (Avatar · name). */
export interface ComponentUserDto {
  id: string;
  name: string;
  email: string;
}

export interface ComponentDto {
  id: string;
  name: string;
  description: string | null;
  defaultAssigneeId: string | null;
}

export interface ComponentWithCountDto extends ComponentDto {
  defaultAssignee: ComponentUserDto | null;
  /** How many work items carry this component (the delete dialog's "N"). */
  itemCount: number;
}

/**
 * The receipt of a move-or-remove delete (the verified Jira flow): how many
 * issues were affected, and where their association went — `movedToComponentId`
 * is the move target, or null for the remove branch. Issues themselves are
 * untouched either way.
 */
export interface DeleteComponentReceiptDto {
  deletedId: string;
  affectedCount: number;
  movedToComponentId: string | null;
}

export interface CreateComponentInput {
  /** The project identifier ("PROD") — resolved workspace-scoped. */
  key: string;
  name: string;
  description?: string | null;
  defaultAssigneeId?: string | null;
}

export interface UpdateComponentInput {
  name?: string;
  description?: string | null;
  defaultAssigneeId?: string | null;
}
