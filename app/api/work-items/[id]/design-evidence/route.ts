import { NextResponse } from 'next/server';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { authorizeDesignPublish } from '@/lib/designEvidence/publishAuth';
import { DesignEvidenceError } from '@/lib/designEvidence/errors';
import { AttachmentError } from '@/lib/blob/errors';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import type { DesignAssetKindDTO } from '@/lib/dto/designEvidence';

// POST /api/work-items/[id]/design-evidence (Story MOTIR-2664 · Subtask
// MOTIR-2667) — REGISTER design artifacts already CLIENT-uploaded to the private
// store via the mint-token route as the item's new CURRENT design result. Thin
// HTTP layer (CLAUDE.md § 4-layer): shared auth gate → parse JSON → one service
// call.
//
// ⚠️ The target is the work item ITSELF — no roll-up to a parent story. A design
// result belongs to the card that produced it; a story has many designs, one per
// design subtask (docs/decisions/design-result.md §3). That is the deliberate
// mirror image of the acceptance publish beside it.
//
// ⚠️ The endpoint never advances the item's status. Publishing is EVIDENCE, not
// a workflow decision: holding the dependents and asking a human to approve is
// the runtime design-approval gate's call to make later (§7).
//
// JSON body: `assets` (required — `[{ kind, sourcePath, pathname }]`), `noteMd`,
// `commitSha`, `ciRunUrl`, `producedByKey`.

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

function parseAssets(
  raw: unknown,
): Array<{ kind: DesignAssetKindDTO; sourcePath: string; pathname: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) =>
    e &&
    typeof e.kind === 'string' &&
    typeof e.sourcePath === 'string' &&
    e.sourcePath.trim() !== '' &&
    typeof e.pathname === 'string' &&
    e.pathname.trim() !== ''
      ? [{ kind: e.kind as DesignAssetKindDTO, sourcePath: e.sourcePath, pathname: e.pathname }]
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const assets = parseAssets(body.assets);
  if (assets.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`assets` must be a non-empty array.' },
      { status: 400 },
    );
  }

  try {
    const evidence = await designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        assets,
        noteMd: strOrNull(body.noteMd),
        commitSha: strOrNull(body.commitSha),
        ciRunUrl: strOrNull(body.ciRunUrl),
        producedByKey: strOrNull(body.producedByKey),
      },
      ctx,
    );
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (err) {
    const gateError = workItemGateErrorResponse(err);
    if (gateError) return gateError;
    if (err instanceof DesignEvidenceError || err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
