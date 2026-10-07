import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  DispatchCardDisposition,
  DispatchEventKind,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';
import {
  dispatchCardDispositionSchema,
  dispatchSkipReasonSchema,
  dispatchStopReasonSchema,
} from '@/lib/api/v1/workLoop/schema';
import {
  AGENT_ACTION_MAX_CHARS,
  AgentRunNoOpenRunError,
  AgentRunNotClaimedError,
} from '@/lib/dispatchRuns/errors';
import {
  AGENT_REPORTABLE_EVENT_KINDS,
  dispatchRunService,
  type AgentReportedEventInput,
} from '@/lib/services/dispatchRunService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { normalizeIdentifier, sessionBranchField, workItemKeyField } from './workItemRef';

// The RUN tools (Story MOTIR-7446 · MOTIR-7451, `docs/decisions/agent-reported-runs.md`)
// — the MCP door through which ANY agent that speaks MCP reports its own run of a
// card: Claude Code through the Motir plugin, Codex, Kimi, anything else. It opens
// the run over a claim it already holds, says each step before it takes it, and
// closes the run on every exit, so `/runs`, the run modal and the card's run
// section show who ran the card, on which model, what it did and for how long.
//
// ⚠️ A DOOR, NEVER A SECOND ANSWER — the continue tools' rule
// (`workItemContinue.ts`). The claim check, the idempotent open, the allow-list,
// the run found from the card, the 60-minute liveness and the provenance a
// delivered close stamps are all `dispatchRunService`'s (`openAgentRun`,
// `reportAction`, `heartbeatCallerRuns`, `closeAgentRun`). This file shapes
// arguments in and answers out, and it splits a batch's events into the kinds an
// agent may send and the ones it may not, so one bad kind does not lose the rest.
//
// ⚠️ RUN EVENTS — THIS FAMILY TAKES THEM, AND THE CONTINUE AND REPAIR TOOLS DO
// NOT. Those two hold a LOCK: their run is the CLI's, the CLI appends its events,
// and an agent needs only the lock, its liveness and its outcome. Here there is no
// CLI around the agent — the agent IS the reporter (AMENDMENT 3 of
// `dispatch-run-record.md`), so it sends its own steps (`agent_action`) and the
// four milestones nothing else would write for it: `checkout_ready`,
// `delivery_linked`, `leg_verdict`, `card_settled`. Every other kind stays the
// server's or the runner's, and every event is stored as `reportedBy: 'agent'`, so
// a reader always knows whose account it is reading.
//
// ⚠️ A REFUSAL IS AN ANSWER where the agent's next move is ordinary work: a start
// without the claim (`not_claimed` — claim it first) and a report with no open run
// (`no_open_run` — start one). Neither writes anything. A malformed call is a tool
// error carrying its code.
//
// All three are EXEMPT from payload derivation (`payloads/exemptions.ts`): they
// answer a receipt and a liveness shape, never the v1 `DispatchRun` resource,
// whose READ stays unreachable from MCP (`MCP_UNREACHABLE_RESOURCES.DispatchRun`).

export const START_WORK_ITEM_RUN_TOOL_NAME = 'start_work_item_run';
export const REPORT_ACTION_TOOL_NAME = 'report_action';
export const CLOSE_WORK_ITEM_RUN_TOOL_NAME = 'close_work_item_run';

/** The close outcomes an agent may report — v1's stop reasons less the reap's own. */
const AGENT_CLOSE_OUTCOMES = dispatchStopReasonSchema.options.filter((o) => o !== 'abandoned') as [
  Exclude<DispatchStopReason, 'abandoned'>,
  ...Exclude<DispatchStopReason, 'abandoned'>[],
];

const startInputSchema = {
  key: workItemKeyField,
  harness: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'The agent harness you are running in, as its makers name it — e.g. "Claude Code", ' +
        '"Codex", "Kimi CLI". Say what you are, honestly; it is what the run and the card record.',
    ),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The model you are running on, by its id (e.g. "gpt-5-codex"). Omit it when you do not ' +
        'know it rather than guessing.',
    ),
};

const reportEventSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .describe(
        'The milestone: "checkout_ready" (your branch is checked out — put `{ branch }` in ' +
          '`data`), "delivery_linked" (a pull request is linked — `{ url }`), "leg_verdict" or ' +
          '"card_settled". Any other kind comes back in `refused`.',
      ),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('The milestone’s facts, e.g. `{ "branch": "subtask/ACME-7-fix" }`.'),
    disposition: z
      .enum(
        dispatchCardDispositionSchema.options as [
          DispatchCardDisposition,
          ...DispatchCardDisposition[],
        ],
      )
      .optional()
      .describe('The leg’s new disposition, when the milestone settles it (e.g. "implemented").'),
    skipReason: z
      .enum(dispatchSkipReasonSchema.options as [DispatchSkipReason, ...DispatchSkipReason[]])
      .optional()
      .describe('Why the leg was skipped, with a "skipped" disposition.'),
    sessionBranch: sessionBranchField.optional(),
  })
  .strict();

const reportInputSchema = {
  key: workItemKeyField
    .optional()
    .describe(
      'The card the step is on (e.g. "ACME-7") — the card you started the run on, or one of its ' +
        'children in a parent run. Required with `action` or `events`; omit everything for a ' +
        'heartbeat only.',
    ),
  action: z
    .string()
    .optional()
    .describe(
      `The step you are ABOUT to take, in one line of at most ${AGENT_ACTION_MAX_CHARS} ` +
        'characters — e.g. "Running the targeted tests for the run service". Never a transcript, ' +
        'a diff, file contents, a prompt or a secret.',
    ),
  events: z
    .array(reportEventSchema)
    .max(20)
    .optional()
    .describe('Milestones to record before the step, on the leg of `key`.'),
};

const closeInputSchema = {
  key: workItemKeyField.describe(
    'The card you started the run on (e.g. "ACME-7") — the same key `start_work_item_run` took.',
  ),
  runId: z.string().min(1).describe('The run’s id — the `runId` `start_work_item_run` answered.'),
  outcome: z
    .enum(AGENT_CLOSE_OUTCOMES)
    .describe(
      'How the run ended: "completed" (the work is delivered), "drained" (a parent run finished ' +
        'every child it could), "max" (it stopped at a card limit), "halted" (you stopped on ' +
        'something you could not get past), "interrupted" (the person stopped you), "replanned" ' +
        '(the card went to Planning) or "gated" (the remaining work waits on an approval gate — ' +
        'a design, decision, choice, confirmation or manual card not yet decided; Motir records ' +
        'which gates held the run, and a stop at such a gate is never "halted").',
    ),
};

/** The text every start answer ends with — the two rules the run depends on. */
const RUN_RULES =
  'Call report_action with `key` and a one-line `action` BEFORE every step you take, and ' +
  'close_work_item_run on EVERY exit — delivered, stopped, interrupted or failed. Every Motir ' +
  'call keeps the run alive; a run silent for 60 minutes is closed for you.';

/** `start_work_item_run` — open the caller's run over a card they hold. */
export async function runStartWorkItemRun(
  args: { key: string; harness: string; model?: string | undefined },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const opened = await dispatchRunService.openAgentRun(
      {
        key: identifier,
        harness: args.harness,
        ...(args.model !== undefined ? { model: args.model } : {}),
      },
      ctx,
    );
    const outcome = opened.outcome === 'opened' ? 'started' : 'mine';
    const legs = opened.legs;
    const legLines = legs.map((l) => `  · ${l.key}${l.title ? ` — ${l.title}` : ''}`).join('\n');
    const head =
      outcome === 'started'
        ? `Started run ${opened.run.id} on ${identifier}`
        : `Already yours: run ${opened.run.id} on ${identifier} is open — this is a RESUME, ` +
          'not a second run';
    return toolOk(
      `${head}, over ${legs.length === 1 ? '1 card' : `${legs.length} cards`}:\n${legLines}\n` +
        RUN_RULES,
      exempt(START_WORK_ITEM_RUN_TOOL_NAME, {
        outcome,
        key: identifier,
        runId: opened.run.id,
        reportedBy: opened.run.reportedBy,
        legs,
      }),
    );
  } catch (err) {
    if (err instanceof AgentRunNotClaimedError) {
      return toolOk(
        `NOT started: ${err.message}`,
        exempt(START_WORK_ITEM_RUN_TOOL_NAME, {
          outcome: 'not_claimed',
          key: identifier,
          runId: null,
          offenderKey: err.offenderKey,
          legs: [],
        }),
      );
    }
    return toToolError(err);
  }
}

