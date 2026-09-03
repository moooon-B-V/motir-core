import { NextResponse } from 'next/server';

import { EntitlementExceededError } from '@/lib/billing/errors';
import {
  AddressNotFoundError,
  AddressNotIssuedError,
  InvalidHostnameError,
  NotACustomerDomainError,
} from '@/lib/publicAddresses/errors';
import {
  CertificateProviderNotConfiguredError,
  CertificateProviderUnavailableError,
} from '@/lib/publicAddresses/certificateProvider';

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

// ── The customer-domain lifecycle's mappings (MOTIR-4216) ──────────────────

/**
 * The lifecycle routes' mapper. Falls through to {@link mapPublicAddressError}
 * for everything the subdomain routes already map, so the two surfaces cannot
 * answer the same typed error two different ways.
 */
export function mapCustomDomainError(err: unknown): NextResponse | null {
  if (err instanceof AddressNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof InvalidHostnameError || err instanceof NotACustomerDomainError) {
    // 422 — well-formed request, refused by a domain rule. The two carry
    // different codes so the pane can say *you already have this address*
    // rather than *that is not a hostname*.
    return NextResponse.json(
      { code: err.code, error: err.message, hostname: err.hostname },
      { status: 422 },
    );
  }
  if (err instanceof AddressNotIssuedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, status: err.status },
      { status: 409 },
    );
  }
  if (err instanceof EntitlementExceededError) {
    // ⚠️ THE BILLING SURFACE'S OWN SHAPE, deliberately — 402 with `entitlement`
    // and `detail`. The pane's upgrade prompt keys off that field, so answering
    // a cap here in a different shape would mean the same refusal renders one
    // way from billing and another from this surface.
    return NextResponse.json(
      { code: err.code, error: err.message, entitlement: err.entitlement, detail: err.detail },
      { status: 402 },
    );
  }
  if (err instanceof CertificateProviderUnavailableError) {
    // 503 — ours to retry, never the caller's to fix.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  if (err instanceof CertificateProviderNotConfiguredError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return mapPublicAddressError(err);
}
