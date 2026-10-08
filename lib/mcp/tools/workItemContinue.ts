import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DispatchStopReason } from '@/generated/prisma/client';
import { dispatchStopReasonSchema } from '@/lib/api/v1/workLoop/schema';
import { projectsService } from '@/lib/services/projectsService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import type { WorkItemContinueClaimDto, WorkItemContinueRunDto } from '@/lib/dto/workItemContinue';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived, exempt } from '../payloads/define';
import {
  claimWorkItemContinuePayload,
  presentMcpWorkItemContinueClaim,
} from '../payloads/workLoop';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// The CONTINUE tools (Story MOTIR-7261 · MOTIR-7262) — the MCP door onto the
// CONTINUE CLAIM `motir continue <key>` makes over `/api/v1` (MOTIR-6532), so an
// agent working from a Motir skill can take over a run that DIED, keep it alive,
// and hand it back with how it ended. `dispatch_prompt`'s `continueFrom` is the
// fourth half: the CONTINUE prompt the CLI reads for the same run.
//
// ⚠️ A DOOR, NEVER A SECOND ANSWER. The repair tools' rule (`workItemRepair.ts`),
// one lifecycle over. The refusal order, the lock, the lapsed run it closes, the
// credit gate and the edit gate are `workItemContinueService.claimContinue`'s;
// the liveness is `dispatchRunService.heartbeat`'s under the lock it shares with
// the reap; the close is `dispatchRunService.close`'s. The claim answers through
// v1's own presenter, so the two doors cannot drift. The only thing the MCP door
// adds is the ownership read touch and close need — `workItemContinueService`
// owns it.
//
// ⚠️ A REFUSAL IS AN ANSWER. `taken` and `not_continuable` are ordinary results
// (the REST route answers them with a 200), and a closed run is `open: false` on
// touch and an idempotent answer on close — never an MCP error.
//
// ⚠️ NO RUN EVENTS. The CLI appends its own as it drives the agent; an agent
// holding a continue needs the lock, its liveness and its outcome, and nothing
// reads the rest from an MCP caller (the repair story drew the same boundary).
//
// `touch` and `close` are EXEMPT from payload derivation
// (`payloads/exemptions.ts`): they answer the continue run's liveness, which is
// not the v1 `DispatchRun` resource and must not become it
// (`MCP_UNREACHABLE_RESOURCES.DispatchRun`).

export const CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME = 'claim_work_item_continue';
export const TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME = 'touch_work_item_continue';
export const CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME = 'close_work_item_continue';

const runIdField = z
  .string()
  .min(1)
  .describe(
    'The continue run’s id — the `runId` `claim_work_item_continue` answered. Only your own ' +
      'run on this work item is accepted.',
  );

const claimInputSchema = {
  key: workItemKeyField,
};

const touchInputSchema = {
  key: workItemKeyField,
  runId: runIdField,
};

const closeInputSchema = {
  key: workItemKeyField,
  runId: runIdField,
  // The v1 enum's OPTIONS, rebuilt on this file's zod: the v1 schema is `zod/v4`
  // and the MCP SDK refuses an input shape that mixes the two. Taking the options
  // keeps the set the REST close accepts as the single source.
  outcome: z
    .enum(dispatchStopReasonSchema.options as [DispatchStopReason, ...DispatchStopReason[]])
    .describe(
      'How the continue ended — the stop reasons the REST close accepts, and the ones ' +
        '`motir continue` closes with: "completed" (the work is delivered), "drained" (a parent ' +
        'continue ran out of ready cards), "max" (it stopped at its card limit), "halted" (you ' +
        'stopped on something you could not get past), "interrupted" (the person stopped you), ' +
        '"replanned" (the card went to Planning), "gated" (it stopped at an approval gate) or ' +
        '"abandoned".',
    ),
};

/** The branches line — where the continuing agent works, repository by repository. */
function branchLines(claim: WorkItemContinueClaimDto): string {
  return claim.branches
    .map((b) => {
      const where = b.repository ?? 'the card’s repository';
      const pr = b.pullRequest ? ` — open pull request ${b.pullRequest.url}` : '';
      return `  · ${where}: branch ${b.branch}${pr}`;
    })
    .join('\n');
}

