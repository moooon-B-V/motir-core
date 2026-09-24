import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { approvalGateAccessService } from '@/lib/services/approvalGateAccessService';
import type { ApprovalGateKindDTO, ApprovalGateRecordDTO } from '@/lib/dto/approvalGate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { getApprovalGatePayload } from '../payloads/approvalGates';

// `get_approval_gate` (Bug MOTIR-6191) — the DECISION a person made on one
// approval gate, including the note they wrote when they sent the work back.
//
// ── The hole this fills ─────────────────────────────────────────────────────
// `ApprovalGate.noteMd` is *"why they said yes, or what they sent back"*
// (`approval-gates.md` §6a) and every door onto it was SESSION-authed: the
// overlay's route resolves `getActiveProject()` first, the item page's read is a
// server component, `get_work_item` / `get_work_item_activity` do not carry a
// gate at all, and a gate decision is not a comment so the threads do not either.
// So an agent told *"I pressed Request changes — read my note"* could not, with
// any credential it holds, and the asymmetry lands worst on the kind whose author
// is ALWAYS an agent: `decision_approval` is raised only on a `type: decision` +
// `executor: coding_agent` card (§8's FIFTH AMENDMENT).
//
// The v1 twin is `GET /api/v1/work-items/{key}/approval-gate`, for a dispatched
// agent, which speaks `/api/v1` and nothing else. Both call ONE service method,
// so the two doors cannot drift on which gate wins or on what a key means.
//
// ── ⚠️ A READ, AND DECIDING IS STILL NOT REACHABLE FROM HERE ────────────────
// There is no MCP tool that decides a gate, and there is not meant to be (§1):
// an agent-written approval would put a decision nobody made into the one table
// an audit trusts. §2's *"the decide route is session-authed and no MCP tool or
// `/api/v1` operation asserts the key"* is about DECIDING and stays true word for
// word — this tool asserts `project:browse` and writes nothing.

export const GET_APPROVAL_GATE_TOOL_NAME = 'get_approval_gate';

/**
 * The kinds, spelled out for the AGENT rather than derived from the registry.
 *
 * ⚠️ AN UNREGISTERED KIND IS STILL A REAL QUESTION HERE, which is why this is not
 * `Object.keys(APPROVAL_GATE_HANDLERS)`. The registry answers *can a surface DRAW
 * this kind's port* — `pull_request_merge` is built and withdrawn, so no frame
 * renders one — and a DECISION RECORD needs no port: a superseded merge gate's
 * row is exactly the audit artefact §6a describes, and refusing to read it would
 * hide history a caller is entitled to. Totality is held by the v1 schema this
 * tool's payload derives from, where `AssertTotal` fails the build on a new kind.
 */
const GATE_KINDS = [
  'decision_approval',
  'design_result',
  'acceptance_result',
  'pull_request_approval',
  'decision_choice',
  'decision_confirmation',
  'plan_approval',
  'pull_request_merge',
] as const satisfies readonly ApprovalGateKindDTO[];

const inputSchema = {
  key: z
    .string()
    .min(1)
    .describe(
      'The work item the gate hangs off — the project key, a dash, the number ' +
        '(e.g. "ACME-7"), case-insensitive. The card whose approval you are asking ' +
        'about, not the gate id (gates have no public ids to address).',
    ),
  kind: z
    .enum(GATE_KINDS)
    .describe(
      'Which decision to read. `decision_approval` is the gate on a `type: decision` ' +
        'card you authored; `design_result` the one your published design raised; ' +
        '`acceptance_result` a story run’s receipt; `pull_request_approval` the ' +
        'approve-and-merge question over a run’s whole delivery set; `decision_choice` ' +
        'and `decision_confirmation` the two decision kinds a person answers directly. ' +
        '`plan_approval` belongs to a PLAN rather than to a card, so no card has one. ' +
        '`pull_request_merge` is built and withdrawn — only historical rows exist.',
    ),
};

interface GetApprovalGateArgs {
  key: string;
  kind: (typeof GATE_KINDS)[number];
}

