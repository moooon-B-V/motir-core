// Node-only motir-ai BILLING boundary mock for E2E (Subtask 8.1.10).
//
// The billing user journeys (checkout / paywall / portal / seat sync) all read or
// initiate over the motir-core → motir-ai seam (lib/ai/motirAiClient.ts): the AI
// usage + Stripe subscription READS (`getOrgUsage` / `getOrgSubscription`) and the
// Stripe SESSION starts (`createCheckoutSession` / `createPortalSession` /
// `setSeatQuantity`). motir-ai owns the Stripe SDK + secret (the open-core
// invariant), so CI has no live Stripe and no motir-ai instance — this seam stands
// in for it, the SAME shape the OAuth (test-oauth-mock) and Blob (test-blob-mock)
// seams already use: an undici intercept installed by instrumentation.ts behind an
// E2E_TEST_BILLING=1 env gate, dormant everywhere else.
//
// What it intercepts (the MOTIR_AI_URL origin the E2E lane points at — an
// unresolvable host, so a missing intercept fails loud rather than escaping):
//   - GET  /v1/usage                 → the org's AI tier + credit balance
//   - GET  /v1/stripe/subscription   → the org's AI-pool Stripe subscription state
//   - POST /v1/stripe/checkout-session → a synthetic hosted Checkout URL
//   - POST /v1/stripe/portal-session   → a synthetic hosted Portal URL
//   - POST /v1/stripe/seat-quantity    → an applied seat-sync result
//
// PER-ORG state comes from a JSON FIXTURE FILE (MOTIR_AI_BILLING_FIXTURE_PATH),
// re-read on EVERY request — so a spec can REWRITE it mid-test to simulate the
// Stripe webhook landing (free → paid) and assert the billing panel reflects the
// new tier on its next authoritative read, with no optimistic-UI race
// (notes.html #45: wait on the deterministic signal, never the optimistic UI).
// The fixture maps `coreOrganizationId` (carried on every request) → the state the
// boundary should report; an org absent from the fixture gets the FREE/empty
// default. The session URLs are returned looking like the real Stripe hosts; the
// BROWSER-side navigation to them is fulfilled by the spec's own `page.route`, so
// nothing ever leaves localhost (the same split the blob mock documents).
//
// The shared MockAgent comes from instrumentation.ts (ONE global dispatcher serves
// this + the OAuth/Blob mocks — a second setGlobalDispatcher would silently
// disconnect the others).

import { readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

/** The synthetic hosted-session URLs the boundary returns (the spec's `page.route`
 *  fulfils the browser navigation to them — nothing leaves localhost). */
export const E2E_CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_e2e_billing';
export const E2E_PORTAL_URL = 'https://billing.stripe.com/p/session/e2e_billing';

/** The AI tier shape the usage read carries (mirrors RawUsageResponse.tier). */
export interface BillingFixtureTier {
  key: string;
  name: string;
  monthlyCreditAllotment: number;
}

/** The AI Stripe subscription shape (mirrors RawSubscriptionResponse). */
export interface BillingFixtureSubscription {
  status: string | null;
  currentPeriodEnd: string | null;
  priceId: string | null;
  planTier: BillingFixtureTier | null;
}

/** Web-search spend, as `/v1/usage` reports it (mirrors `RawUsageSearch`). */
export interface BillingFixtureSearch {
  totalSpend: number;
  monthSpend: number;
}

/** One run's search spend (mirrors `RawUsageSearchRun`). */
export interface BillingFixtureSearchRun {
  jobId: string;
  credits: number;
  lastSearchAt: string;
}

/**
 * The per-RUN half of search spend (mirrors `RawUsageSearchRuns`).
 *
 * ⚠️ `attributedByProject` is the one field with no counterpart on the wire, and
 * it exists to make the DRILL reachable in this lane. `attributedSpend` FOLLOWS
 * the drill while `search.totalSpend` does not, and that asymmetry is the whole
 * decision the search asset makes — a fixture that answered the same figure at
 * every scope could only ever assert it vacuously. Keyed by `coreProjectId`,
 * falling back to `attributedSpend` when the read is not project-scoped.
 */
export interface BillingFixtureSearchRuns {
  runs: BillingFixtureSearchRun[];
  attributedSpend: number;
  unattributedSpend: number;
  attributedByProject?: Record<string, number>;
}

/** One org's motir-ai-side billing state the boundary should report. */
export interface BillingFixtureEntry {
  balance: number;
  tier: BillingFixtureTier | null;
  subscription: BillingFixtureSubscription;
  /**
   * OPTIONAL, and the omission is meaningful rather than lazy (MOTIR-4560).
   * Absent ⇒ the boundary reports NO `search` / `searchRuns` block at all, which
   * is exactly the rolling-deploy shape motir-core renders as UNAVAILABLE. So a
   * fixture that says nothing about search drives the unavailable state, and one
   * that supplies zeroes drives the genuinely-zero state — the two an entire
   * story exists to keep apart.
   */
  search?: BillingFixtureSearch;
  searchRuns?: BillingFixtureSearchRuns;
  /** Token runs for the activity log, so a search row is judged beside real
   *  neighbours rather than alone. */
  recentRuns?: {
    jobId: string;
    jobKind: string;
    model: string | null;
    coreWorkspaceId: string;
    coreProjectId: string;
    inputTokens: number;
    outputTokens: number;
    credits: number;
    startedAt: string;
  }[];
  /**
   * The per-MODEL breakdown, as `/v1/usage` reports it (MOTIR-4575).
   *
   * ⚠️ WIDENED FOR THE SAME REASON `search` WAS (MOTIR-4560's note above): this
   * block was hardcoded to `[]`, so the dashboard's By-model panel could only
   * ever render its empty state in this lane — and Story MOTIR-4337's acceptance
   * walk has to show that panel POPULATED for an internal-billing org, because
   * "the whole dashboard, with real figures" is the thing being accepted. An
   * assertion against a panel that can only be empty is a check that can only
   * pass. Optional, so every existing spec keeps the empty breakdown it has.
   */
  perModel?: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
  /** Org-level token spend, so the dashboard's GLOBAL empty state can be kept
   *  off while search spend is zero — the distinction AC 4 drives. */
  totalSpend?: number;
  monthSpend?: number;
}

/** The fixture file shape: `coreOrganizationId` → its motir-ai billing state. */
export type BillingFixture = Record<string, BillingFixtureEntry>;

const FREE_DEFAULT: BillingFixtureEntry = {
  balance: 0,
  tier: null,
  subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
};

function readFixture(): BillingFixture {
  const path = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as BillingFixture;
  } catch {
    // Absent / mid-write — treat as "no org configured", i.e. everyone free. A
    // spec writes the file before it navigates, so a real read always sees it.
    return {};
  }
}

