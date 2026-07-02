// DTOs for the cross-origin idea-draft handoff (Subtask 7.22.2 / MOTIR-1458).
// These define EXACTLY what crosses the HTTP boundary — the anonymous draft row
// never leaks (its `expiresAt` / `createdAt` are internal TTL bookkeeping).

/** `POST /api/idea-draft` → the opaque id the marketing site carries to `/sign-in`. */
export interface CreateIdeaDraftResultDTO {
  draftId: string;
}

/** `POST /api/idea-draft/[id]/claim` → the preserved idea (for display), once. */
export interface ClaimIdeaDraftResultDTO {
  idea: string;
}
