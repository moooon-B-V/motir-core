// DTOs for the invite endpoints. These define EXACTLY what crosses the
// HTTP boundary — no Prisma model leaks. Add fields here when the UI
// needs them, never on raw Prisma rows in the service return type.

export interface SendInviteResultDTO {
  ok: true;
}

export interface ValidateInviteResultDTO {
  workspaceName: string;
  inviterName: string;
  email: string;
}

export interface AcceptInviteResultDTO {
  workspaceId: string;
  /**
   * The projects a Limited invite named that were ARCHIVED between the send and
   * the accept, so the person was not added to them (Story MOTIR-6169 ·
   * MOTIR-6546). Empty on every other accept.
   */
  skippedProjects: string[];
}

// Discriminated result for the acceptance UI's initial page load. Lets
// the page render the distinct mockup states (valid / expired / used)
// instead of collapsing them the way validateInvite() does for the
// public GET endpoint.
export type InspectInviteResultDTO =
  | { status: 'valid'; workspaceName: string; inviterName: string; email: string }
  | { status: 'expired' }
  | { status: 'used' };