/** Resolve an org's state from the live fixture, falling back to free/empty. */
function entryFor(coreOrganizationId: string | null): BillingFixtureEntry {
  if (!coreOrganizationId) return FREE_DEFAULT;
  return readFixture()[coreOrganizationId] ?? FREE_DEFAULT;
}

function queryOf(reqPath: string): URLSearchParams {
  return new URLSearchParams(reqPath.includes('?') ? reqPath.slice(reqPath.indexOf('?') + 1) : '');
}

function queryOrgId(reqPath: string): string | null {
  return queryOf(reqPath).get('coreOrganizationId');
}

const json = { headers: { 'content-type': 'application/json' } } as const;

export function installBillingBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) {
    // No boundary origin configured — nothing to intercept (the billing lane
    // always sets MOTIR_AI_URL; a normal run never reaches here).
    return;
  }
  const pool = agent.get(origin);

  // GET /v1/usage — the AI tier + credit balance for the org (drives the AI line,
  // the paywall `blocked` threshold, and the post-upgrade tier reflection).
  pool
    .intercept({ path: (p) => p.startsWith('/v1/usage'), method: 'GET' })
    .reply((req) => {
      const orgId = queryOrgId(req.path);
      const e = entryFor(orgId);
      const q = queryOf(req.path);
      // ECHO the requested scope rather than hardcoding `org`. motir-core sends
      // the scope it RESOLVED server-side (a member is narrowed to their own
      // project before the call), so echoing it is what the real boundary does
      // and what lets a scoped read be told from an unscoped one.
      const scope = q.get('scope') ?? 'org';
      const coreProjectId = q.get('coreProjectId');
      const runs = e.recentRuns ?? [];
      return {
        statusCode: 200,
        data: {
          scope,
          coreOrganizationId: orgId,
          coreWorkspaceId: q.get('coreWorkspaceId'),
          coreProjectId,
          balance: e.balance,
          tier: e.tier,
          totalSpend: e.totalSpend ?? 0,
          monthSpend: e.monthSpend ?? 0,
          monthlyHistory: [],
          perModel: e.perModel ?? [],
          recentRuns: { runs, page: 1, pageSize: 20, total: runs.length },
          // ⚠️ SPREAD, not a default. An absent `search` must stay ABSENT on the
          // wire — that is the rolling-deploy shape motir-core renders as
          // UNAVAILABLE, and defaulting it to zeroes here would make the one
          // state this whole story distinguishes unreachable in the lane.
          ...(e.search ? { search: e.search } : {}),
          ...(e.searchRuns
            ? {
                searchRuns: {
                  runs: e.searchRuns.runs,
                  page: 1,
                  pageSize: 20,
                  total: e.searchRuns.runs.length,
                  // The org-level total never narrows; the attributed figure
                  // does, which is the asymmetry the surface labels.
                  attributedSpend:
                    (coreProjectId
                      ? e.searchRuns.attributedByProject?.[coreProjectId]
                      : undefined) ?? e.searchRuns.attributedSpend,
                  unattributedSpend: e.searchRuns.unattributedSpend,
                },
              }
            : {}),
        },
        responseOptions: json,
      };
    })
    .persist();

  // GET /v1/stripe/subscription — the AI-pool Stripe subscription lifecycle
  // (status + renewal + plan tier). EMPTY (status: null) for a free org.
  pool
    .intercept({ path: (p) => p.startsWith('/v1/stripe/subscription'), method: 'GET' })
    .reply((req) => {
      const e = entryFor(queryOrgId(req.path));
      return { statusCode: 200, data: e.subscription, responseOptions: json };
    })
    .persist();

  // POST /v1/stripe/checkout-session — a Stripe-hosted Checkout URL the client
  // redirects to (the spec asserts this POST's 200 + url, then `page.route`
  // fulfils the browser nav to E2E_CHECKOUT_URL).
  pool
    .intercept({ path: '/v1/stripe/checkout-session', method: 'POST' })
    .reply(200, { url: E2E_CHECKOUT_URL }, json)
    .persist();

  // POST /v1/stripe/portal-session — a Stripe-hosted Billing Portal URL.
  pool
    .intercept({ path: '/v1/stripe/portal-session', method: 'POST' })
    .reply(200, { url: E2E_PORTAL_URL }, json)
    .persist();

  // POST /v1/stripe/seat-quantity — the scaled-tracker seat sync (8.1.12). The
  // billing journeys don't drive it, but stub it so any seat-screen read that
  // reaches the boundary returns a clean applied result rather than a 502.
  pool
    .intercept({ path: '/v1/stripe/seat-quantity', method: 'POST' })
    .reply(200, { applied: true, outcome: 'updated' }, json)
    .persist();
}
