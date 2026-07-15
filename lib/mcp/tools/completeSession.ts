import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CompleteSessionResultDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  buildImplementationProvenance,
  implementationProvenanceFields,
  sessionBranchField,
} from './workItemRef';

// `complete_session` (Story 7.8 · Subtask 7.8.11) — close out a session branch
// after a human merges its PR. Every work item recorded on the branch (across
// the caller's accessible projects in the workspace) is transitioned to `done`
// and its `session_branch` cleared, in ONE transaction. A thin adapter over
// `workItemsService.completeSession`: it surfaces a per-item outcome
// (completed / already_done / failed) so a partial failure (an item whose
// workflow has no legal path to done) is visible without rolling back the items
// that DID complete. No business logic here.

export const COMPLETE_SESSION_TOOL_NAME = 'complete_session';

const inputSchema = {
  sessionBranch: sessionBranchField,
  // Optional self-reported implementation provenance (MOTIR-1685) — applied to
  // EVERY item closed on the branch (the run reporting its harness/model at
  // merge). `source` defaults to `byok`; omitted → the items' provenance is left
  // as their `mark_integrated` report / manual-lane stamp.
  ...implementationProvenanceFields,
};

/** Compact human-readable summary of the bulk close-out. */
function summarize(result: CompleteSessionResultDto): string {
  const counts = { completed: 0, already_done: 0, failed: 0 };
  for (const r of result.results) counts[r.outcome]++;
  if (result.results.length === 0) {
    return `No work items are recorded on "${result.sessionBranch}".`;
  }
  const failed = result.results.filter((r) => r.outcome === 'failed');
  const head =
    `Completed session "${result.sessionBranch}": ${counts.completed} done` +
    (counts.already_done ? `, ${counts.already_done} already done` : '') +
    (counts.failed ? `, ${counts.failed} failed` : '') +
    '.';
  const detail = failed.length
    ? '\n' + failed.map((r) => `  • ${r.key}: ${r.reason ?? 'failed'}`).join('\n')
    : '';
  return head + detail;
}

/** The adapter: bulk-complete every item on the branch. */
export async function runCompleteSession(
  args: {
    sessionBranch: string;
    implementationSource?: 'byok' | 'manual';
    implementationHarness?: string;
    implementationModel?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await workItemsService.completeSession(
      args.sessionBranch,
      ctx,
      buildImplementationProvenance(args),
    );
    return toolOk(summarize(result), result as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCompleteSession(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    COMPLETE_SESSION_TOOL_NAME,
    {
      title: 'Complete session',
      description:
        'Close out a session branch after its PR is merged: every work item recorded on the ' +
        'branch moves to "Done" and its recorded branch is cleared. Optionally self-report the ' +
        'implementation harness + model (source defaults to "byok") to stamp how every closed ' +
        'item was built. Returns a per-item outcome (completed / already done / failed). Honors ' +
        'the workflow rules and the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runCompleteSession(args, resolveContext(extra)),
  );
}
