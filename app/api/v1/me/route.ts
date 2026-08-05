import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentMe } from '@/lib/api/v1/identity/schema';
import { apiTokensService } from '@/lib/services/apiTokensService';

// GET /api/v1/me (Story 11.1 · Subtask 11.1.2 — MOTIR-1858) — the identity
// endpoint, and the first `/api/v1` route.
//
// Chosen as the wrapper's proving endpoint because it exercises the WHOLE
// envelope — bearer auth, the scope gate, the error mapping, the request id —
// with no collection and no resource modelling, so a failure here is
// unambiguously the wrapper's.
//
// Returning the token's GRANTED SCOPES is deliberate and load-bearing: it is
// how a client discovers what its own credential may do without probing
// endpoints and collecting 403s — the same reason `motir doctor` exists on the
// CLI side.
//
// 4-layer: parse nothing, call ONE service method (`apiTokensService.verify`),
// return. No `db.*`, no `$transaction`. The response is `presentMe`'s output —
// shaped field by field, never spread; that mapper's header records why (ADR
// Amendment 5 §4: a v1 route MAPS THROUGH its schema).
export const GET = withV1Route({ scope: 'read' }, async (ctx) => {
  const verified = await apiTokensService.verify(ctx.presentedToken);
  return NextResponse.json(presentMe(verified));
});
