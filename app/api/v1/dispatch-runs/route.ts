import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import { dispatchRunOpenBodySchema } from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';

// POST /api/v1/dispatch-runs (Story MOTIR-1789 · MOTIR-1792) — OPEN a run WITH
// ITS SET, specified by `docs/decisions/dispatch-run-record.md`.
//
// ── Why the SET rides in the body of the OPEN ──────────────────────────────
// The set is settled at the one moment it exists: a scope claim has just
// returned its members, or a batch snapshot has just been frozen. Accepting it
// here — rather than letting it accrete from per-card events — is the whole
// difference between a record of what the run SET OUT TO DO and a record of what
// it got round to, and the skipped cards exist nowhere else at all.
//
// ── Why PAT and not the cookie session ────────────────────────────────────
// The reporter is a headless process on the operator's own machine. It holds the
// same `ApiToken` the rest of the work loop uses, and `withV1Route` resolves it
// to the TOKEN's own workspace — never the owner's default — so a run is
// attributed to the token's user in the token's workspace.
//
// ── The route decides NOTHING ─────────────────────────────────────────────
// It parses a body and calls ONE service method. The idempotency read, the
// SET resolution, the transaction and the `P2002` translation all live in
// `dispatchRunService.open`.
//
// ⚠️ 201, not 200 — including on the IDEMPOTENT REPEAT. The repeat is not a
// different outcome to a client: it holds the run it asked for either way, and
// `created` is the field that says which happened. Splitting the status would
// make every caller branch on a code to learn something the body already tells
// them.
export const POST = withV1Route({ permission: 'work_item:edit' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, dispatchRunOpenBodySchema);

  const opened = await dispatchRunService.open(
    {
      projectKey: body.projectKey,
      command: body.command,
      origin: body.origin,
      ...(body.scopeKey !== undefined ? { scopeKey: body.scopeKey } : {}),
      ...(body.scopeLabel !== undefined ? { scopeLabel: body.scopeLabel } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
      cards: body.cards.map((card) => ({
        key: card.key,
        disposition: card.disposition,
        ...(card.skipReason !== undefined ? { skipReason: card.skipReason } : {}),
      })),
    },
    ctx.service,
  );

  return NextResponse.json(opened, { status: 201 });
});
