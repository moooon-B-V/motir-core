import { NextResponse } from 'next/server';

import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { PublicAddressesUnavailableError } from '@/lib/publicAddresses/errors';
import {
  PublicHostNotFoundError,
  publicAddressesService,
} from '@/lib/services/publicAddressesService';

// GET /api/public/hosts/{host} — Story MOTIR-3878 · Subtask MOTIR-4217.
//
// The PRODUCER end of a two-ended integration: `motir-marketing`'s host router
// (MOTIR-4220) calls this server-side, on every request to a tenant host, before
// any page renders. Without it the consumer card has nothing to call.
//
// ── ANONYMOUS, and there is no `getSession()` in this file ────────────────
//
// Unlike its siblings under `app/api/public/`, this route does not read a
// session even to personalise. It is called by another SERVER, before a page
// exists, with no user in the picture — and a session read here would be a
// credential-shaped thing on a path that has no credential. The absence is
// asserted by `tests/api/public/anonymous-posture.test.ts`.
//
// ── NO rate-limit guard, and that is the SHIPPED read shape ──────────────
//
// The card's step list says "then the rate-limit guard". No read route under
// `app/api/public/` has one — the limiter is on the WRITE paths (`requests`,
// `follow`, `subscribe`). Adding one here would give this route a guard none of
// its eleven read siblings carry, so it follows the shipped shape instead and
// the deviation is recorded on the card. Rung 2 over rung 3.
//
// HTTP only: gate → one service call → map errors (the 4-layer rule).

/**
 * How long a resolution may be cached.
 *
 * The router reads this on EVERY request to a tenant host, and the answer
 * changes only when a customer acts — claims, renames, promotes or removes an
 * address. `stale-while-revalidate` means a rename is visible within a minute
 * without any request ever waiting on this hop.
 */
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ host: string }> },
): Promise<Response> {
  // The capability gate FIRST — before anything else. With `MOTIR_CLOUD` unset
  // this surface does not exist (ADR §11).
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { host } = await params;

  try {
    const resolution = await publicAddressesService.resolveHost(decodeURIComponent(host));
    return NextResponse.json(resolution, { headers: { 'Cache-Control': CACHE_CONTROL } });
  } catch (err) {
    // ⚠️ ONE refusal shape for every reason — unknown host, un-issued
    // certificate, the base domain, a non-cloud build. A caller must not be able
    // to tell "no such tenant" from "a tenant exists but is not serving yet";
    // that difference is precisely what would make walking hostnames worthwhile.
    if (err instanceof PublicHostNotFoundError || err instanceof PublicAddressesUnavailableError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
