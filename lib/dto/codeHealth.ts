// DTOs for the Code-health surface (Story 7.14 / MOTIR-926). motir-core holds no
// AI tables — these are the browser-facing shapes the aiConventionService maps the
// motir-ai boundary responses into, stripping the internal aiProjectId. Dates stay
// ISO strings (they crossed the wire as JSON and the UI only formats them).

export type ConventionStatus = 'proposed' | 'standard' | 'superseded';

export interface ConventionProvenanceDTO {
  ruleId: string;
  category: string;
  // adopted = your code already does this (documented); proposed = your code was
  // silent/inconsistent, a clean-code default to review.
  source: 'adopted' | 'proposed';
}

export interface CodingConventionDTO {
  id: string;
  status: ConventionStatus;
  version: number;
  contentMd: string;
  provenance: ConventionProvenanceDTO[];
  approvedByUserId: string | null;
  approvedAt: string | null;
  editedByUserId: string | null;
  editedAt: string | null;
  supersededByVersion: number | null;
  createdAt: string;
}

export interface ConventionSurfaceDTO {
  // The latest proposed draft awaiting approval (State A), or null.
  proposed: CodingConventionDTO | null;
  // The single active standard (State B), or null before the first approval.
  standard: CodingConventionDTO | null;
  // Version history, newest first (drives the history list + "active standard" mark).
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

export interface CodeAuditSurfaceDTO {
  audit: {
    id: string;
    healthSummary: CodeHealthSummaryDTO;
    codeGraphRef: string | null;
    createdAt: string;
  } | null;
  findings: CodeAuditFindingDTO[];
  total: number;
  nextOffset: number | null;
}