/** What the agent reads first — the claim's outcome, said as an instruction. */
function summarizeClaim(claim: WorkItemContinueClaimDto): string {
  const holder = claim.holder?.name ?? 'someone else';
  const keepAlive =
    `Keep it alive with touch_work_item_continue (runId ${claim.runId}) at least every two ` +
    'minutes — a run silent for five minutes is closed — read the prompt with dispatch_prompt ' +
    `(continueFrom ${claim.deadRun?.id ?? 'the dead run'}), and end it with ` +
    'close_work_item_continue.';
  const scope =
    claim.mode === 'parent'
      ? `\nThis is a PARENT continue: already landed ${claim.landedKeys.join(', ') || 'none'}; ` +
        `still to run ${claim.resumedKeys.join(', ') || 'none'}.`
      : '';
  switch (claim.outcome) {
    case 'claimed':
      if (claim.resumesGated) {
        return (
          `Claimed the RESUME of ${claim.key} — ${claim.title} (run ${claim.runId}). Its last run ` +
          `(${claim.deadRun?.id ?? '—'}) did not die: it stopped at a gate, and these are now ` +
          `approved: ${gateNames(claim)}. Resume on these branches, never a new one:\n` +
          `${branchLines(claim)}${scope}\n${keepAlive}`
        );
      }
      return (
        `Claimed the continue of ${claim.key} — ${claim.title} (run ${claim.runId}), taking over ` +
        `run ${claim.deadRun?.id ?? '—'}. Continue on these branches, never a new one:\n` +
        `${branchLines(claim)}${scope}\n${keepAlive}`
      );
    case 'mine':
      return (
        `Already yours: you hold the continue of ${claim.key} (run ${claim.runId}). This is a ` +
        `RESUME, not a lost race. The branches:\n${branchLines(claim)}${scope}\n` +
        `Keep it alive with touch_work_item_continue (runId ${claim.runId}) at least every two ` +
        'minutes and end it with close_work_item_continue.'
      );
    case 'taken':
      return (
        `NOT claimed: ${claim.key} is already being continued by ${holder}` +
        (claim.startedAt ? ` (since ${claim.startedAt})` : '') +
        '. Do NOT push to its branch — pick different work.'
      );
    case 'not_continuable':
      if (claim.reason === 'continue_the_parent') {
        return (
          `NOT claimed: ${claim.key} was a leg of a run over ${claim.parentKey}. Claim the ` +
          `continue of ${claim.parentKey} instead.`
        );
      }
      if (claim.reason === 'gate_awaiting') {
        return (
          `NOT claimed: ${claim.key}'s run stopped at a gate that is still waiting for approval ` +
          `(${gateNames(claim)}). It resumes once a person approves it. Nothing changed.`
        );
      }
      if (claim.reason === 'gate_sent_back') {
        return (
          `NOT claimed: ${claim.key}'s run stopped at a gate that was sent back, not approved ` +
          `(${gateNames(claim)}). Nothing was released to build. Nothing changed.`
        );
      }
      if (claim.reason === 'run_alive') {
        return `NOT claimed: a run on ${claim.key} by ${holder} is still alive. Nothing changed.`;
      }
      return `NOT claimed: ${claim.key} has nothing to continue (${claim.reason}). Nothing changed.`;
  }
}

/** `MOTIR-7 design_result (approved), …` — the gates a gated run names. */
function gateNames(claim: WorkItemContinueClaimDto): string {
  return claim.gates.length === 0
    ? 'none recorded'
    : claim.gates.map((g) => `${g.key} ${g.kind} (${g.state})`).join(', ');
}

/** The touch / close answer, said as what to do next. */
function summarizeRun(run: WorkItemContinueRunDto, verb: 'touch' | 'close'): string {
  if (run.open) {
    return (
      `Continue run ${run.runId} on ${run.key} is still open — keep working and touch again ` +
      'within two minutes.'
    );
  }
  const how = `${run.status}${run.stopReason ? `, ${run.stopReason}` : ''}`;
  return verb === 'close'
    ? `Continue run ${run.runId} on ${run.key} is closed (${how}).`
    : `Continue run ${run.runId} on ${run.key} is CLOSED (${how}). STOP pushing: the lock is ` +
        'gone and somebody else may be continuing the card. Claim again if you still need to ' +
        'work on it.';
}

