import {
  getCodeAudit,
  getConvention,
  refreshCodeAudit,
  type RawConvention,
  type RawConventionSurface,
  type RawCodeAuditSurface,
  type RawExternalScannerState,
} from '@/lib/ai/motirAiClient';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type {
  CodingConventionDTO,
  ConventionSurfaceDTO,
  CodeAuditSurfaceDTO,
  CodeAuditFindingDTO,
  CodeHealthSummaryDTO,
  ExternalScannerStateDTO,
  ExternalScannerSource,
  ReauditResultDTO,
} from '@/lib/dto/codeHealth';

// The Code-health surface service (Subtask 7.14.5 / MOTIR-926, amended by
// MOTIR-1663). The ONLY thing the /code-health page + its API routes call — it
// (1) GATES on the 6.4 project-admin permission, then (2) reaches the store
// ONLY over the 7.1 boundary via the motirAiClient leaf, and (3) maps the raw
// boundary shapes to the browser-facing DTOs. The approve/edit write path is
// removed (MOTIR-1660/1663: the convention is derived + auto-used, read-only
// with refine-via-universal-chat). Per-repo scope per MOTIR-1662.

const FINDINGS_PAGE_SIZE = 100;

function toProvenance(raw: RawConvention['provenance']): CodingConventionDTO['provenance'] {
  return (raw ?? []).map((p) => ({ ruleId: p.ruleId, category: p.category, source: p.source }));
}

function toConventionDTO(raw: RawConvention): CodingConventionDTO {
  return {
    id: raw.id,
    status: raw.status,
    version: raw.version,
    contentMd: raw.contentMd,
    provenance: toProvenance(raw.provenance),
    approvedByUserId: raw.approvedByUserId,
    approvedAt: raw.approvedAt,
    editedByUserId: raw.editedByUserId,
    editedAt: raw.editedAt,
    supersededByVersion: raw.supersededByVersion,
    createdAt: raw.createdAt,
  };
}

function toConventionSurfaceDTO(raw: RawConventionSurface): ConventionSurfaceDTO {
  return {
    repoKey: raw.repoKey ?? null,
    proposed: raw.proposed ? toConventionDTO(raw.proposed) : null,
    standard: raw.standard ? toConventionDTO(raw.standard) : null,
    versions: (raw.versions ?? []).map(toConventionDTO),
    nextCursor: raw.nextCursor,
  };
}

function toHealthSummary(raw: unknown): CodeHealthSummaryDTO {
  const s = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const statusOf = (v: unknown): 'conforms' | 'watch' | 'gap' =>
    v === 'watch' || v === 'gap' ? v : 'conforms';
  const byCategory = Array.isArray(s['byCategory'])
    ? (s['byCategory'] as Record<string, unknown>[]).map((c) => ({
        category: String(c['category'] ?? ''),
        label: String(c['label'] ?? c['category'] ?? ''),
        status: statusOf(c['status']),
        detail: str(c['detail']),
      }))
    : undefined;
  return {
    grade: str(s['grade']),
    conformancePct: num(s['conformancePct']),
    score: num(s['score']),
    totalFindings: num(s['totalFindings']),
    conventionVersion: num(s['conventionVersion']),
    byCategory,
  };
}

function toFindingDTO(raw: unknown): CodeAuditFindingDTO {
  const f = (raw ?? {}) as Record<string, unknown>;
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    ruleId: String(f['ruleId'] ?? ''),
    category: String(f['category'] ?? ''),
    severity: String(f['severity'] ?? 'low'),
    fileRef: strOrNull(f['fileRef']),
    symbolRef: strOrNull(f['symbolRef']),
    why: strOrNull(f['why']),
    conventionRuleRef: strOrNull(f['conventionRuleRef']),
  };
}

const SCANNER_SOURCES: ExternalScannerSource[] = [
  'github_code_scanning',
  'sonarqube_config',
  'ci_scan_workflow',
  'eslint_config',
];

function toScannerState(
  raw: RawExternalScannerState | null | undefined,
): ExternalScannerStateDTO | null {
  if (!raw || typeof raw !== 'object') return null;
  const detected = Array.isArray(raw.detected)
    ? raw.detected.filter((s): s is ExternalScannerSource =>
        SCANNER_SOURCES.includes(s as ExternalScannerSource),
      )
    : [];
  const suggestion =
    raw.suggestion === 'github_code_scanning' || raw.suggestion === 'sonarqube'
      ? raw.suggestion
      : null;
  const ingested =
    raw.ingested && raw.ingested.source === 'github_code_scanning'
      ? {
          source: 'github_code_scanning' as const,
          analyses: Number(raw.ingested.analyses) || 0,
          tools: Array.isArray(raw.ingested.tools) ? raw.ingested.tools.map(String) : [],
          findingCount: Number(raw.ingested.findingCount) || 0,
        }
      : null;
  return {
    detected,
    ingested,
    noExternalScanner: raw.noExternalScanner === true,
    suggestion,
  };
}

function toCodeAuditSurfaceDTO(raw: RawCodeAuditSurface): CodeAuditSurfaceDTO {
  return {
    audit: raw.audit
      ? {
          id: raw.audit.id,
          healthSummary: toHealthSummary(raw.audit.healthSummary),
          codeGraphRef: raw.audit.codeGraphRef,
          repoKey: raw.audit.repoKey ?? null,
          createdAt: raw.audit.createdAt,
        }
      : null,
    findings: (raw.findings ?? []).map(toFindingDTO),
    total: raw.total,
    nextOffset: raw.nextOffset,
    scanner: toScannerState(raw.scanner),
  };
}

export const aiConventionService = {
  // The latest code-health audit summary + a page of findings. `findingsOffset`
  // pages the (bounded, virtualized) list as it scrolls; `repoKey` scopes to a
  // single repo (MOTIR-1662 per-repo scope).
  async getAudit(
    projectId: string,
    ctx: AccessActorContext,
    opts: { repoKey?: string; findingsOffset?: number } = {},
  ): Promise<CodeAuditSurfaceDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await getCodeAudit({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      findingsOffset: opts.findingsOffset,
      findingsLimit: FINDINGS_PAGE_SIZE,
    });
    return toCodeAuditSurfaceDTO(raw);
  },

  // The per-repo convention (derived, auto-used — read-only; MOTIR-1660/1662).
  // Pass `repoKey` to scope to a single repo; omit for the first repo or the
  // empty surface for a project with no connected repo.
  async getConvention(
    projectId: string,
    ctx: AccessActorContext,
    opts: { repoKey?: string; versionsCursor?: string } = {},
  ): Promise<ConventionSurfaceDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await getConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      versionsCursor: opts.versionsCursor,
    });
    return toConventionSurfaceDTO(raw);
  },

  // Trigger a re-audit + re-propose for the project (the "Deepen this audit" →
  // "Re-audit now" action, MOTIR-1592 over the MOTIR-928 refresh seam).
  async reaudit(
    projectId: string,
    ctx: AccessActorContext,
    projectKey: string,
  ): Promise<ReauditResultDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const { auditJobId, conventionJobId } = await refreshCodeAudit(
      {
        organizationId,
        isMeta,
        workspaceId: ctx.workspaceId,
        projectId,
        projectKey,
      },
      { code: code ?? {} },
      { userId: ctx.userId },
    );
    return { auditJobId, conventionJobId };
  },
};
