import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { githubCodeScanningProxyService } from '@/lib/services/githubCodeScanningProxyService';

// GET /api/internal/ai/code-scanning/sarif?repoRef=owner/name&analysisId=N
// (MOTIR-1605) — the ai→core read-back that FETCHES one code-scanning analysis's
// SARIF document for a connected repo, read with the tenant's installation token
// and returned OPAQUE (motir-ai validates + normalizes it). Same §4a+§4b
// service-to-service auth + own-workspace scoping as the analyses route.
//
// `{ sarif: null }` when the repo isn't connected / the document is unfetchable —
// the detector skips it (never a gate).
export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = authenticateJobRequest(req);
  } catch (err) {
    if (err instanceof JobAuthError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  const params = new URL(req.url).searchParams;
  const repoRef = params.get('repoRef');
  const analysisIdRaw = params.get('analysisId');
  if (!repoRef) {
    return NextResponse.json(
      { code: 'validation_error', error: 'repoRef is required' },
      { status: 400 },
    );
  }
  const analysisId = Number(analysisIdRaw);
  if (!analysisIdRaw || !Number.isInteger(analysisId) || analysisId < 0) {
    return NextResponse.json(
      { code: 'validation_error', error: 'analysisId must be a non-negative integer' },
      { status: 400 },
    );
  }

  const sarif = await githubCodeScanningProxyService.getSarif(auth.ctx, repoRef, analysisId);
  return NextResponse.json({ sarif });
}
