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
import { EmptyRepoScopeError, UnknownRepoScopeError } from '@/lib/codeHealth/errors';
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
  ReauditRepoJobsDTO,
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
    repoKey: raw.repoKey,
    version: raw.version,
    contentMd: raw.contentMd,
    provenance: toProvenance(raw.provenance),
    createdAt: raw.createdAt,
  };
}

// Map motir-ai's `{ convention, versions, nextCursor }` body (MOTIR-2127). The
// surface-level `repoKey` comes from the REQUESTED repoKey — motir-ai does not
// echo it at the surface level, only on each row — falling back to the row's own
// repoKey so a caller that scoped to no repo still labels the card correctly.
function toConventionSurfaceDTO(
  raw: RawConventionSurface,
  requestedRepoKey: string | undefined,
): ConventionSurfaceDTO {
  const versions = (raw.versions ?? []).map(toConventionDTO);
  const convention = raw.convention ? toConventionDTO(raw.convention) : null;
  return {
    repoKey: requestedRepoKey ?? convention?.repoKey ?? versions[0]?.repoKey ?? null,
    convention,
    versions,
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

// Resolve the repos a `reaudit` submits for, from the project's CONNECTED set and
// the caller's optional scope. Validation happens here — in the same step that
// resolves the connected set — so an invalid scope can never reach a submit.
function resolveReauditTargets(
  connectedRepoRefs: string[],
  scope: string[] | undefined,
): (string | null)[] {
  // No scope: the shipped whole-set fan-out. A project with no connected repo
  // still sends exactly one unscoped pair.
  if (scope === undefined) {
    return connectedRepoRefs.length > 0 ? connectedRepoRefs : [null];
  }
  if (scope.length === 0) throw new EmptyRepoScopeError();

  const connected = new Set(connectedRepoRefs);
  const unknown = scope.filter((repoKey) => !connected.has(repoKey));
  if (unknown.length > 0) throw new UnknownRepoScopeError([...new Set(unknown)]);

  // Preserve the caller's order; collapse repeats.
  return [...new Set(scope)];
}

export const aiConventionService = {
  // The latest code-health audit summary + a page of findings. `findingsOffset`
  // pages the (bounded, virtualized) list as it scrolls; `repoKey` scopes to a
  // single repo (MOTIR-1662 per-repo scope).
  //
  // `findingsLimit` overrides the page size for a SUMMARY read (MOTIR-2207 ·
  // Panel 7 §3). The multi-repo list needs `healthSummary` + `total` for every
  // connected repo and `findings` for only the selected one, so reading N
  // surfaces at the full page size would ship N × 100 findings to draw an N-row
  // list. This is a passthrough, not a boundary change: `GET /v1/code-audit`
  // already accepts the param and `motirAiClient.getCodeAudit` already forwards
  // it. Note motir-ai's `parsePositiveInt` REJECTS `0`, so the cheapest legal
  // summary read is `1` — see SUMMARY_FINDINGS_LIMIT at the page.
  async getAudit(
    projectId: string,
    ctx: AccessActorContext,
    opts: { repoKey?: string; findingsOffset?: number; findingsLimit?: number } = {},
  ): Promise<CodeAuditSurfaceDTO> {
    // `ai:configure`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2362).
    // The inventory mapped the four coding-convention operations to `ai:plan`,
    // which the decision record puts at `member` — applying that mapping would
    // have WIDENED admin-only operations to every member, in a story where every
    // other row narrows. `docs/decisions/member-facing-permissions.md` §4 resolves
    // it as a MAPPING fix: re-running a convention audit is AI CONFIGURATION
    // wearing a usage-shaped URL, the same class as the AI settings MOTIR-2300
    // already put behind `ai:configure`. `assertCanManage` was
    // `assertPermission(…, 'project:administer')` and `admin` holds
    // `ai:configure`, so NO actor's answer changes.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');
    const raw = await getCodeAudit({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      findingsOffset: opts.findingsOffset,
      findingsLimit: opts.findingsLimit ?? FINDINGS_PAGE_SIZE,
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
    // `ai:configure`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2362).
    // The inventory mapped the four coding-convention operations to `ai:plan`,
    // which the decision record puts at `member` — applying that mapping would
    // have WIDENED admin-only operations to every member, in a story where every
    // other row narrows. `docs/decisions/member-facing-permissions.md` §4 resolves
    // it as a MAPPING fix: re-running a convention audit is AI CONFIGURATION
    // wearing a usage-shaped URL, the same class as the AI settings MOTIR-2300
    // already put behind `ai:configure`. `assertCanManage` was
    // `assertPermission(…, 'project:administer')` and `admin` holds
    // `ai:configure`, so NO actor's answer changes.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');
    const raw = await getConvention({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: projectId,
      repoKey: opts.repoKey,
      versionsCursor: opts.versionsCursor,
    });
    return toConventionSurfaceDTO(raw, opts.repoKey);
  },

  // Trigger a re-audit + re-propose for the project (the "Deepen this audit" →
  // "Re-audit now" action, MOTIR-1592 over the MOTIR-928 refresh seam).
  //
  // FANS OUT over the connected repo SET (MOTIR-2123). One submit derives ONE
  // repo: motir-ai's `parseCodeAuditInput` resolves `repoRef ?? repos[0]` ("an
  // audit targets ONE repo") and `proposeConvention` records that same key, so a
  // single call left every repo but the alphabetically-first one with no
  // convention. Both jobs must fan out TOGETHER — `resolveSourceAuditId` reads
  // the audit for the SAME (project, repo), so a convention derived for a repo
  // with no audit of its own would link `sourceAuditId: null`.
  //
  // The per-repo scope rides the EXISTING envelope: `repoRef` is authoritative
  // over `repos[]` on the far side, so the repo set stays on `context.code`
  // beside it and no boundary change is needed. A project with NO connected repo
  // still submits exactly one unscoped pair — unchanged from before the fan-out.
  //
  // `opts.repoKeys` SCOPES the fan-out to an explicit target set (MOTIR-2247), so
  // deriving one repo's report no longer costs every repo's. Semantics:
  //
  //   undefined  → the shipped whole-set behaviour, byte for byte (including the
  //                single unscoped pair a project with no connected repo sends).
  //   []         → EmptyRepoScopeError. NOT "derive nothing": a client that
  //                computes zero targets must fail loudly, not look successful.
  //   [a, b]     → exactly those, VALIDATED against the connected set first.
  //                An unknown key raises before ANY submit, so a request mixing
  //                valid and invalid members queues nothing (no partial fan-out).
  //
  // Duplicates collapse to one pair — "one pair per NAMED repo" — since a repeated
  // key would spend a second derivation on a repo already being derived.
  async reaudit(
    projectId: string,
    ctx: AccessActorContext,
    projectKey: string,
    opts: { repoKeys?: string[] } = {},
  ): Promise<ReauditResultDTO> {
    // `ai:configure`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2362).
    // The inventory mapped the four coding-convention operations to `ai:plan`,
    // which the decision record puts at `member` — applying that mapping would
    // have WIDENED admin-only operations to every member, in a story where every
    // other row narrows. `docs/decisions/member-facing-permissions.md` §4 resolves
    // it as a MAPPING fix: re-running a convention audit is AI CONFIGURATION
    // wearing a usage-shaped URL, the same class as the AI settings MOTIR-2300
    // already put behind `ai:configure`. `assertCanManage` was
    // `assertPermission(…, 'project:administer')` and `admin` holds
    // `ai:configure`, so NO actor's answer changes.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');
    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    const tenant = {
      organizationId,
      isMeta,
      internalBilling,
      workspaceId: ctx.workspaceId,
      projectId,
      projectKey,
    };
    const repoRefs = code?.repos.map((repo) => repo.repoRef) ?? [];
    const targets: (string | null)[] = resolveReauditTargets(repoRefs, opts.repoKeys);

    const repos: ReauditRepoJobsDTO[] = [];
    for (const repoKey of targets) {
      const { auditJobId, conventionJobId } = await refreshCodeAudit(
        tenant,
        { code: repoKey === null ? (code ?? {}) : { ...code, repoRef: repoKey } },
        { userId: ctx.userId },
      );
      repos.push({ repoKey, auditJobId, conventionJobId });
    }
    return { repos };
  },
};
