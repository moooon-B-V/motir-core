import { NextResponse } from 'next/server';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import {
  authorizeAcceptancePublish,
  authorizeAcceptanceStatusRead,
} from '@/lib/acceptanceEvidence/publishAuth';
import {
  AcceptanceEvidenceError,
  AcceptanceEvidenceNotAStoryError,
} from '@/lib/acceptanceEvidence/errors';
import { AttachmentError } from '@/lib/blob/errors';
import type { AcceptanceEvidenceChapterDTO } from '@/lib/dto/acceptanceEvidence';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';

// POST /api/work-items/[id]/acceptance-evidence (Story MOTIR-1627 · Subtask
// MOTIR-1631; direct-to-Blob MOTIR-1681) — REGISTER a green E2E's video, already
// CLIENT-uploaded to the private store via the mint-token route, as PENDING
// acceptance evidence on the STORY. The video bytes never transit this function
// (they went straight to Blob), so a full 100MB video no longer hits the ~4.5MB
// serverless request-body cap. Thin HTTP layer (CLAUDE.md § 4-layer): shared
// auth+eligibility gate → parse JSON → one service call. The story stays
// `in_review` — the endpoint never advances the gate (a human Approves).
//
// JSON body: `videoPathname` (required), `tracePathname` (optional), `chapters`
// (`[{label,tSeconds}]`), `commitSha`, `ciRunUrl`, `producedByKey`.

function parseChapters(raw: unknown): AcceptanceEvidenceChapterDTO[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) =>
    e && typeof e.label === 'string' && typeof e.tSeconds === 'number'
      ? [{ label: e.label, tSeconds: e.tSeconds }]
      : [],
  );
}

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const identifier = id.trim().toUpperCase();

  const gate = await authorizeAcceptancePublish(req, identifier);
  if (gate instanceof Response) return gate;
  const { ctx, story } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const videoPathname = strOrNull(body.videoPathname);
  if (!videoPathname) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`videoPathname` is required.' },
      { status: 400 },
    );
  }

  try {
    const evidence = await acceptanceEvidenceService.recordFromPathnames(
      {
        workItemId: story.id,
        videoPathname,
        tracePathname: strOrNull(body.tracePathname),
        chapters: parseChapters(body.chapters),
        commitSha: strOrNull(body.commitSha),
        ciRunUrl: strOrNull(body.ciRunUrl),
        producedByKey: strOrNull(body.producedByKey),
      },
      ctx,
    );
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (err) {
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof AcceptanceEvidenceError || err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}

// GET /api/work-items/[id]/acceptance-evidence (MOTIR-4144) — the story's CURRENT
// receipt STATUS, for the CI caller that has to know whether a receipt is
// `approved`. Thin HTTP layer (CLAUDE.md § 4-layer): gate → one service call.
//
// WHY IT EXISTS. `tests/e2e-acceptance-lane-membership.test.ts` (MOTIR-2770) has
// asked this path since the day it was written, and until now nothing answered:
// the file exported POST and nothing else, so every call got **405**. The guard
// treats an unresolvable read as "not approved" — the right policy for a flaky
// hop — so a route that did not exist made its approved set empty on every call,
// for ever, and the check reported green for a structural reason no credential
// could fix. Its degradation notice was about the CREDENTIAL, so the log said
// the one true thing that was not the problem.
//
// WHAT IT ANSWERS, and the shape is the load-bearing part. A story the caller
// CAN see always reads **200**, with `evidence: null` when it has no receipt yet
// — the ordinary in-flight state, and by far the commonest answer. That is what
// leaves **404 unambiguous**: it means the KEY did not resolve for this
// credential, never "this story has nothing". A guard can therefore treat every
// non-2xx as a defect in its own wiring and say so out loud, which is exactly
// what a fail-open read could not do while 405 and "no receipt" were the same
// answer.
//
// It returns the status and nothing else — no `videoUrl`, no chapters, no
// provenance. A CI caller asking "is this frozen?" has no business reading the
// recording's signed content path, and a narrow body cannot leak a wider one
// later by accident.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const identifier = id.trim().toUpperCase();

  const gate = await authorizeAcceptanceStatusRead(req, identifier);
  if (gate instanceof Response) return gate;
  const { ctx, story } = gate;

  // Acceptance evidence is story-level (Principle #18). A leaf whose parent is
  // not a story is left unresolved by the gate, exactly as the publish path
  // leaves it — so the read refuses it the same way the write does, rather than
  // answering `null` and letting a caller conclude the story has no receipt.
  if (story.kind !== 'story') {
    const err = new AcceptanceEvidenceNotAStoryError(story.kind);
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
  }

  try {
    const evidence = await acceptanceEvidenceService.getCurrentForStory(story.id, ctx);
    return NextResponse.json(
      { evidence: evidence ? { status: evidence.status } : null },
      { status: 200 },
    );
  } catch (err) {
    const gate = workItemGateErrorResponse(err);
    if (gate) return gate;
    if (err instanceof AcceptanceEvidenceError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
