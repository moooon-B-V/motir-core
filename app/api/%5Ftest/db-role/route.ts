import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { productionGate } from '../_helpers';

// `GET /api/_test/db-role` — WHICH ROLE IS THIS SERVER CONNECTED AS? (MOTIR-2816)
//
// The one question no other vantage point can answer. `TEST_DB_APP_ROLE=1` tells
// a Vitest process which role the code under test uses; nothing tells you which
// role the running Next.js SERVER uses, and that is the only thing production's
// safety depends on. A psql session cannot answer it either — it reports ITS own
// connection, not the server's.
//
// ⚠️ IT EXISTS TO STOP A WHOLE SPEC PASSING VACUOUSLY. Every assertion in
// `app-role-surfaces.spec.ts` is green against an owner-role server, because RLS
// is inert for a BYPASSRLS role: the suite would report success while proving
// nothing. So that spec asks this first and REFUSES to continue if the answer is
// wrong. Same shape as the rest of this story — an empty-but-valid answer is the
// failure mode, so the instrument has to be checked before it is trusted.
//
// ── Why it is safe ───────────────────────────────────────────────────────────
// It is a `_test` route, so `productionGate()` 404s it in any real production
// build (the E2E harness relaxes that one seam and nothing else — see
// `lib/e2eProdHarness.ts`). It reads two catalogue facts about the CONNECTION
// and nothing about any tenant: no table, no row, no user data, nothing an
// attacker could not learn by causing an error message. It is deliberately NOT
// auth-gated, unlike its siblings, because the spec asks it before signing in —
// and the answer is a property of the process, not of a session.
//
// ── For MOTIR-2515 ───────────────────────────────────────────────────────────
// The cutover's step 4 is "ask the database `SELECT current_user,
// row_security_active(…)`". This is that step, made reproducible: point it at a
// deployed origin after the switch and it answers for the deployed server.
//
//   curl -s https://<origin>/api/_test/db-role
//   → {"currentUser":"motir_app","bypassesRls":false}
//
// (On a real production build it 404s — by design. The cutover check runs
// against a preview/staging deploy of the same build, or the operator asks the
// database directly; what this route removes is the guesswork about WHICH
// connection string the server actually picked up.)

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const gated = productionGate();
  if (gated) return gated;

  const [row] = await db.$queryRaw<Array<{ current_user: string; bypasses_rls: boolean }>>`
    SELECT current_user::text AS current_user,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls`;

  return NextResponse.json({
    currentUser: row?.current_user ?? null,
    // A BYPASSRLS role makes every policy inert. This is the flag that decides
    // whether an assertion about tenant isolation means anything at all.
    bypassesRls: row?.bypasses_rls ?? null,
  });
}
