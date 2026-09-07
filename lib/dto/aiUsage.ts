import type { UsageScope } from '@/lib/ai/types';

// The org cost dashboard DTO (Subtask 7.2.11) — what the `/api/organizations/
// [orgId]/usage` route returns to the browser. Built by aiUsageService from the
// motir-ai `/v1/usage` rollup (the figures) enriched with motir-core's own
// workspace/project NAMES (motir-ai only knows ids) and the role-aware access
// posture. Credits are an internal usage unit, NOT a currency — never a `$`.

export type { UsageScope };

export interface UsageScopeOption {
  id: string;
  name: string;
}

export interface UsageModelDTO {
  model: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
}

export interface UsageRunDTO {
  jobId: string;
  jobKind: string;
  model: string | null;
  projectId: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  startedAt: string; // ISO
}

/**
 * ORG-LEVEL web-search spend, as its own billed line beside the AI figures.
 *
 * ⚠️ SCOPE-INDEPENDENT, and every consumer must LABEL it as such: it counts every
 * search the org made and does NOT narrow when the drill moves to a workspace or
 * a project. A number that silently ignores the scope selector above it is the
 * surface lying quietly.
 *
 * Wherever this type appears, `null` means UNAVAILABLE — the boundary did not
 * report the block — and is deliberately distinct from a populated object whose
 * figures are `0`. Render them differently: "we could not fetch this" and "you
 * spent nothing" are opposite messages, and only one of them is reassuring.
 */
export interface SearchSpendDTO {
  totalSpend: number;
  monthSpend: number;
}

/** One run's search spend, keyed by the same `jobId` `UsageRunDTO` carries. */
export interface SearchRunDTO {
  jobId: string;
  credits: number;
  lastSearchAt: string; // ISO
}

/**
 * The PER-RUN half of search spend — what answers *where did my credits go*,
 * which the org total does not.
 *
 * ⚠️ TWO SCOPES IN ONE BLOCK, deliberately:
 *
 * - `runs` / `total` FOLLOW the active drill scope, because an attributed search
 *   has a run and a run has a project.
 * - `attributedSpend` / `unattributedSpend` are ORG-LEVEL and all-time, matching
 *   `OrgUsageDTO.search.totalSpend` exactly, so
 *   `attributedSpend + unattributedSpend === search.totalSpend`. The remainder is
 *   a SUBTRACTION over one population rather than a sum of whatever fitted on the
 *   current page — which is what stops it growing as the reader paginates.
 *
 * ⚠️ AND `runs` IS A DIFFERENT POPULATION FROM `recentRuns.runs`, paged
 * independently. A run appears here once it has spent on search — including a
 * search-only run, which `recentRuns` omits because it has no model. So a
 * consumer joining the two on `jobId` gets the search cost for every run in both,
 * and an ABSENT match means *not on this search page*, NEVER *spent nothing*.
 */
export interface SearchRunsDTO {
  runs: SearchRunDTO[];
  page: number;
  pageSize: number;
  total: number;
  attributedSpend: number;
  unattributedSpend: number;
}

export interface UsageTierDTO {
  key: string;
  name: string;
  monthlyCreditAllotment: number;
}

export interface OrgUsageDTO {
  // Role-aware posture (server-decided; never trust a client-sent scope). A
  // non-admin member is `isAdmin: false` and locked to their own project slice.
  access: { isAdmin: boolean };
  // The active drill level + the labelled path (org → workspace → project).
  scope: UsageScope;
  org: { id: string; name: string };
  activeWorkspace: UsageScopeOption | null;
  activeProject: UsageScopeOption | null;
  // The switcher options at the active level: workspaces in the org (admin
  // only), and the projects in the active workspace (admin) or the member's own
  // accessible projects (non-admin).
  drill: { workspaces: UsageScopeOption[]; projects: UsageScopeOption[] };
  // The META org (moooon B.V.) — internal, unlimited, never billed. When true the
  // dashboard shows the balance as "Unlimited" instead of the numeric value (which
  // still debits for internal cost visibility and can drift negative).
  isMeta: boolean;
  // Whether the org is charged exactly like a CUSTOMER and then made whole —
  // every debit lands and is paired, in the same transaction, with an offsetting
  // credit (`Organization.internalBilling`, MOTIR-4565;
  // `docs/decisions/internal-billing-classification.md` §2).
  //
  // ⚠️ IT CHANGES NO FIGURE ON THIS DTO. The balance, the allotment, the
  // per-model breakdown and the run log are computed exactly as they are for a
  // paying org — this field says only WHICH KIND of org the reader is looking
  // at. A second field beside `isMeta` rather than a widening of it, because the
  // two mean opposite things.
  internalBilling: boolean;
  // Balance + tier are ALWAYS org-level (one ledger per org).
  balance: number;
  tier: UsageTierDTO | null;
  // Spend + breakdown + runs follow the active scope.
  totalSpend: number;
  monthSpend: number;
  monthlyHistory: { yearMonth: string; credits: number }[];
  perModel: UsageModelDTO[];
  recentRuns: { runs: UsageRunDTO[]; page: number; pageSize: number; total: number };
  /**
   * Web-search spend — its own figure beside token spend, and the runs that spent
   * it. `null` on BOTH means the boundary did not report the block (a rolling
   * deploy where the motir-ai half has not landed), which the surface renders as
   * UNAVAILABLE — never as zero.
   *
   * `search` is ORG-LEVEL and scope-independent; `searchRuns.runs` follows the
   * drill while its two totals do not. Each type carries the full rule.
   */
  search: SearchSpendDTO | null;
  searchRuns: SearchRunsDTO | null;
  // True once the scope has any recorded usage — drives the empty state.
  //
  // ⚠️ Search spend is deliberately NOT part of this. It is org-level, so folding
  // it in would make a project with no usage of its own report `hasUsage: true`
  // because the ORG once ran a search — the empty state would then never appear
  // at a drill level for any org that has ever searched.
  hasUsage: boolean;
}
