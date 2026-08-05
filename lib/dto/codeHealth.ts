// DTOs for the Code-health surface (Story 7.14 / MOTIR-926). motir-core holds no
// AI tables — these are the browser-facing shapes the aiConventionService maps the
// motir-ai boundary responses into, stripping the internal aiProjectId. Dates stay
// ISO strings (they crossed the wire as JSON and the UI only formats them).

export interface ConventionProvenanceDTO {
  ruleId: string;
  category: string;
  // adopted = your code already does this (documented); proposed = your code was
  // silent/inconsistent, a clean-code default to review.
  source: 'adopted' | 'proposed';
}

// One derived convention version. There is NO lifecycle here: MOTIR-1660/1662
// deleted the proposed→standard approve gate, so the fields that encoded it
// (`status`, `approvedByUserId`, `approvedAt`, `editedByUserId`, `editedAt`,
// `supersededByVersion`) are retired — motir-ai stopped sending them and nothing
// on the surface may switch on them (MOTIR-2127).
export interface CodingConventionDTO {
  id: string;
  // The repo this version was derived for (e.g. "acme/web"), off the producer row.
  repoKey: string;
  version: number;
  contentMd: string;
  provenance: ConventionProvenanceDTO[];
  createdAt: string;
}

// Per-repo convention surface (MOTIR-1662 / MOTIR-1663). The convention is now
// scoped to a (project, repo) pair; the page shows one card per connected repo,
// each with its derived convention document (read-only) and a "Refine with Motir"
// entry that opens the universal AI chat launcher.
export interface ConventionSurfaceDTO {
  // The repo this surface was READ for (e.g. "acme/web") — the requested repoKey,
  // which motir-ai does not echo at the surface level. Null only when the caller
  // scoped to no repo and the store returned nothing (the empty/fresh state).
  repoKey: string | null;
  // The latest derived convention for this repo, or null before the first
  // derivation. Always auto-used — there is no proposed→standard gate.
  convention: CodingConventionDTO | null;
  // Version history, newest first.
  versions: CodingConventionDTO[];
  nextCursor: string | null;
}

// A single audit finding. `severity` is an open string from the audit job; the UI
// maps the four known tones (critical/high/medium/low) and falls back to neutral.
export interface CodeAuditFindingDTO {
  ruleId: string;
  category: string;
  severity: string;
  fileRef: string | null;
  symbolRef: string | null;
  why: string | null;
  // The convention rule this finding breaks (lavender ref), or null where the
  // convention is silent and it falls back to the clean-code baseline.
  conventionRuleRef: string | null;
}

// The CodeScene-CodeHealth-style conformance rollup. The audit job owns the exact
// shape (it crosses the boundary as `unknown`); the UI reads what is present.
export interface CodeHealthCategoryDTO {
  category: string;
  label: string;
  status: 'conforms' | 'watch' | 'gap';
  detail?: string;
}

export interface CodeHealthSummaryDTO {
  grade?: string;
  conformancePct?: number;
  score?: number;
  totalFindings?: number;
  conventionVersion?: number;
  byCategory?: CodeHealthCategoryDTO[];
}

// ── §10.3 external-scanner state (MOTIR-1591 producer → MOTIR-1610 read-back) ──
// The state the "Deepen this audit" affordance (MOTIR-1592) gates on. The audit
// report is always complete without a scanner (§10.2 zero-setup); this only says
// whether an EXTERNAL scanner was detected/ingested and, when none was, the
// best-fit suggestion to deepen it.
export type ExternalScannerSource =
  | 'github_code_scanning'
  | 'sonarqube_config'
  | 'ci_scan_workflow'
  | 'eslint_config';

export interface IngestedScannerFindingsDTO {
  source: 'github_code_scanning';
  analyses: number;
  tools: string[];
  findingCount: number;
}

export interface ExternalScannerStateDTO {
  detected: ExternalScannerSource[];
  ingested: IngestedScannerFindingsDTO | null;
  // True exactly when NO external scanner source was detected — the ONLY state
  // that shows the "Deepen this audit" card.
  noExternalScanner: boolean;
  // Best-fit guidance when noExternalScanner: GitHub code scanning / CodeQL is the
  // GH-native default; SonarQube is the ecosystem branch. Null once detected.
  suggestion: 'github_code_scanning' | 'sonarqube' | null;
}

export interface CodeAuditSurfaceDTO {
  audit: {
    id: string;
    healthSummary: CodeHealthSummaryDTO;
    codeGraphRef: string | null;
    // The repo this audit belongs to (MOTIR-1662 per-repo scope).
    repoKey: string | null;
    createdAt: string;
  } | null;
  findings: CodeAuditFindingDTO[];
  total: number;
  nextOffset: number | null;
  // The §10.3 external-scanner state stamped on the latest audit (MOTIR-1610),
  // or null for the empty/fresh surface. Drives the "Deepen this audit" card.
  scanner: ExternalScannerStateDTO | null;
}

// One repo's queued pair (MOTIR-928 · POST /v1/code-context/refresh): a fresh
// code_audit + propose_convention, both scoped to `repoKey`.
export interface ReauditRepoJobsDTO {
  // The repo this pair was queued for (`owner/name`). Null ONLY for the single
  // unscoped pair a project with NO connected repo still submits.
  repoKey: string | null;
  auditJobId: string;
  conventionJobId: string;
}

// The re-audit trigger result. PER REPO since MOTIR-2123: the trigger fans out
// over the connected repo SET — one pair per repo, each carrying its own
// `repoRef` — because both motir-ai handlers derive for ONE repo per job, so a
// single submit left four of MOTIR's five repos with no convention at all. The
// UI uses it only to enter the "re-auditing" state and poll the surface until
// the new audit lands.
export interface ReauditResultDTO {
  repos: ReauditRepoJobsDTO[];
}
