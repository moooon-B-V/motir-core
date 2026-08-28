import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { dataExportService } from '@/lib/services/dataExportService';
import {
  DataExportExpiredError,
  DataExportNotFoundError,
  DataExportNotReadyError,
} from '@/lib/users/errors';

// GET /api/account/data-export/[id]/download (Story 8.4 · Subtask MOTIR-3703) —
// the AUTHENTICATED hand-over of a built personal-data archive. Design of
// record: `design/settings/design-notes.md` → `Data & privacy` → DECISION 2.
//
// The archive lives in the private bucket with no public URL. This route
// authorises the request row against the CALLING user and 302-redirects to a
// presigned URL minted FRESH on every request, so the pane's promise — *"Each
// Download makes a fresh, private link that expires after five minutes"* — is
// the mechanism rather than a description of one. Nothing is streamed through
// the function, and no minted URL is ever written down.
//
// It is identity-scoped, not workspace-scoped: an export spans every workspace
// the person belongs to, so the gate is `requireCompliantSession` (session +
// the 2FA hold) rather than the workspace door.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): auth → one service call → redirect.
// The three refusals are the whole security surface of this card, and each is
// its own status:
//   404 — no such row, or somebody else's (finding #44: never "exists but
//         forbidden", which here would confirm that an id names an archive)
//   410 — the seven-day retention window has elapsed
//   409 — the caller's own export is still preparing, or its build failed

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  try {
    const url = await dataExportService.getDownloadUrl({
      requestId: id,
      userId: gate.session.user.id,
    });
    return NextResponse.redirect(url, 302);
  } catch (err) {
    if (err instanceof DataExportNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof DataExportExpiredError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 410 });
    }
    if (err instanceof DataExportNotReadyError) {
      return NextResponse.json(
        { code: err.code, error: err.message, status: err.status },
        { status: 409 },
      );
    }
    throw err;
  }
}
