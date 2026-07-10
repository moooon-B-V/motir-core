import { NextResponse, type NextRequest } from 'next/server';
import { verifyGitlabWebhookToken } from '@/lib/gitlab/webhookSignature';
import { GitlabWebhookNotConfiguredError, GitlabWebhookSignatureError } from '@/lib/gitlab/errors';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';

// POST /api/gitlab/webhook (Story 7.23 · MOTIR-1475) — the inbound GitLab project
// webhook: MR lifecycle → work-item status sync, driving the SAME status-sync
// consumer GitHub uses (`changeRequestStatusSync`). HTTP-only (CLAUDE.md 4-layer):
// this route verifies the secret token and dispatches to ONE service method; ALL
// logic lives in `gitlabWebhookService`.
//
// Token verification FIRST, BEFORE any parse: GitLab echoes the hook's configured
// secret verbatim in `X-Gitlab-Token` (there is no body HMAC, unlike GitHub), so
// we constant-time-compare it against `GITLAB_WEBHOOK_SECRET` and reject an
// unauthentic delivery 401 before the body is read as JSON. We then read the event
// type from `X-Gitlab-Event`, parse the body, and hand both to the service. We
// return a fast 2xx on success (a slow handler makes GitLab retry) and never leak
// internals: a bad/missing token → 401, an unconfigured secret → 500, a malformed
// JSON body → 400.

export async function POST(req: NextRequest): Promise<Response> {
  // Read the raw body once (the token is a header compare, so no
  // parse-order constraint like GitHub's HMAC — but we still verify BEFORE parsing
  // so an unauthentic delivery is never processed).
  const rawBody = await req.text();

  try {
    verifyGitlabWebhookToken(req.headers.get('x-gitlab-token'));
  } catch (err) {
    if (err instanceof GitlabWebhookSignatureError) {
      return NextResponse.json({ code: err.code }, { status: 401 });
    }
    if (err instanceof GitlabWebhookNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 500 });
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: 'GITLAB_WEBHOOK_MALFORMED_BODY' }, { status: 400 });
  }

  const eventType = req.headers.get('x-gitlab-event') ?? '';
  const result = await gitlabWebhookService.handleEvent(eventType, payload);
  // 2xx ack — the result payload is for logging/observability, not a contract.
  return NextResponse.json({ ok: true, result }, { status: 200 });
}