/** `claim_work_item_continue` — take over one card whose last run died. */
export async function runClaimWorkItemContinue(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const claim = await workItemContinueService.claimContinueAsAgent(project.id, identifier, ctx);
    return toolOk(
      summarizeClaim(claim),
      derived(claimWorkItemContinuePayload, presentMcpWorkItemContinueClaim(claim)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `touch_work_item_continue` — keep the caller's continue run alive. */
export async function runTouchWorkItemContinue(
  args: { key: string; runId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const run = await workItemContinueService.touchContinue(
      project.id,
      identifier,
      args.runId,
      ctx,
    );
    return toolOk(
      summarizeRun(run, 'touch'),
      exempt(TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME, { ...run }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `close_work_item_continue` — end the caller's continue run with its outcome. */
export async function runCloseWorkItemContinue(
  args: { key: string; runId: string; outcome: DispatchStopReason },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const run = await workItemContinueService.closeContinue(
      project.id,
      identifier,
      args.runId,
      args.outcome,
      ctx,
    );
    return toolOk(
      summarizeRun(run, 'close'),
      exempt(CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME, { ...run }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerWorkItemContinue(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME,
    {
      title: 'Continue a dead run’s work item',
      description:
        'Take over a work item whose last run DIED (by identifier, e.g. "ACME-7") — the same ' +
        'continue claim `motir continue` makes, and the same lock: one continuing agent at a ' +
        'time, across MCP and the CLI. The item is re-assigned to you; its status is not ' +
        'changed. Answers `claimed` (yours: the `runId`, the dead run and each repository’s ' +
        'branch to continue on, with its open pull request), `mine` (you already hold it — ' +
        'resume), `taken` (someone else is continuing it; they are named) or `not_continuable` ' +
        'with the reason (`run_alive`, `use_fix`, `not_in_progress`, `continue_the_parent` ' +
        'naming the parent to continue instead, `no_dead_run`, `no_branch`, `gate_awaiting` / ' +
        '`gate_sent_back` naming the `gates` a run that stopped at a gate still waits on). A ' +
        'run that stopped at a gate whose gate is now APPROVED is claimed too, as a resume ' +
        '(`resumesGated`, with the approved `gates`). A refusal is a ' +
        'RESULT, not an error, and changes nothing. After claiming, read the prompt with ' +
        '`dispatch_prompt` and `continueFrom` = the dead run’s id, call ' +
        '`touch_work_item_continue` at least every two minutes, and finish with ' +
        '`close_work_item_continue`. Needs permission to edit the work item.',
      inputSchema: claimInputSchema,
    },
    async (args, extra) => runClaimWorkItemContinue(args, resolveContext(extra)),
  );
  server.registerTool(
    TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME,
    {
      title: 'Keep a continue alive',
      description:
        'Keep your continue of a work item alive while you work on it: call it at least every ' +
        'two minutes with the `runId` `claim_work_item_continue` answered. A continue silent for ' +
        'five minutes is closed by the server and the card reads its run died again. Answers ' +
        '`open: true` while your continue is open, and `open: false` with its `stopReason` once ' +
        'it has been closed — by you, by the server or by anyone else — which means STOP ' +
        'pushing: the lock is gone. Only your own continue run of that work item is accepted. ' +
        'Writes no status and no event. Needs permission to edit the work item.',
      inputSchema: touchInputSchema,
    },
    async (args, extra) => runTouchWorkItemContinue(args, resolveContext(extra)),
  );
  server.registerTool(
    CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME,
    {
      title: 'Close a continue',
      description:
        'End your continue of a work item with how it went — `outcome` is one of the stop ' +
        'reasons the run close accepts ("completed", "halted", "interrupted", …) — so the work ' +
        'item page shows how it ended and the item no longer reads as being continued. Pass the ' +
        '`runId` `claim_work_item_continue` answered; only your own continue run of that work ' +
        'item is accepted. Idempotent: closing a continue that is already closed returns it ' +
        'unchanged. Does not change the work item’s status — your pull request moves it. Needs ' +
        'permission to edit the work item.',
      inputSchema: closeInputSchema,
    },
    async (args, extra) => runCloseWorkItemContinue(args, resolveContext(extra)),
  );
}
