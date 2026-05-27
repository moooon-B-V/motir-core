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
}
