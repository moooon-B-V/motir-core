import { NextResponse } from 'next/server';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { authorizeDesignPublish } from '@/lib/designEvidence/publishAuth';
import { DesignEvidenceError } from '@/lib/designEvidence/errors';
import { AttachmentError } from '@/lib/blob/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import type { DesignAssetKindDTO } from '@/lib/dto/designEvidence';

// POST /api/work-items/[id]/design-evidence/upload-token (Story MOTIR-2664 ·
// Subtask MOTIR-2667) — mint scoped CLIENT upload grants so a trusted CI job
// PUTs each design artifact DIRECTLY to the private store. The bytes never
// transit this function, so a mock is not bounded by the serverless request-body
// cap and cannot repeat the 413 the acceptance video hit (MOTIR-1681). Thin HTTP
// layer (CLAUDE.md § 4-layer): shared auth gate → parse JSON → one service call.
//
// JSON body: `files` — `[{ kind, sourcePath, contentType }]`. CI then PUTs each
// grant and reports the resulting pathnames to the sibling register route.

interface FileRequest {
  kind: DesignAssetKindDTO;
  sourcePath: string;
  contentType: string;
}

function parseFiles(raw: unknown): FileRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) =>
    e &&
    typeof e.kind === 'string' &&
    typeof e.sourcePath === 'string' &&
    e.sourcePath.trim() !== '' &&
    typeof e.contentType === 'string'
      ? [
          {
            kind: e.kind as DesignAssetKindDTO,
            sourcePath: e.sourcePath,
            contentType: e.contentType,
          },
        ]
      : [],
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const identifier = id.trim().toUpperCase();

  const gate = await authorizeDesignPublish(req, identifier);
  if (gate instanceof Response) return gate;
  const { ctx, item } = gate;

  // The `.catch` guarantees an object, so `body.files` needs no optional chain —
  // an unparseable body simply yields no files and falls into the 400 below.
  const body = (await req.json().catch(() => ({}))) as { files?: unknown };
  const files = parseFiles(body.files);
  if (files.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`files` must be a non-empty array.' },
      { status: 400 },
    );
  }

  try {
    const tokens = await designEvidenceService.createUploadTokens(
      { workItemId: item.id, files },
      ctx,
    );
    return NextResponse.json(tokens, { status: 200 });
  } catch (err) {
    const gateError = workItemGateErrorResponse(err);
    if (gateError) return gateError;
    if (err instanceof DesignEvidenceError || err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
