import { NextResponse } from 'next/server';
import { LEGAL_DOCUMENTS_ENV, legalManifestState } from '@/lib/legal/documents';
import { productionGate } from '../_helpers';

// `PUT /api/_test/legal-manifest` — MOVE THE RUNNING SERVER BETWEEN THE TWO ARMS
// OF MOTIR-3909 (Subtask MOTIR-4015).
//
// ── ⚠️ WHY A DOOR AND NOT A SECOND LANE ─────────────────────────────────────
//
// The manifest is a PROCESS-WIDE, SERVER-SIDE read: `legalManifestState()` looks
// at `process.env[MOTIR_LEGAL_DOCUMENTS]` and there is no per-request override
// and no client seam a `page.route()` stub can reach. So the arm a spec runs
// against is a property of the SERVER, not of the test — and the two arms this
// story ships (a self-hoster who configured nothing, an operator who configured
// four documents) are therefore two different servers.
//
// The obvious answer is two `webServer` entries on two ports, and it was
// rejected: the acceptance receipt is ONE recording a human watches, and a
// recording that jumps between origins mid-clip is showing two builds rather
// than one build changing. What a reviewer needs to see is the transition — a
// deployment with no legal documents, then the operator supplies them, then the
// same deployment linking to them.
//
// ⚠️ THE MECHANISM THAT MAKES THIS HONEST IS THE LOADER'S OWN, and it is not a
// test affordance: `lib/legal/documents.ts` deliberately keeps NO module-level
// cache, because "a cache serves the PREVIOUS version of the Terms for the life
// of a server process after a deploy". It reads `process.env` at the moment of
// the call, through a COMPUTED key (`process.env[LEGAL_DOCUMENTS_ENV]`), which
// Next cannot statically inline. So mutating the variable here really does move
// the next render — the same way `fly secrets set` does, one process restart
// earlier.
//
// ── ⚠️ WHY IT IS NOT AUTH-GATED ─────────────────────────────────────────────
//
// Its sibling handlers call `requireContext()`; this one does not, and
// `db-role/route.ts` is the precedent. The state it changes is a property of the
// PROCESS, not of a tenant — there is no workspace to resolve it against — and
// the spec's first act is at `/sign-up`, where there is no session to resolve at
// all. What keeps it safe is the same thing that keeps `db-role` safe:
// `productionGate()` 404s the whole `_test` subtree in any real production build,
// and the E2E harness that re-relaxes that seam is only ever the Playwright
// webServer (`lib/e2eProdHarness.ts`), never a deploy.
//
// ── ON THE 4-LAYER RULE ─────────────────────────────────────────────────────
//
// CLAUDE.md's Route → Service → Repository → Prisma contract governs "every
// endpoint that touches the database". This one touches none: no `db`, no
// transaction, no tenant row. There is no service to extract because there is no
// business logic — the whole handler is "write the operator's configuration, then
// report what the shipped reader makes of it", and the reader it reports through
// is production code (`legalManifestState`), which is what makes the answer
// trustworthy as a mount check.

/** The body: an array of manifest entries, or `null` to UNSET the variable. */
interface Body {
  manifest: unknown[] | null;
}

export async function PUT(request: Request): Promise<NextResponse> {
  const gated = productionGate();
  if (gated) return gated;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }

  if (body.manifest === null) {
    delete process.env[LEGAL_DOCUMENTS_ENV];
  } else if (Array.isArray(body.manifest)) {
    process.env[LEGAL_DOCUMENTS_ENV] = JSON.stringify(body.manifest);
  } else {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }

  // Report through the SHIPPED reader, not through what we just wrote. A caller
  // asserting on this is asserting that the server's own loader agrees — which
  // is the whole point of a mount check, and is why a faulted manifest reads
  // back as `faulted` here rather than as a 200 that hid it.
  const state = legalManifestState();
  return NextResponse.json({
    status: state.status,
    slugs: state.documents.map((document) => document.slug),
    faults: state.faults,
  });
}
