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
  // Balance + tier are ALWAYS org-level (one ledger per org).
  balance: number;
  tier: UsageTierDTO | null;
  // Spend + breakdown + runs follow the active scope.
  totalSpend: number;
  monthSpend: number;
  monthlyHistory: { yearMonth: string; credits: number }[];
  perModel: UsageModelDTO[];
  recentRuns: { runs: UsageRunDTO[]; page: number; pageSize: number; total: number };
  // True once the scope has any recorded usage — drives the empty state.
  hasUsage: boolean;
}
