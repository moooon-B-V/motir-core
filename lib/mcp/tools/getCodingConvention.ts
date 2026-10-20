import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PlanningConventionDTO } from '@/lib/dto/codeHealth';
import { aiConventionService } from '@/lib/services/aiConventionService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `get_coding_convention` (Story MOTIR-9079 · Subtask MOTIR-9083) — ONE
// repository's current coding convention, in full, for an agent that is about to
// write code in it.
//
// A repository's own rules live in its Codebase coding convention, not in a file
// in its checkout. `get_code_health` carries a convention too, but as one line per
// repository inside a planning summary; this is the text itself, so a `motir run`
// prompt can tell the agent to read it here instead of reading CLAUDE.md.
//
// A thin adapter over `aiConventionService.getPlanningConvention`: no repository
// lookup and no Prisma here. The service resolves the key inside the token's
// workspace, asserts `ai:plan` (the key `TOOL_PERMISSIONS` checks at the door, and
// one `CLI_TOKEN_GRANT` already holds), and resolves `repo` against THAT PROJECT's
// set the way `read_file` does.
//
// Every outcome is a NON-error result naming itself in `structuredContent.state`.
// The only error results are the door's: no `ai:plan`, and a project not found.

export const GET_CODING_CONVENTION_TOOL_NAME = 'get_coding_convention';

const inputSchema = {
  projectKey: projectKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository whose convention to read — one in this project’s set, by its bare name ' +
        '("motir-core") or as `owner/name`, case-insensitively. `get_code_health` and ' +
        '`get_project_state` list the set.',
    ),
};

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** What one outcome renders to: the text a model reads, and the structured fields. */
export function renderCodingConvention(result: PlanningConventionDTO): {
  summary: string;
  structured: Record<string, unknown>;
} {
  switch (result.state) {
    case 'repo_not_in_project': {
      const set = result.repoSet.length
        ? result.repoSet.map((r) => `"${r}"`).join(', ')
        : 'none — no repository is connected to it';
      return {
        summary: `The repo "${result.repo}" is not part of this project's repository set — only ${set} can be read.`,
        structured: { state: result.state, repo: result.repo, repoSet: result.repoSet },
      };
    }
    case 'absent':
      return {
        summary: `No convention recorded for ${result.repoRef}. None has been derived or saved yet; follow the repository's own files and the code around the change.`,
        structured: { state: result.state, repoRef: result.repoRef },
      };
    case 'unavailable':
      return {
        summary: `The convention of ${result.repoRef} could not be read right now (${result.code}). This does not mean none is recorded; try again.`,
        structured: { state: result.state, repoRef: result.repoRef, code: result.code },
      };
    case 'present': {
      const c = result.convention;
      const author =
        c.authorKind === 'edited'
          ? `edited by ${result.editedByName ?? 'a team member'} on ${isoDay(c.createdAt)}`
          : 'derived';
      const pending = c.pendingDerivedMd !== null;
      const head = `${result.repoRef} · coding convention v${c.version} · ${author}`;
      return {
        summary: `${head}\n\n${c.contentMd}`,
        structured: {
          state: result.state,
          repoRef: result.repoRef,
          version: c.version,
          authorKind: c.authorKind,
          editedByName: result.editedByName,
          editedByUserId: c.editedByUserId,
          updatedAt: c.createdAt,
          // A newer derived document is parked beside a person's text; the text
          // above is still the one in force.
          pendingDerived: pending,
          contentMd: c.contentMd,
        },
      };
    }
  }
}

/** The adapter: resolve the project by key, then read one repository's convention. */
export async function runGetCodingConvention(
  args: { projectKey: string; repo: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await aiConventionService.getPlanningConvention(
      args.projectKey.trim().toUpperCase(),
      args.repo,
      ctx,
    );
    const { summary, structured } = renderCodingConvention(result);
    return toolOk(summary, exempt('get_coding_convention', structured));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetCodingConvention(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_CODING_CONVENTION_TOOL_NAME,
    {
      title: 'Get coding convention',
      description:
        "ONE repository's current CODING CONVENTION, in full — the rules a change in that " +
        'repository follows, as the team keeps them on the Code page. The text result is headed ' +
        'by the repository, the version and whether it was `derived` from the code or `edited by` ' +
        'a person on a date, then the convention document itself; `structuredContent` carries the ' +
        'same fields plus `contentMd`. A repository with no convention returns `state: absent` — ' +
        'not an error — and one outside the project’s set returns `state: repo_not_in_project` ' +
        'with the set. `pendingDerived: true` means a newer derived document is waiting beside an ' +
        'edited one; the text returned is still the one in force. Read-only; gated on the ' +
        'planning permission. The project key resolves inside the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetCodingConvention(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
