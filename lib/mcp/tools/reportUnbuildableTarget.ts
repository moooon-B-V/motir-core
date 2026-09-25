import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RUN_FOUND_REPORT_REASON_MAX } from '@/lib/dispatchRuns/errors';
import {
  runFoundReportService,
  type ReportUnbuildableTargetInput,
  type RunFoundReportAcknowledgement,
} from '@/lib/services/runFoundReportService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { workItemKeyField } from './workItemRef';
import { projectKeyField } from './readyFilters';

// `report_unbuildable_target` (Story MOTIR-5544 · Subtask MOTIR-6286) — the
// door a DISPATCHED runner calls once when it stops because its target card
// cannot be built. The accepted record is
// `docs/decisions/run-found-trigger-dispatched-path.md`, *(a) The actor*.
//
// This is a TRANSPORT over ONE service call,
// `runFoundReportService.reportUnbuildableTarget`, which owns every arm (the
// open leg, the verdict, the approving plan's author, the filing and its lock).
// Nothing here decides, reads or files anything of its own.
//
// ⚠️ THE ANSWER IS AN ACKNOWLEDGEMENT, AND IT SAYS THE SAME THING ON EVERY ARM.
// `structuredContent` is the service's frozen `{ acknowledged, recordedOnRun }`
// copied key for key, and the text is one fixed sentence per value of
// `recordedOnRun` — so whether a bug was filed, and what the server concluded
// about the plan, never reaches the runner through the content or its shape
// (*"what the gate protects never reaches the caller"*).
//
// ⚠️ `work_item:edit`, which `CLI_TOKEN_GRANT` ALREADY holds — the grant is not
// widened. The runner is the only caller, and it holds exactly that grant.
//
// The `reason` bound (1–4000 once trimmed) is the SERVICE's, not the schema's:
// a schema-level refusal would reach the runner as a generic input-validation
// error, where the service's `RUN_FOUND_REPORT_REASON_INVALID` names the fix.

export const REPORT_UNBUILDABLE_TARGET_TOOL_NAME = 'report_unbuildable_target';

const inputSchema = {
  projectKey: projectKeyField,
  targetKey: workItemKeyField.describe(
    'The card you stopped on — the one you were dispatched to build (e.g. "ACME-7"). ' +
      'Case-insensitive.',
  ),
  reason: z
    .string()
    .describe(
      `Why the card cannot be built — the SAME text as the comment you left on it (1–` +
        `${RUN_FOUND_REPORT_REASON_MAX} characters once trimmed). Describe what is wrong with ` +
        'the CARD.',
    ),
};

/** The one line of text, fixed per `recordedOnRun` — never per outcome. */
function acknowledgementText(key: string, ack: RunFoundReportAcknowledgement): string {
  return ack.recordedOnRun
    ? `Report received for ${key}. There is nothing to act on — continue with your next step.`
    : `Report received for ${key}, which has no open dispatch leg, so nothing was recorded on a ` +
        'run. There is nothing to act on — continue with your next step.';
}

/** The adapter: one service call, the acknowledgement back as-is. */
export async function runReportUnbuildableTarget(
  args: ReportUnbuildableTargetInput,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const ack = await runFoundReportService.reportUnbuildableTarget(
    { projectKey: args.projectKey, targetKey: args.targetKey, reason: args.reason },
    ctx,
  );
  return toolOk(
    acknowledgementText(args.targetKey.trim().toUpperCase(), ack),
    exempt(REPORT_UNBUILDABLE_TARGET_TOOL_NAME, {
      acknowledged: ack.acknowledged,
      recordedOnRun: ack.recordedOnRun,
    }),
  );
}

export function registerReportUnbuildableTarget(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    REPORT_UNBUILDABLE_TARGET_TOOL_NAME,
    {
      title: 'Report a card you cannot build',
      description:
        'Tell Motir that the card you were dispatched to build CANNOT BE BUILT as written. Call ' +
        'it ONCE, when you stop on that card, right after you comment on it — with the card’s ' +
        '`projectKey` and `targetKey`, and as `reason` the SAME text as your comment (what is ' +
        'wrong with the CARD). It spends nothing. It is safe to repeat: Motir keeps one record ' +
        'per run. It returns nothing to act on — only `{ acknowledged: true, recordedOnRun }`, ' +
        'where `recordedOnRun` says whether the card had an open dispatch leg — so carry on ' +
        'with your next step whatever it says. A `reason` that is empty or longer than ' +
        `${RUN_FOUND_REPORT_REASON_MAX} characters is refused with ` +
        '`RUN_FOUND_REPORT_REASON_INVALID`; an unknown or other-workspace key is the same ' +
        'not-found either way. Requires `work_item:edit`.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runReportUnbuildableTarget(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
