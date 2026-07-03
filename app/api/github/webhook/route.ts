import { NextResponse, type NextRequest } from 'next/server';
import { verifyGithubWebhookSignature } from '@/lib/github/webhookSignature';
import { GithubWebhookNotConfiguredError, GithubWebhookSignatureError } from '@/lib/github/errors';
import { githubWebhookService } from '@/lib/services/githubWebhookService';

// POST /api/github/webhook (Story 7.10 · MOTIR-892) — the inbound GitHub App
// webhook: PR lifecycle → work-item status sync, plus the installation grant
// mirror. HTTP-only (CLAUDE.md 4-layer): this route verifies the signature and
// dispatches to ONE service method; ALL logic lives in `githubWebhookService`.
//
// Signature verification FIRST, over the RAW body, BEFORE any parse: an
// unauthentic delivery is rejected 401 and never processed. We then read the
// event type from `X-GitHub-Event`, parse the body, and hand both to the
// service. We return a fast 2xx on success (a slow handler makes GitHub retry)
// and never leak internals: a bad/missing signature → 401, an unconfigured
// secret → 500, a malformed JSON body → 400.

export async function POST(req: NextRequest): Promise<Response> {
  // Read the EXACT bytes GitHub signed — before any JSON parse (a re-serialized
  // body would not match the HMAC).
  const rawBody = await req.text();

  try {
    verifyGithubWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'));
  } catch (err) {
    if (err instanceof GithubWebhookSignatureError) {
      return NextResponse.json({ code: err.code }, { status: 401 });
    }
    if (err instanceof GithubWebhookNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 500 });
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: 'GITHUB_WEBHOOK_MALFORMED_BODY' }, { status: 400 });
  }

  const eventType = req.headers.get('x-github-event') ?? '';
  const result = await githubWebhookService.handleEvent(eventType, payload);
  // 2xx ack — the result payload is for logging/observability, not a contract.
  return NextResponse.json({ ok: true, result }, { status: 200 });
}
