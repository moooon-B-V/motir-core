import type { EnterpriseRequestDTO, EnterpriseRequestInput } from '@/lib/dto/billing';

// The browser side of the Enterprise card's Contact sales (Story MOTIR-7602 ·
// Subtask MOTIR-7607): the GET of the org's open request, read beside the
// billing status, and the POST that sends one. Plain `fetch` over
// /api/organizations/[orgId]/billing/enterprise-request (MOTIR-7605); every
// server-visible outcome is folded into a closed union here so the dialog
// switches on a `kind`, never on a status code.

function url(orgId: string): string {
  return `/api/organizations/${encodeURIComponent(orgId)}/billing/enterprise-request`;
}

/** A body is a request DTO only if it carries the fields the card reads. */
function isRequestDTO(body: unknown): body is EnterpriseRequestDTO {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.id === 'string' && typeof b.createdAt === 'string' && typeof b.status === 'string'
  );
}

/**
 * The org's OPEN request, `null` when none is open, or `undefined` when it could
 * not be read (a refusal, a network failure, an unexpected body). `undefined`
 * is "unknown", and the card then offers Contact sales: the server still refuses
 * a second open request (409), so guessing "none" can never send two.
 */
export async function fetchOpenEnterpriseRequest(
  orgId: string,
): Promise<EnterpriseRequestDTO | null | undefined> {
  try {
    const res = await fetch(url(orgId));
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (body === null) return null;
    return isRequestDTO(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Every answer the POST can give, as the dialog draws it (design panels 4, 6, 8). */
export type SendEnterpriseRequestResult =
  | { kind: 'sent'; request: EnterpriseRequestDTO }
  /** 409 `ENTERPRISE_REQUEST_OPEN` — another tab or admin already asked. */
  | { kind: 'already_open'; openRequestId: string | null }
  /** 403 — the viewer lost `manageBilling` since the page loaded. */
  | { kind: 'forbidden' }
  /** 400 — the server's validation, naming the field that failed. */
  | { kind: 'invalid'; field: string }
  /** Nothing reached the server, or it failed (5xx / anything unexpected). */
  | { kind: 'error' };

export async function sendEnterpriseRequest(
  orgId: string,
  input: EnterpriseRequestInput,
): Promise<SendEnterpriseRequestResult> {
  let res: Response;
  try {
    res = await fetch(url(orgId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { kind: 'error' };
  }
  const body: unknown = await res.json().catch(() => null);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (res.ok) {
    return isRequestDTO(body) ? { kind: 'sent', request: body } : { kind: 'error' };
  }
  if (res.status === 409 && b.code === 'ENTERPRISE_REQUEST_OPEN') {
    return {
      kind: 'already_open',
      openRequestId: typeof b.openRequestId === 'string' ? b.openRequestId : null,
    };
  }
  if (res.status === 403) return { kind: 'forbidden' };
  if (res.status === 400 && typeof b.field === 'string') {
    return { kind: 'invalid', field: b.field };
  }
  return { kind: 'error' };
}
