import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';
import { UnknownSectionCellError } from '@/lib/workItems/sections/errors';

// GET /api/internal/ai/section-sets (Story MOTIR-9023 · MOTIR-9029) — the
// ai→core read of the section registry. motir-ai builds its `author` tool's
// schema from this at run time, so the hosted planner and `plan.py` cannot
// disagree about which sections a card needs. Service-to-service ONLY (the §4a
// service bearer + the §4b job token); never a cookie session. Thin transport:
// authenticate, ONE service call, map the typed error.
//
// Optional `?kind=&type=` narrows to one kind, one type or one cell. The
// descriptor's `version` rides the `ETag` header so motir-ai can cache by it.
//
//   JobAuthError             → 401
//   UnknownSectionCellError  → 400 { code, error }
export async function GET(req: Request): Promise<Response> {
  try {
    await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const params = new URL(req.url).searchParams;
  try {
    const descriptor = sectionSchemaService.describe({
      kind: params.get('kind'),
      type: params.get('type'),
    });
    return NextResponse.json(descriptor, { headers: { ETag: `"${descriptor.version}"` } });
  } catch (err) {
    if (err instanceof UnknownSectionCellError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    throw err;
  }
}
