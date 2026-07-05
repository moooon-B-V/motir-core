import { NextResponse } from 'next/server';
import { authenticateJobRequest, JobAuthError } from '@/lib/ai/jobAuth';
import { githubCodeScanningProxyService } from '@/lib/services/githubCodeScanningProxyService';

// GET /api/internal/ai/code-scanning/analyses?repoRef=owner/name (MOTIR-1605) —
// the ai→core read-back the `code_audit` job calls to LIST a connected repo's
// GitHub code-scanning analyses, read with the tenant's installation token (so a
// PRIVATE repo is detectable; motir-ai holds no GitHub credential). Service-to-
// service ONLY (§4a service bearer + §4b job token, both via
// authenticateJobRequest). Thin transport per CLAUDE.md: authenticate, ONE
// service call, return. The workspace is the TOKEN's own — no caller-supplied
// tenant, so a token can only read its own workspace's connected repos.
//
// `{ analyses: null }` when the repo isn't connected / code scanning is
// unavailable — the detection step degrades to "source absent" (never a gate),
// so the service NEVER throws for a GitHub-side failure.
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

  const repoRef = new URL(req.url).searchParams.get('repoRef');
  if (!repoRef) {
    return NextResponse.json(
      { code: 'validation_error', error: 'repoRef is required' },
      { status: 400 },
    );
  }

  const analyses = await githubCodeScanningProxyService.listAnalyses(auth.ctx, repoRef);
  return NextResponse.json({ analyses });
}
