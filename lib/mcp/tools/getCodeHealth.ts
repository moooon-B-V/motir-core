import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PlanningCodeHealthDTO, PlanningCodeHealthRepoDTO } from '@/lib/dto/codeHealth';
import { aiConventionService } from '@/lib/services/aiConventionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `get_code_health` (Story MOTIR-7782 · Subtask MOTIR-7793) — the CODE-HEALTH
// read a planning agent needs, in one call per project: each repository in the
// project's set with its index state, its latest audit's health summary and its
// current derived coding convention.
//
// The hosted planner already reads exactly this for every planning session it
// runs (motir-ai `code_health` over the convention + audit stores). Until this
// tool, an agent planning over the MCP could not reach any of it — the three
// shipped reads answered only a browser session on the active project — so the
// two planners planned from different evidence.
//
// A thin adapter over `aiConventionService.getPlanningCodeHealth`: no business
// logic here and no Prisma. The service resolves the key inside the token's
// workspace (another tenant's key is a plain not-found), asserts `ai:plan` — the
// same key `TOOL_PERMISSIONS` checks at the door — and degrades a failed boundary
// read to that ONE section's `unavailable` state rather than failing the call.
//
// READ-ONLY: no re-audit, no refresh, no model job. Those stay on the
// `/code-health` page behind `ai:configure`.

export const GET_CODE_HEALTH_TOOL_NAME = 'get_code_health';

const inputSchema = {
  projectKey: projectKeyField,
};

function auditLine(audit: PlanningCodeHealthRepoDTO['audit']): string {
  if (audit.state === 'absent') return 'audit: none yet';
  if (audit.state === 'unavailable') return `audit: unavailable (${audit.code})`;
  const s = audit.healthSummary;
  if (s.notMeasured) return 'audit: not measured (no code graph)';
  const parts = [
    s.grade !== undefined ? `grade ${s.grade}` : null,
    s.conformancePct !== undefined ? `${s.conformancePct}% conformance` : null,
    s.totalFindings !== undefined ? `${s.totalFindings} findings` : null,
  ].filter((p): p is string => p !== null);
  return `audit: ${parts.length > 0 ? parts.join(', ') : 'present'}`;
}

function conventionLine(convention: PlanningCodeHealthRepoDTO['convention']): string {
  if (convention.state === 'absent') return 'convention: none derived yet';
  if (convention.state === 'unavailable') return `convention: unavailable (${convention.code})`;
  return `convention: v${convention.convention.version}`;
}

/** Compact human summary — the project, then one line per repository. */
export function summarizeCodeHealth(health: PlanningCodeHealthDTO): string {
  const head = `${health.project.key} — ${health.project.name}`;
  if (health.repos.length === 0) {
    return `${head}\nNo repositories in this project's set — there is no code health to report.`;
  }
  const lines = health.repos.map((repo) => {
    const index =
      `index ${repo.indexState}` +
      (repo.commitsBehind !== null ? ` (${repo.commitsBehind} behind)` : '') +
      (repo.refreshFailing ? ' · refresh failing' : '');
    return `- ${repo.repoRef} · ${index} · ${auditLine(repo.audit)} · ${conventionLine(repo.convention)}`;
  });
  return [head, ...lines].join('\n');
}

/** The adapter: resolve the project by key, then report its repositories' code health. */
export async function runGetCodeHealth(
  args: { projectKey: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const health = await aiConventionService.getPlanningCodeHealth(
      args.projectKey.trim().toUpperCase(),
      ctx,
    );
    // Dual content: the summary for a human watching, the whole DTO for the
    // agent — spread, so a caller reads `structuredContent.repos` directly.
    return toolOk(summarizeCodeHealth(health), exempt('get_code_health', { ...health }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetCodeHealth(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_CODE_HEALTH_TOOL_NAME,
    {
      title: 'Get code health',
      description:
        "The PLANNING read of a project's code health — what the hosted planner reads for every " +
        'planning session, in one call. Returns each repository in the project’s set with its ' +
        'code-graph INDEX state (`indexState`, `indexedAt`, `commitsBehind`, `refreshFailing`), ' +
        'its latest code-health AUDIT summary, and its current derived CODING CONVENTION. The ' +
        'audit and convention sections each carry a `state`: `present` (the content rides along), ' +
        '`absent` (nothing derived yet — not an error), or `unavailable` (that one read failed, ' +
        'with its `code`; the rest of the answer still stands). No findings page and no ' +
        'convention version history. A project with no repository returns an empty `repos`, not ' +
        'an error. Read-only; gated on the planning permission. The project key resolves inside ' +
        'the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetCodeHealth(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
