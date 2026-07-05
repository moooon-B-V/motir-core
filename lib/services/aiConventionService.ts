import {
  getCodeAudit,
  getConvention,
  editConvention,
  approveConvention,
  type RawConvention,
  type RawConventionSurface,
  type RawCodeAuditSurface,
} from '@/lib/ai/motirAiClient';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type {
  CodingConventionDTO,
  ConventionSurfaceDTO,
  CodeAuditSurfaceDTO,
  CodeAuditFindingDTO,
  CodeHealthSummaryDTO,
} from '@/lib/dto/codeHealth';

// The Code-health surface service (Subtask 7.14.5 / MOTIR-926). The ONLY thing the
// /code-health page + its API routes call — it is the 4-layer seam between the app
// and the motir-ai store: it (1) GATES on the 6.4 project-admin permission (approving
// the standard that drives every dispatched prompt is a manager action; a non-admin
// is 403, a cross-tenant project 404 — both from projectAccessService), then (2)
// reaches the store ONLY over the 7.1 boundary via the motirAiClient leaf (never a DB
// reach — the open-core invariant), and (3) maps the raw boundary shapes to the
// browser-facing DTOs (stripping the internal aiProjectId). A MotirAiError propagates
// for the route to map to the surface's error state. Mirrors aiUsageService.

// The audit-findings page size the UI requests (the CodeScene-style list is bounded +
// virtualized; more stream in by offset as it scrolls — the scale rule, 7.14.1).
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
    proposed: raw.proposed ? toConventionDTO(raw.proposed) : null,
    standard: raw.standard ? toConventionDTO(raw.standard) : null,
    versions: (raw.versions ?? []).map(toConventionDTO),
    nextCursor: raw.nextCursor,
  };
}

// The health summary crosses the boundary as `unknown` (the audit job owns its
// shape). Read it defensively into the typed DTO — a missing field simply doesn't
// render, never throws.
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

function toCodeAuditSurfaceDTO(raw: RawCodeAuditSurface): CodeAuditSurfaceDTO {
  return {
    audit: raw.audit
      ? {
          id: raw.audit.id,
          healthSummary: toHealthSummary(raw.audit.healthSummary),
          codeGraphRef: raw.audit.codeGraphRef,
          createdAt: raw.audit.createdAt,
        }
      : null,
    findings: (raw.findings ?? []).map(toFindingDTO),
    total: raw.total,
    nextOffset: raw.nextOffset,
  };
}

export const aiConventionService = {
  // The latest code-health audit summary + a page of findings. `findingsOffset`
  // pages the (bounded, virtualized) list as it scrolls.
  async getAudit(
    projectId: string,
    ctx: AccessActorContext,
    opts: { findingsOffset?: number } = {},
  ): Promise<CodeAuditSurfaceDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await getCodeAudit({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      findingsOffset: opts.findingsOffset,
      findingsLimit: FINDINGS_PAGE_SIZE,
    });
    return toCodeAuditSurfaceDTO(raw);
  },

  // The proposed + standard convention (with provenance) + version history.
  async getConvention(
    projectId: string,
    ctx: AccessActorContext,
    opts: { versionsCursor?: string } = {},
  ): Promise<ConventionSurfaceDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await getConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      versionsCursor: opts.versionsCursor,
    });
    return toConventionSurfaceDTO(raw);
  },

  // Edit a proposed draft's contentMd before approval (curate the AI draft). The
  // approving/editing user is the gated session actor.
  async editConvention(
    projectId: string,
    ctx: AccessActorContext,
    conventionId: string,
    contentMd: string,
  ): Promise<CodingConventionDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await editConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      conventionId,
      contentMd,
      userId: ctx.userId,
    });
    return toConventionDTO(raw);
  },

  // Approve a proposed convention as the project's standard (the deliberate human
  // gate — this is the standard injected into every dispatched prompt).
  async approveConvention(
    projectId: string,
    ctx: AccessActorContext,
    conventionId: string,
  ): Promise<CodingConventionDTO> {
    await projectAccessService.assertCanManage(projectId, ctx);
    const raw = await approveConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      conventionId,
      userId: ctx.userId,
    });
    return toConventionDTO(raw);
  },
};
