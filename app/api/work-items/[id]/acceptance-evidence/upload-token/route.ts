import { NextResponse } from 'next/server';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { authorizeAcceptancePublish } from '@/lib/acceptanceEvidence/publishAuth';
import { AcceptanceEvidenceError } from '@/lib/acceptanceEvidence/errors';

// POST /api/work-items/[id]/acceptance-evidence/upload-token (MOTIR-1681) — mint
// scoped CLIENT upload tokens so a trusted CI job uploads the acceptance video
// (+ trace) DIRECTLY to the private Blob store, bypassing the ~4.5MB serverless
// request-body cap the old multipart publish hit. Same auth + eligibility gate
// as the register route; CI then POSTs the resulting pathnames back to the
// sibling route. Thin HTTP layer: gate → parse `{ hasTrace }` → one service call.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const identifier = id.trim().toUpperCase();

  const gate = await authorizeAcceptancePublish(req, identifier);
  if (gate instanceof Response) return gate;
  const { ctx, story } = gate;

  const body = (await req.json().catch(() => ({}))) as { hasTrace?: unknown };
  const hasTrace = body?.hasTrace === true;

  try {
    const tokens = await acceptanceEvidenceService.createUploadTokens(
      { workItemId: story.id, hasTrace },
      ctx,
    );
    return NextResponse.json(tokens, { status: 200 });
  } catch (err) {
    if (err instanceof AcceptanceEvidenceError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
