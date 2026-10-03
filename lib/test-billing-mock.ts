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
//   - GET  /v1/stripe/billing-history → the org's payment method + recent invoices
//   - POST /v1/stripe/checkout-session → a synthetic hosted Checkout URL
//   - POST /v1/stripe/portal-session   → a synthetic hosted Portal URL
//   - POST /v1/stripe/seat-quantity    → an applied seat-sync result
//   - POST /v1/credits/ci-overage      → a CI overage debit that LOWERS the org's
//     fixture balance (Story MOTIR-6906 · MOTIR-6913 — so a live CI tick can
//     drive an org to zero the way the real ledger does)
//   - POST/DELETE /v1/orgs/:id/closing  → an organization's billing pauses / resumes
//   - POST /v1/orgs/:id/offboard        → the AI tenant erased to its billing tombstone
//   - POST /v1/orgs/:id/purge-retained  → the retained ledger purged
//     (Story MOTIR-6306 — organization deletion. The shapes are motir-ai's own,
//     recorded in tests/fixtures/motirAiOrgLifecycleContract.ts.)
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

import { readFixtureFileSync, writeFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';
import type { RawBillingHistoryResponse } from '@/lib/ai/types';

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
  /** The operator console's Payment & invoices read (mirrors
   *  RawBillingHistoryResponse). Absent ⇒ no Stripe customer: the empty shape. */
  billingHistory?: RawBillingHistoryResponse;
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
  /**
   * The balance read FAILS (Story MOTIR-6906 · MOTIR-6913). `/v1/usage` answers
   * a 500 problem for this org, which is motir-ai unreachable as motir-core sees
   * it: every surface that reads the balance gets `balance: null` or its own
   * error state, and the fleet's admission defers `balance_unavailable`.
   * Optional, so every existing fixture keeps a readable balance.
   */
  usageUnavailable?: boolean;
  /**
   * The org's AGENT spend this period (Story MOTIR-6914 · MOTIR-6924), as
   * `/v1/usage` reports it in `agentMachine` / `agentStorage`. OPTIONAL, and the
   * omission is meaningful exactly as `search`'s is: absent ⇒ no agent blocks on
   * the wire, the rolling-deploy shape the Agents line renders as UNAVAILABLE.
   * The fixture file is the LEDGER for it — the storage debit below and the
   * hosted-run mock's machine debit both add to it ({@link recordAgentDebit}), so
   * a charge the app server makes is the figure the billing page reads next.
   */
  agents?: { machine: number; storage: number; keys?: string[] };
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
const problemJson = { headers: { 'content-type': 'application/problem+json' } } as const;

/**
 * The `externalRef`s this process has already debited — motir-ai's idempotency
 * on `ci_overage:<ref>`, so a retried charge lowers the balance once. Per
 * process, which is the scope a debit is retried in.
 */
const debitedRefs = new Set<string>();

/**
 * Lower one org's fixture balance by `credits`, as the real ledger does, and
 * answer the balance after. The fixture file is the ledger here: the app server
 * and any other process re-read it on their next `/v1/usage`, so a debit made by
 * a live CI tick is the balance the billing page shows next.
 */
function debitFixtureBalance(coreOrganizationId: string, credits: number): number {
  const path = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  const fixture = readFixture();
  const entry = fixture[coreOrganizationId] ?? { ...FREE_DEFAULT };
  const balanceAfter = entry.balance - credits;
  if (path) {
    fixture[coreOrganizationId] = { ...entry, balance: balanceAfter };
    writeFixtureFileSync(path, JSON.stringify(fixture));
  }
  return balanceAfter;
}

/**
 * Record one agent debit on an org's fixture ledger (MOTIR-6924): the credits
 * land in `agents.machine` or `agents.storage` and come off the balance, as the
 * real ledger's `agent_machine` / `agent_storage` kinds do. Idempotent on `key`,
 * as motir-ai is (`agent-storage:<instance>:<day>`, the interval's reference).
 * Answers whether this call was the one that recorded it.
 */
export function recordAgentDebit(
  coreOrganizationId: string,
  kind: 'machine' | 'storage',
  credits: number,
  key: string,
): boolean {
  const path = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  if (!path) return true;
  const fixture = readFixture();
  const entry = fixture[coreOrganizationId] ?? { ...FREE_DEFAULT };
  const agents = entry.agents ?? { machine: 0, storage: 0 };
  const keys = agents.keys ?? [];
  if (keys.includes(key)) return false;
  fixture[coreOrganizationId] = {
    ...entry,
    balance: entry.balance - credits,
    agents: { ...agents, [kind]: agents[kind] + credits, keys: [...keys, key] },
  };
  writeFixtureFileSync(path, JSON.stringify(fixture));
  return true;
}

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
    .reply<object>((req) => {
      const orgId = queryOrgId(req.path);
      const e = entryFor(orgId);
      if (e.usageUnavailable) {
        return {
          statusCode: 500,
          data: {
            type: 'about:blank',
            code: 'internal_error',
            title: 'Internal error',
            status: 500,
            detail: 'the credit ledger could not be read (E2E fixture)',
          },
          responseOptions: problemJson,
        };
      }
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
          // The same rule for the Agents line (MOTIR-6924): absent stays absent.
          ...(e.agents
            ? {
                agentMachine: { totalSpend: e.agents.machine, monthSpend: e.agents.machine },
                agentStorage: { totalSpend: e.agents.storage, monthSpend: e.agents.storage },
              }
            : {}),
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

  // GET /v1/stripe/billing-history — the org's payment method + recent invoices
  // (MOTIR-7304). EMPTY (no Stripe customer) unless the fixture names one.
  pool
    .intercept({ path: (p) => p.startsWith('/v1/stripe/billing-history'), method: 'GET' })
    .reply((req) => {
      const e = entryFor(queryOrgId(req.path));
      return {
        statusCode: 200,
        data: e.billingHistory ?? { paymentMethod: null, invoices: [] },
        responseOptions: json,
      };
    })
    .persist();

  // POST /v1/credits/agent-storage — one agent's storage for one UTC day, the
  // `agent_storage` kind (Story MOTIR-6914 · MOTIR-6919, driven by MOTIR-6924's
  // walk). Keyed on the instance and the day, as motir-ai builds it.
  pool
    .intercept({ path: '/v1/credits/agent-storage', method: 'POST' })
    .reply((req) => {
      const body = JSON.parse(String(req.body ?? '{}')) as {
        coreOrganizationId?: string;
        instanceId?: string;
        day?: string;
        credits?: number;
      };
      const org = body.coreOrganizationId ?? '';
      const fresh = recordAgentDebit(
        org,
        'storage',
        body.credits ?? 0,
        `agent-storage:${body.instanceId}:${body.day}`,
      );
      return {
        statusCode: 200,
        data: { idempotent: !fresh, balanceCredits: entryFor(org).balance },
        responseOptions: json,
      };
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

  // POST /v1/credits/ci-overage — the CI overage debit (MOTIR-1899's endpoint),
  // which a live CI tick reaches once an org is past its included minutes
  // (Story MOTIR-6906 · MOTIR-6910). It LOWERS the fixture balance rather than
  // answering a fixed one, because the story under test is an org driven to zero
  // by its own running containers — a debit that moved nothing could never get
  // there. Idempotent on `externalRef`, as motir-ai is.
  pool
    .intercept({ path: '/v1/credits/ci-overage', method: 'POST' })
    .reply((req) => {
      const body = JSON.parse(String(req.body ?? '{}')) as {
        coreOrganizationId?: string;
        credits?: number;
        externalRef?: string;
      };
      const orgId = String(body.coreOrganizationId ?? '');
      const credits = Number(body.credits ?? 0);
      const ref = String(body.externalRef ?? '');
      const idempotent = debitedRefs.has(ref);
      let balanceAfter: number;
      if (idempotent) {
        balanceAfter = entryFor(orgId).balance;
      } else {
        debitedRefs.add(ref);
        balanceAfter = debitFixtureBalance(orgId, credits);
      }
      return {
        statusCode: 200,
        data: {
          transactionId: `e2e_ci_overage_${debitedRefs.size}`,
          aiOrganizationId: `e2e_ai_${orgId}`,
          credits: -credits,
          balanceAfter,
          exhausted: balanceAfter <= 0,
          idempotent,
        },
        responseOptions: json,
      };
    })
    .persist();

  // The organization-deletion lifecycle (Story MOTIR-6306): scheduling pauses the
  // org's billing, a cancel resumes it, the erasure sweep offboards the AI tenant
  // and the seven-year purge removes its ledger. Every route is idempotent in
  // motir-ai and answers 200, so the boundary answers the success shape.
  const orgRoute = (suffix: string) => (p: string) =>
    new RegExp(`^/v1/orgs/[^/?]+/${suffix}$`).test(p.split('?')[0]!);
  pool
    .intercept({ path: orgRoute('closing'), method: 'POST' })
    .reply(200, { changed: true, closing: true }, json)
    .persist();
  pool
    .intercept({ path: orgRoute('closing'), method: 'DELETE' })
    .reply(200, { changed: true, closing: false }, json)
    .persist();
  pool
    .intercept({ path: orgRoute('offboard'), method: 'POST' })
    .reply(
      200,
      {
        erased: true,
        subscriptionsCancelled: 0,
        codeGraph: {
          snapshotObjectsDeleted: 0,
          localRootRemoved: false,
          coordinationRowsDeleted: 0,
        },
        projectsDeleted: 0,
        indexAllowanceRowsDeleted: 0,
        indexRunVerdictsDeleted: 0,
        agentRunsDeleted: 0,
      },
      json,
    )
    .persist();
  pool
    .intercept({ path: orgRoute('purge-retained'), method: 'POST' })
    .reply(200, { purged: true }, json)
    .persist();
}
