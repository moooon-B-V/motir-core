import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProjectDTO } from '@/lib/dto/projects';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { listProjectsPayload, presentMcpProjectRow } from '../payloads/planning';

// `list_projects` (MOTIR-1879) — the read that lets a client RESOLVE a project
// instead of demanding its key.
//
// Every other project-scoped tool addresses a project by `projectKey`, and until
// now nothing on the MCP surface could tell you what those keys ARE: `whoami`
// returns the user + the token's workspace, not its projects. So a client could
// only PROBE a key the user had already typed (the CLI's `assertProjectAccessible`
// fires `list_ready` at a guessed key and reads the not-found as "no access"),
// and with no `--project` it fell back to prompting for one. This tool closes
// that gap — the enumeration a project picker, a single-project auto-link, or any
// "pick the project for me" behaviour is built on.
//
// A thin adapter over `projectsService.listProjects` — THE SAME read the app
// shell's project switcher calls (`app/(authed)/layout.tsx`), so the access
// checks are the UI's by construction rather than by imitation: workspace
// membership is asserted, then `projectAccessService.filterBrowsable` drops every
// project the actor may not browse (Story 6.4). No business logic here.
//
// Tenancy: the workspace is NOT an input. It comes from `ctx.workspaceId` — the
// binding `apiTokensService.verify` resolved for the presented PAT — so a token
// bound to workspace A structurally cannot enumerate workspace B's projects.
// There is no key to guess and no argument to widen.

export const LIST_PROJECTS_TOOL_NAME = 'list_projects';

/**
 * One project as the tool reports it — the picker projection, not the app's full
 * `ProjectDTO`.
 *
 * `key` is the string every other tool's `projectKey` argument takes (the MCP
 * surface's naming convention: `ReadyItemDto.key` is likewise the identifier),
 * so a client can resolve a project here and pass the value straight on with no
 * field-name translation.
 *
 * Deliberately NOT carried: `createdAt` and any per-project work-item COUNT.
 * `listProjects` is a hot single-row-per-project read whose DTO leaves
 * `createdAt` unloaded (see `lib/dto/projects.ts` — only the details surface
 * loads it), and a count would cost a query per row. Both would trade this
 * read's constant query count for a picker nicety, and the CLI would inherit
 * that as a scale bug.
 */
export interface McpProjectRow {
  /** The project KEY, e.g. `"PROD"` — what `projectKey` elsewhere expects. */
  key: string;
  /** The opaque project id. */
  id: string;
  name: string;
  slug: string;
  /** Browse-access level (Story 6.4 / 6.12) — disambiguates same-named projects. */
  accessLevel: ProjectDTO['accessLevel'];
}

/** Project the app DTO down to the picker row. */
export function toProjectRow(dto: ProjectDTO): McpProjectRow {
  return {
    key: dto.identifier,
    id: dto.id,
    name: dto.name,
    slug: dto.slug,
    accessLevel: dto.accessLevel,
  };
}

/** Compact one-line summary of a project for the dual-content text block. */
export function summarizeProject(row: McpProjectRow): string {
  return `${row.key} — ${row.name} · ${row.accessLevel}`;
}

/** The adapter: enumerate the token workspace's browsable projects. */
export async function runListProjects(ctx: ServiceContext): Promise<CallToolResult> {
  try {
    const projects = await projectsService.listProjects(ctx.workspaceId, ctx.userId);
    const rows = projects.map(toProjectRow);
    // Dual content: the text block for a human, the array under `projects` for
    // the agent (structuredContent must be an object, so the list is wrapped).
    // An empty workspace is an EMPTY LIST, never an error — "you can reach no
    // projects" is a valid answer a picker renders as its empty state.
    const text =
      rows.length === 0
        ? 'No projects in this workspace.'
        : rows.map((row) => summarizeProject(row)).join('\n');
    return toolOk(
      text,
      derived(listProjectsPayload, { projects: projects.map(presentMcpProjectRow) }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerListProjects(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    LIST_PROJECTS_TOOL_NAME,
    {
      title: 'List projects',
      description:
        "List the projects the presented token can reach — each project's key (the " +
        '`projectKey` every other tool takes), id, name, slug, and browse-access level. ' +
        'Takes no arguments: the workspace is the one the token is bound to, so this never ' +
        'reaches another tenant. Use it to RESOLVE a project instead of asking the user to ' +
        'type its key. Honors the same access checks as the UI — a project the caller may ' +
        'not browse does not appear. A workspace with no reachable projects returns an ' +
        'empty list.',
      inputSchema: {},
    },
    // `resolveContext` is inside the try (the `whoami` pattern, the nearest
    // no-input sibling) so a gate misconfiguration surfaces as a clean
    // MCP_MISSING_CONTEXT tool error rather than an opaque JSON-RPC failure.
    async (_args, extra) => {
      try {
        return await runListProjects(resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
