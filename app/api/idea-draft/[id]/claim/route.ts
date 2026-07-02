import { NextResponse } from 'next/server';
import { ideaDraftService } from '@/lib/services/ideaDraftService';
import { DraftNotFoundError } from '@/lib/ideaDraft/errors';
import { setPendingIdea } from '@/lib/onboarding/pendingIdea';
import type { ClaimIdeaDraftResultDTO } from '@/lib/dto/ideaDraft';

// POST /api/idea-draft/[id]/claim (Subtask 7.22.2 / MOTIR-1458) — the SAME-ORIGIN
// half of the cross-origin handoff, called by `/sign-in` when it sees `?draft=<id>`.
// It consumes the draft (single-use) and plants the preserved idea into the
// existing `motir_pending_idea` cookie via `setPendingIdea()` — the 7.3.14 → 7.3.5
// seam — so the idea survives auth (the cookie is SameSite=Lax, so it rides the
// top-level redirect back from email/password AND the Google OAuth round-trip) and
// seeds the first onboarding turn. The response also returns the idea so `/sign-in`
// can show the visitor their idea was carried over.
//
// A cookie can only be set from a Route Handler / Server Action, which is why this
// is a route (not a fetch the client resolves itself). No `getSession()` — the
// visitor is still logged out. A missing / already-claimed / expired / forged id
// resolves to 404, and the caller degrades to a normal login (no crash, no leak).

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const result: ClaimIdeaDraftResultDTO = await ideaDraftService.claimDraft(id);
    // Plant the idea into the auth-surviving cookie the onboarding chat reads.
    await setPendingIdea(result.idea);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DraftNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
