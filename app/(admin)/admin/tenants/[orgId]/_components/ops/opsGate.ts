/**
 * The ops toolkit's client-side GATES — design `platform-admin/design-notes.md`
 * AMENDMENT 2026-10-03, § _The safe-action pattern_ (MOTIR-752).
 *
 * Pure, so the dialogs and their tests share one answer to "may the primary be
 * pressed yet?". ⚠️ These are COURTESIES, never the rule: every service re-checks
 * the reason (the audit vocabulary's `reason: 'required'`), the amount and the
 * large-grant slug before anything is written. A primary disabled here is the
 * design's "a gate, never a post-submit error" — the server is the enforcement.
 */

/** A reason counts once it holds a non-blank character. */
export function reasonReady(reason: string): boolean {
  return reason.trim().length > 0;
}

/** The typed confirm: the org's slug, exactly (surrounding whitespace forgiven). */
export function slugConfirmed(typed: string, slug: string): boolean {
  return typed.trim() === slug;
}

/**
 * A whole number of credits from what an operator typed. Accepts the design's
 * minus sign (U+2212) as well as `-`, a leading `+`, and thousands separators;
 * anything else — a fraction, a letter, an empty field — is `null`.
 */
export function parseWholeCredits(raw: string): number | null {
  const cleaned = raw.replace(/−/g, '-').replace(/[\s,_]/g, '');
  if (!/^[+-]?\d{1,10}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

export interface GrantAmount {
  /** A positive whole number, or null. */
  credits: number | null;
  /** True when the amount is at or above the threshold — the slug field shows. */
  needsSlug: boolean;
  /** The balance the preview quotes, or null without a valid amount. */
  balanceAfter: number | null;
}

/** The amount half of a grant (Panel 2a/2b) — what the dialog previews. */
export function grantAmount(amountRaw: string, threshold: number, balance: number): GrantAmount {
  const parsed = parseWholeCredits(amountRaw);
  const credits = parsed !== null && parsed > 0 ? parsed : null;
  return {
    credits,
    needsSlug: credits !== null && credits >= threshold,
    balanceAfter: credits === null ? null : balance + credits,
  };
}

/** Grant: a positive whole amount, a reason, and the slug at or above the threshold. */
export function grantReady(input: {
  amountRaw: string;
  reason: string;
  typedSlug: string;
  slug: string;
  threshold: number;
}): boolean {
  const amount = grantAmount(input.amountRaw, input.threshold, 0);
  return (
    amount.credits !== null &&
    reasonReady(input.reason) &&
    (!amount.needsSlug || slugConfirmed(input.typedSlug, input.slug))
  );
}

export interface AdjustAmount {
  /** A signed, non-zero whole number, or null. */
  credits: number | null;
  balanceAfter: number | null;
  /** The adjustment would overdraw — refused here and by both services. */
  belowZero: boolean;
  /** The amount alone is acceptable (the reason is the dialog's). */
  valid: boolean;
}

/** The amount half of an adjustment (Panel 2c): the balance may not go below zero. */
export function adjustAmount(amountRaw: string, balance: number): AdjustAmount {
  const parsed = parseWholeCredits(amountRaw);
  const credits = parsed !== null && parsed !== 0 ? parsed : null;
  const balanceAfter = credits === null ? null : balance + credits;
  const belowZero = balanceAfter !== null && balanceAfter < 0;
  return { credits, balanceAfter, belowZero, valid: credits !== null && !belowZero };
}

/** Adjust: a valid amount and a reason. */
export function adjustReady(input: {
  amountRaw: string;
  reason: string;
  balance: number;
}): boolean {
  return adjustAmount(input.amountRaw, input.balance).valid && reasonReady(input.reason);
}

/** A fresh idempotency key for one dialog opening (the service's `adm_` shape). */
export function newRequestId(): string {
  return `adm_${globalThis.crypto.randomUUID()}`;
}