/** What each state means for what the caller should do next. */
const STATE_HELP: Record<string, string> = {
  awaiting:
    'The question is OPEN and nobody has answered it. There is no note yet, because there ' +
    'is no decision yet — do not read the absence as approval, and do not act as though ' +
    'changes were requested. Report that the card is waiting on a person, and on whom.',
  approved:
    'A person APPROVED it. `noteMd` is why they said yes, where they wrote one; an approval ' +
    'with no note is ordinary and means nothing was added.',
  changes_requested:
    'A person SENT IT BACK, and `noteMd` is what they said to change. Read it and act on ' +
    'THAT, not on what you expect they objected to — acting on an expectation is how a ' +
    'confident second wrong version gets produced. A request for changes moves no status: ' +
    'the card is yours again exactly as it was.',
  superseded:
    'The question was WITHDRAWN before anyone answered it — `supersededCause` says what ' +
    'happened to the subject (a republish, a push that moved the head, a delivery set that ' +
    'changed). It carries no decider and no note ON PURPOSE: nobody decided anything, so ' +
    'do not read a cause as somebody’s judgement.',
  overturned:
    'A person REFUSED the direction a `decision_confirmation` asked about. It is terminal, ' +
    'and it names a re-plan that is still owed — which a person starts, never a run.',
  declined: 'A person ENDED the plan a `plan_approval` gate asked about. Terminal.',
};

/** The prose an agent reads, carrying the same facts as the structured payload. */
function summarize(record: ApprovalGateRecordDTO): string {
  const head = `${record.workItemKey} — ${record.kind}: ${record.workItemTitle}`;
  if (!record.gate) {
    return [
      `${head}`,
      `NO ${record.kind} GATE on this card. That is an answer, not a failure: the question has ` +
        'never been raised here, so nothing is waiting and nothing was decided. Check you asked ' +
        'about the right kind before concluding anything — a card carries only the kinds its own ' +
        'deliverable raises.',
    ].join('\n');
  }

  const gate = record.gate;
  const lines = [head, `state: ${gate.state}`];
  if (gate.state === 'awaiting') {
    lines.push(`waiting on: ${record.routedToLabel ?? 'nobody the routing resolves to'}`);
  }
  if (gate.decidedByLabel || gate.decidedAt) {
    lines.push(
      `decided by ${gate.decidedByLabel ?? 'somebody no longer resolvable'}` +
        (gate.decidedAt ? ` at ${gate.decidedAt}` : '') +
        (gate.decidedUnderAuthority ? ` (as ${gate.decidedUnderAuthority})` : '') +
        (gate.decisionSource ? ` via ${gate.decisionSource}` : ''),
    );
  }
  if (gate.subjectVersion) lines.push(`on version: ${gate.subjectVersion}`);
  if (gate.supersededCause) lines.push(`withdrawn because: ${gate.supersededCause}`);
  if (gate.outcomeRef) lines.push(`outcome: ${gate.outcomeRef}`);
  lines.push('', STATE_HELP[gate.state] ?? '');
  if (gate.noteMd) {
    lines.push('', 'What they wrote:', gate.noteMd);
  } else if (gate.state === 'changes_requested') {
    // Unreachable through the decide door, which requires a note on
    // `request_changes` — but a row is a row, and an empty section would read as
    // *"they said nothing"* when the honest answer is *"the record has no note"*.
    lines.push('', 'No note is recorded on this decision, which is unusual for a refusal.');
  }
  return lines.join('\n');
}

export async function runGetApprovalGate(
  args: GetApprovalGateArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const record = await approvalGateAccessService.getGateRecord(
    { key: args.key, kind: args.kind },
    ctx,
  );
  return toolOk(summarize(record), derived(getApprovalGatePayload, { ...record }));
}

export function registerGetApprovalGate(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_APPROVAL_GATE_TOOL_NAME,
    {
      title: 'Get approval gate',
      description:
        'THE DECISION A PERSON MADE on one approval gate — its state, the NOTE they wrote, who ' +
        'wrote it, when, on which version of the subject, under which authority and through ' +
        'which surface. ⚠️ THIS IS HOW YOU READ A *REQUEST CHANGES* NOTE. When a reviewer sends ' +
        'your work back — a decision record, a published design, a run’s pull requests — the ' +
        'reason they gave is this gate’s `noteMd`, and it is not a comment, so no comment or ' +
        'activity read carries it. Call this before you change anything, and act on what they ' +
        'actually wrote rather than on what you expect they objected to. ⚠️ `gate: null` IS AN ' +
        'ANSWER, not a failure: this card has no gate of that kind, so nothing is waiting and ' +
        'nothing was decided — check the kind before concluding the card is clear. ⚠️ READ ' +
        '`state` BEFORE THE AUDIT FIELDS: five of them are written BY the decision, so a null ' +
        'means *not yet decided* and never *decided by nobody*. `awaiting` means the question is ' +
        'still open and `routedToLabel` says who it is waiting on; `superseded` means it was ' +
        'withdrawn before anyone answered, and its `supersededCause` is what happened to the ' +
        'subject, never somebody’s judgement. Read-only: it creates nothing, decides nothing and ' +
        'persists nothing. There is no tool that DECIDES a gate, deliberately — an approval is a ' +
        'person’s act, and the gate table is the record that it was one.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetApprovalGate(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
