import { NextResponse, type NextRequest } from 'next/server';
import { verifyResendWebhookSignature } from '@/lib/resend/webhookSignature';
import { ResendWebhookNotConfiguredError, ResendWebhookSignatureError } from '@/lib/resend/errors';
import { resendWebhookService } from '@/lib/services/resendWebhookService';

// POST /api/resend/webhook (Bug MOTIR-3507 · Subtask MOTIR-3515) — the inbound
// delivery webhook: `email.delivered` / `email.bounced` / `email.complained` /
// `email.delivery_delayed` → the message's delivery state.
//
// Until this route existed, Resend knew what became of every message we sent
// and had nowhere to say it: `git ls-tree` over `app/api` returned exactly two
// webhook routes, GitHub's and GitLab's. That is why a spam-foldered invitation
// could only be found by a human opening the folder.
//
// HTTP-only (CLAUDE.md 4-layer): this route verifies the signature and
// dispatches to ONE service method; ALL logic lives in `resendWebhookService`.
// It is deliberately the same shape as `app/api/github/webhook/route.ts`, down
// to the status map — a second webhook that answered differently would be a
// second contract for an operator to learn.
//
// Signature verification FIRST, over the RAW body, BEFORE any parse: an
// unauthentic delivery is rejected 401 and never processed. We then parse, hand
// the body to the service, and return a fast 2xx (a slow handler makes Resend
// retry). Never leak internals: a bad/missing/stale signature → 401, an
// unconfigured secret → 500, a malformed JSON body → 400.

export async function POST(req: NextRequest): Promise<Response> {
  // The EXACT bytes Resend signed — before any JSON parse (a re-serialized body
  // would not match the HMAC).
  const rawBody = await req.text();

  try {
    verifyResendWebhookSignature(rawBody, {
      id: req.headers.get('svix-id'),
      timestamp: req.headers.get('svix-timestamp'),
      signature: req.headers.get('svix-signature'),
    });
  } catch (err) {
    if (err instanceof ResendWebhookSignatureError) {
      return NextResponse.json({ code: err.code }, { status: 401 });
    }
    if (err instanceof ResendWebhookNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 500 });
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: 'RESEND_WEBHOOK_MALFORMED_BODY' }, { status: 400 });
  }

  // Every outcome the service can reach is a 2xx, including the ones that
  // changed nothing — an unknown message id, a duplicate, a late event. See the
  // service: an error here only buys a retry of something no retry can fix.
  const result = await resendWebhookService.handleEvent(payload as Record<string, never>);
  return NextResponse.json({ ok: true, result }, { status: 200 });
}
