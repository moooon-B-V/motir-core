import type { ImpersonationIneligibility } from '@/lib/platform/errors';

/**
 * Staff "View as" sessions — the shapes that cross the boundary (Story 10.3 ·
 * MOTIR-749; design `platform-admin/design-notes.md` § AMENDMENT 2026-10-03,
 * Panels 4–5). MOTIR-752 builds the rest of the console on these.
 *
 * Dates cross as ISO strings and are formatted where they are rendered, the
 * convention `lib/dto/platform.ts` explains.
 */

/** Read-only (the default) or full access. */
export type ImpersonationModeDTO = 'read_only' | 'full';

/** Why a session ended — `user.impersonation_end`'s `metadata.endedBy`. */
export type ImpersonationEndedByDTO = 'operator' | 'expiry' | 'revoked';

/** One place the account can be entered: a workspace and its organization. */
export interface ImpersonationWorkspaceOptionDTO {
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
  organizationName: string;
  /** A suspended organization (MOTIR-748) cannot be entered. */
  organizationSuspended: boolean;
}

/**
 * What the "View as {first name}" dialog needs (design Panel 4): who, where the
 * session would land, and whether it can start at all. `ineligibility` is null
 * when it can; the dialog still renders, the service still re-checks on start.
 */
export interface ImpersonationStartOptionsDTO {
  targetUserId: string;
  name: string;
  /** The first word of the display name — the button's "View as Dana". */
  firstName: string;
  email: string;
  workspaces: ImpersonationWorkspaceOptionDTO[];
  /** The workspace a start without an explicit choice lands in, or null. */
  defaultWorkspaceId: string | null;
  ineligibility: ImpersonationIneligibility | null;
  /** The time-boxes offered, in minutes — 15 / 30 / 60, never open-ended. */
  durationsMinutes: readonly number[];
  defaultDurationMinutes: number;
}

/**
 * One staff session as the bar, the ended page and the console render it. It
 * never carries the cookie's token — only the row the token names.
 */
export interface StaffSessionDTO {
  id: string;
  mode: ImpersonationModeDTO;
  operatorUserId: string;
  targetUserId: string;
  targetName: string;
  targetEmail: string;
  organizationId: string;
  organizationName: string;
  workspaceId: string;
  /** The operator's stated reason, as recorded on every write row of the session. */
  reason: string;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601 — the time-box. The gate refuses the session from this instant. */
  expiresAt: string;
  /** ISO-8601, or null while the session is open. */
  endedAt: string | null;
  endedBy: ImpersonationEndedByDTO | null;
}

/** What starting a session hands the route layer: the row, and the cookie's token. */
export interface StartedStaffSessionDTO {
  session: StaffSessionDTO;
  /** The random token the cookie carries. Only its SHA-256 is stored. */
  token: string;
}
