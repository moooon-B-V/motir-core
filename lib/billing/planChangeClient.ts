import type {
  DowngradePreviewDTO,
  DowngradeResultDTO,
  UpgradePreviewDTO,
  UpgradeResultDTO,
} from '@/lib/dto/billing';
import type { PlanChangeRefusalReason } from '@/lib/ai/errors';

// The browser side of the plan-change dialogs (Story MOTIR-8387 · MOTIR-8399):
// the two previews and the two confirms over
// /api/organizations/[orgId]/billing/{upgrade,downgrade}[/preview]. Every outcome
// the server can give is folded into a closed union, so a dialog switches on a
// `kind` (and a refusal's `reason`), never on a status code.

export type PlanChangeOutcome<T> =
  | { kind: 'ok'; value: T }
  /** BILLING_PLAN_CHANGE_REFUSED — the reason the dialog draws. */
  | { kind: 'refused'; reason: PlanChangeRefusalReason }
  /** 403 — the viewer cannot change the plan (lost `manageBilling`). */
  | { kind: 'forbidden' }
  /** Nothing reached the server, or it failed (5xx / anything unexpected). */
  | { kind: 'error' };

async function post<T>(
  orgId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<PlanChangeOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/organizations/${encodeURIComponent(orgId)}/billing/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'error' };
  }
  const answer: unknown = await res.json().catch(() => null);
  const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  if (res.ok) return answer ? { kind: 'ok', value: answer as T } : { kind: 'error' };
  if (a.code === 'BILLING_PLAN_CHANGE_REFUSED' && typeof a.reason === 'string') {
    return { kind: 'refused', reason: a.reason as PlanChangeRefusalReason };
  }
  if (res.status === 403) return { kind: 'forbidden' };
  return { kind: 'error' };
}

export function previewUpgrade(
  orgId: string,
  toPlanKey: string,
): Promise<PlanChangeOutcome<UpgradePreviewDTO>> {
  return post(orgId, 'upgrade/preview', { toPlanKey });
}

export function confirmUpgrade(
  orgId: string,
  toPlanKey: string,
  prorationDate: number,
): Promise<PlanChangeOutcome<UpgradeResultDTO>> {
  return post(orgId, 'upgrade', { toPlanKey, prorationDate });
}

export function previewDowngrade(
  orgId: string,
  toPlanKey: string,
): Promise<PlanChangeOutcome<DowngradePreviewDTO>> {
  return post(orgId, 'downgrade/preview', { toPlanKey });
}

export function confirmDowngrade(
  orgId: string,
  toPlanKey: string,
): Promise<PlanChangeOutcome<DowngradeResultDTO>> {
  return post(orgId, 'downgrade', { toPlanKey });
}
