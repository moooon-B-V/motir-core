import { NextResponse } from 'next/server';
import { DOCS_URL_ENV, docsIndexUrl } from '@/lib/docs/links';
import { productionGate } from '../_helpers';

// `PUT /api/_test/docs-url` — MOVE THE RUNNING SERVER BETWEEN THE TWO ARMS OF
// THE HELP MENU'S `Docs` ROW (Story MOTIR-4237 · Subtask MOTIR-4241).
//
// ── ⚠️ WHY A DOOR AND NOT A SECOND LANE ─────────────────────────────────────
//
// The exact argument its sibling `legal-manifest/route.ts` makes, about the
// other of the Help menu's two configured rows — read that file's header for
// the long form. In short: `MOTIR_DOCS_URL` is a PROCESS-WIDE, SERVER-SIDE read
// (`lib/docs/links.ts`, resolved in `app/(authed)/layout.tsx` and passed to
// `HelpMenu` as a prop), so the arm a spec runs against is a property of the
// SERVER and not of the test. Both this repository's Playwright lanes CONFIGURE
// a docs url, so without a door the unconfigured arm — the self-hoster who
// pointed the row nowhere — is unreachable from any spec, and an acceptance
// receipt that only ever films the configured build is filming half the story.
//
// Two `webServer` entries on two ports would also give two arms, and are
// rejected here for the reason recorded next door: the receipt is ONE recording
// a human watches, and a clip that jumps origins mid-way shows two builds
// rather than one build changing.
//
// ⚠️ THE MECHANISM THAT MAKES THIS HONEST IS THE RESOLVER'S OWN, and it is not
// a test affordance: `docsIndexUrl()` keeps no cache and reads
// `process.env[DOCS_URL_ENV]` through a COMPUTED key, which Next cannot
// statically inline. So mutating the variable here really does move the next
// render — the same way `fly secrets set` does, one process restart earlier.
//
// ── ⚠️ WHY IT IS NOT AUTH-GATED ─────────────────────────────────────────────
//
// Same as `legal-manifest` and `db-role`, and for the same reason: the state it
// changes is a property of the PROCESS, not of a tenant, so there is no
// workspace to resolve it against. `productionGate()` 404s the whole `_test`
// subtree in any real production build, and the E2E harness that re-relaxes
// that seam is only ever the Playwright webServer (`lib/e2eProdHarness.ts`),
// never a deploy.
//
// ── ON THE 4-LAYER RULE ─────────────────────────────────────────────────────
//
// CLAUDE.md's Route → Service → Repository → Prisma contract governs "every
// endpoint that touches the database". This one touches none: no `db`, no
// transaction, no tenant row. It writes the operator's configuration and then
// reports what the SHIPPED reader makes of it — which is what makes the answer
// trustworthy as a mount check, and is why a value the resolver REFUSES (a
// relative path, a `mailto:` url) reads back as `null` here rather than as a
// 200 that hid it.

/**
 * READ the arm without changing it — the docs analogue of `/api/health/legal`,
 * which is a shipped route only because the legal manifest has a health surface
 * and the docs url does not. A caller uses this to prove which arm the LANE
 * configured before it changes anything, so a spec that asserts the configured
 * row is never asserting it against a server some earlier spec left unset.
 */
export async function GET(): Promise<NextResponse> {
  const gated = productionGate();
  if (gated) return gated;
  return NextResponse.json({ configured: docsIndexUrl() });
}

/** The body: the absolute documentation url, or `null` to UNSET the variable. */
interface Body {
  url: string | null;
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

  if (body.url === null) {
    delete process.env[DOCS_URL_ENV];
  } else if (typeof body.url === 'string') {
    process.env[DOCS_URL_ENV] = body.url;
  } else {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }

  // Reported through the SHIPPED resolver, not through what we just wrote — the
  // whole point of a mount check. A caller asserting on `configured` is
  // asserting that the server's own reader agrees.
  return NextResponse.json({ configured: docsIndexUrl() });
}
