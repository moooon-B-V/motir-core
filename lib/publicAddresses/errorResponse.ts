import { NextResponse } from 'next/server';

import {
  HostnameTakenError,
  NoSubdomainClaimedError,
  PublicAddressesUnavailableError,
  ReservedLabelError,
  SubdomainForbiddenError,
  SubdomainRenameCapReachedError,
  WorkspaceNotVisibleError,
} from '@/lib/publicAddresses/errors';
import { TenantDomainNotConfiguredError } from '@/lib/publicAddresses/tenantDomain';

// Typed-error → HTTP-status mapper for the public-address routes.
// Story MOTIR-3878 · Subtask MOTIR-4215. Mirrors `lib/billing/errorResponse.ts`:
// the route layer is HTTP-only, so it calls one service method and hands
// whatever throws to this. Returns `null` for an unknown error so the route
// rethrows and the platform logs a genuine 500.
//
// ── The status choices, each of which is a decision ────────────────────────
//
//   404 for OFF-CLOUD and for a NON-MEMBER — the same code for two reasons, and
//       that is the point: both mean "there is nothing here for you", and giving
//       them different codes would let a caller tell a self-hosted build from a
//       workspace they cannot see.
//   403 for a MEMBER who is not an admin — they can see the workspace, so
//       telling them the control is admin-only leaks nothing and is the answer
//       they need.
//   409 for a TAKEN hostname — a conflict with state, not a bad request. It is
//       also the answer for "you already have one" on claim, because from the
//       caller's side both mean the name they asked for is not available.
//   422 for a REFUSED LABEL and a REACHED CAP — well-formed requests that fail a
//       domain rule, which is exactly what 422 is for.
//   503 for an unconfigured base domain — an OPERATOR problem, never the
//       caller's, and the one case here where retrying later may work.
export function mapPublicAddressError(err: unknown): NextResponse | null {
  if (err instanceof PublicAddressesUnavailableError || err instanceof WorkspaceNotVisibleError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof SubdomainForbiddenError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof HostnameTakenError) {
    return NextResponse.json(
      { code: err.code, error: err.message, hostname: err.hostname },
      { status: 409 },
    );
  }
  if (err instanceof ReservedLabelError) {
    // The refusal DISCRIMINATOR travels with it — `reserved` and `too_short`
    // send a customer to different next actions, and a single message would
    // make the pane parse prose to tell them apart.
    return NextResponse.json(
      { code: err.code, error: err.message, refusal: err.refusal },
      { status: 422 },
    );
  }
  if (err instanceof SubdomainRenameCapReachedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, used: err.used, cap: err.cap },
      { status: 422 },
    );
  }
  if (err instanceof NoSubdomainClaimedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof TenantDomainNotConfiguredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return null;
}
