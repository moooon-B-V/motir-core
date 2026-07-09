import { NextResponse } from 'next/server';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { authorizeAcceptancePublish } from '@/lib/acceptanceEvidence/publishAuth';
import { AcceptanceEvidenceError } from '@/lib/acceptanceEvidence/errors';
import { AttachmentError } from '@/lib/blob/errors';
import type { AcceptanceEvidenceChapterDTO } from '@/lib/dto/acceptanceEvidence';

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
    if (err instanceof AcceptanceEvidenceError || err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
