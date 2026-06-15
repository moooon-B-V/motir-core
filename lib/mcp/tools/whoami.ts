import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { toToolError, toolOk } from '../toolResult';
import type { McpContextResolver } from '../context';

// `whoami` (Story 7.8 seam · added by Subtask 7.9.1) — resolve the identity
// behind the presented PAT: the owning user + the active workspace the bearer
// gate resolved for this request. No input.
//
// Why this tool exists: the CLI (7.9) is an MCP CLIENT only — it has no
// parallel REST path (story-7.9 header). `motir auth login` / `motir auth
// status` must answer "whose token is this?" and the only MCP-native way to do
// that is a tool. It lands HERE (where every agent gets it too), exactly as the
// header prescribes — "if the CLI needs a capability, it lands as an MCP tool
// first, then the CLI consumes it." It reads only the actor's OWN identity from
// the resolved ServiceContext, so there is no cross-user exposure.

export const WHOAMI_TOOL_NAME = 'whoami';

/** Thrown when the resolved actor has no user row — unreachable behind the
 * bearer gate (which resolved the token to a live user), so a loud failure
 * rather than a misleading "ok". */
class WhoamiUserMissingError extends Error {
  readonly code = 'WHOAMI_USER_MISSING' as const;
  constructor() {
    super('The authenticated user could not be resolved.');
    this.name = 'WhoamiUserMissingError';
  }
}

export async function runWhoami(ctx: ServiceContext): Promise<CallToolResult> {
  const user = await usersService.getProfile(ctx.userId);
  if (!user) throw new WhoamiUserMissingError();
  // The workspace the bearer gate resolved as active for this request. A
  // membership the gate already vouched for, so a null here is only the
  // race where it was removed mid-request — degrade gracefully.
  const workspace = await workspacesService.getWorkspaceSummary(ctx.workspaceId, ctx.userId);

  const text = workspace
    ? `${user.name || user.email} <${user.email}> · workspace ${workspace.name} (${workspace.slug})`
    : `${user.name || user.email} <${user.email}>`;
  return toolOk(text, { user, workspace });
}

export function registerWhoami(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    WHOAMI_TOOL_NAME,
    {
      title: 'Who am I',
      description:
        'Resolve the identity behind the presented token: the owning user (id, name, email) ' +
        'and the active workspace. Takes no arguments. Used by the CLI to confirm and display ' +
        'the authenticated account.',
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        return await runWhoami(resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