/** `report_action` — say the next step, record milestones, or only heartbeat. */
export async function runReportAction(
  args: {
    key?: string | undefined;
    action?: string | undefined;
    events?: z.infer<typeof reportEventSchema>[] | undefined;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = args.key !== undefined ? normalizeIdentifier(args.key) : undefined;
  // The allow-list split: the kinds an agent may send go to the service, the rest
  // come back named, so one wrong kind does not cost the batch its good events.
  const allowed: AgentReportedEventInput[] = [];
  const refused: { kind: string; reason: string }[] = [];
  for (const event of args.events ?? []) {
    if (!(AGENT_REPORTABLE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
      refused.push({
        kind: event.kind,
        reason:
          'An agent may send only checkout_ready, delivery_linked, leg_verdict and ' +
          'card_settled; the server and the runner write every other kind.',
      });
      continue;
    }
    allowed.push({
      kind: event.kind as DispatchEventKind,
      ...(event.data !== undefined ? { data: event.data as AgentReportedEventInput['data'] } : {}),
      ...(event.disposition !== undefined ? { disposition: event.disposition } : {}),
      ...(event.skipReason !== undefined ? { skipReason: event.skipReason } : {}),
      ...(event.sessionBranch !== undefined ? { sessionBranch: event.sessionBranch } : {}),
    });
  }
  const refusedLine =
    refused.length > 0
      ? `\nNOT stored: ${refused.map((r) => r.kind).join(', ')} — ${refused[0]!.reason}`
      : '';

  // Nothing left to store once the bad kinds are out, and no step: the call was a
  // batch of refusals, which is an answer, not a heartbeat.
  if (
    identifier !== undefined &&
    args.action === undefined &&
    allowed.length === 0 &&
    refused.length > 0
  ) {
    return toolOk(
      `Nothing stored on ${identifier}.${refusedLine}`,
      exempt(REPORT_ACTION_TOOL_NAME, { outcome: 'refused', runId: null, accepted: 0, refused }),
    );
  }

  try {
    const reported = await dispatchRunService.reportAction(
      {
        ...(identifier !== undefined ? { key: identifier } : {}),
        ...(args.action !== undefined ? { action: args.action } : {}),
        ...(allowed.length > 0 ? { events: allowed } : {}),
      },
      ctx,
    );
    if (reported.kind === 'heartbeat') {
      return toolOk(
        `Heartbeat: ${reported.touched === 1 ? '1 open run' : `${reported.touched} open runs`} ` +
          'refreshed (a run refreshed under a minute ago is left as it is).',
        exempt(REPORT_ACTION_TOOL_NAME, {
          outcome: 'heartbeat',
          runId: null,
          accepted: 0,
          refused,
          touched: reported.touched,
        }),
      );
    }
    return toolOk(
      `Recorded on run ${reported.runId}: ${reported.appended === 1 ? '1 event' : `${reported.appended} events`}` +
        `${args.action !== undefined ? ` — “${args.action.trim()}”` : ''}.${refusedLine}`,
      exempt(REPORT_ACTION_TOOL_NAME, {
        outcome: 'reported',
        runId: reported.runId,
        runReportedBy: reported.runReportedBy,
        accepted: reported.appended,
        seq: reported.seq,
        refused,
      }),
    );
  } catch (err) {
    if (err instanceof AgentRunNoOpenRunError) {
      return toolOk(
        `NOT recorded: ${err.message}`,
        exempt(REPORT_ACTION_TOOL_NAME, {
          outcome: 'no_open_run',
          runId: null,
          accepted: 0,
          refused,
        }),
      );
    }
    return toToolError(err);
  }
}

/** `close_work_item_run` — end the caller's run with how it went. */
export async function runCloseWorkItemRun(
  args: { key: string; runId: string; outcome: Exclude<DispatchStopReason, 'abandoned'> },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const closed = await dispatchRunService.closeAgentRun(
      { key: identifier, runId: args.runId, stopReason: args.outcome },
      ctx,
    );
    const how = `${closed.run.status}${closed.run.stopReason ? `, ${closed.run.stopReason}` : ''}`;
    const stampedLine =
      closed.stamped.length > 0
        ? ` Recorded as implemented by this run: ${closed.stamped.join(', ')}.`
        : '';
    return toolOk(
      closed.alreadyClosed
        ? `Run ${closed.run.id} on ${identifier} was already closed (${how}); nothing changed.`
        : `Closed run ${closed.run.id} on ${identifier} (${how}).${stampedLine}`,
      exempt(CLOSE_WORK_ITEM_RUN_TOOL_NAME, {
        closed: true,
        alreadyClosed: closed.alreadyClosed,
        runId: closed.run.id,
        status: closed.run.status,
        stopReason: closed.run.stopReason,
        endedAt: closed.run.endedAt,
        stamped: closed.stamped,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerWorkItemRun(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    START_WORK_ITEM_RUN_TOOL_NAME,
    {
      title: 'Start your run of a work item',
      description:
        'Open YOUR run of a work item you already hold (by identifier, e.g. "ACME-7"), naming ' +
        'the agent harness you are and the model you run on — so the run shows on Runs and on ' +
        'the card with who ran it, on what, what it did and for how long. Call it right after ' +
        '`claim_work_item`. A parent card opens ONE run whose legs are its children that are ' +
        'not done; you must hold each of them. Answers `started` with the `runId` and its ' +
        '`legs`, `mine` with the run you already have open on this card (resume it — never a ' +
        'second run), or `not_claimed` naming the card you do not hold, which writes nothing. ' +
        'Then call `report_action` before EVERY step and `close_work_item_run` on EVERY exit. ' +
        'Needs permission to edit the work item.',
      inputSchema: startInputSchema,
    },
    async (args, extra) => runStartWorkItemRun(args, resolveContext(extra)),
  );
  server.registerTool(
    REPORT_ACTION_TOOL_NAME,
    {
      title: 'Report your next step',
      description:
        'Say the step you are ABOUT to take on a card, in one line (`action`, at most ' +
        `${AGENT_ACTION_MAX_CHARS} characters), before you take it — one call per step, never ` +
        'a transcript, a diff, file contents, a prompt or a secret. The run is found from the ' +
        'card (`key`) and you, so it works in a run you started and inside a `motir run` or ' +
        'hosted run. In a run you started you may also send milestones in `events`: ' +
        '`checkout_ready`, `delivery_linked`, `leg_verdict`, `card_settled`; any other kind ' +
        'comes back in `refused` while the rest are stored. With NO arguments it is a heartbeat ' +
        'over your open runs. Answers `reported` with `runId`, `accepted` and `refused`, or ' +
        '`no_open_run` (start one with `start_work_item_run`), which writes nothing. Needs ' +
        'permission to edit the work item.',
      inputSchema: reportInputSchema,
    },
    async (args, extra) => runReportAction(args, resolveContext(extra)),
  );
  server.registerTool(
    CLOSE_WORK_ITEM_RUN_TOOL_NAME,
    {
      title: 'Close your run of a work item',
      description:
        'End YOUR run of a work item with how it went (`outcome`: "completed", "drained", ' +
        '"max", "halted", "interrupted", "replanned" or "gated") — on EVERY exit, including a ' +
        'failure or an interruption. Pass the key and the `runId` `start_work_item_run` ' +
        'answered; only the person who opened a run may close it. A "completed" or "drained" ' +
        'close records your harness and model as the implementer of each card the run took to ' +
        'Implemented or later, and answers those keys in `stamped`. Idempotent: closing a run ' +
        'that is already closed answers it unchanged. "gated" is the outcome for a run that ' +
        'stopped because its remaining work waits on an approval gate (a design, decision, ' +
        'choice, confirmation or manual card not yet decided): Motir records which gates held it ' +
        'and lists it To resume, and such a stop is never "halted". Does not change any card’s ' +
        'status. Needs permission to edit the work item.',
      inputSchema: closeInputSchema,
    },
    async (args, extra) => runCloseWorkItemRun(args, resolveContext(extra)),
  );
}
