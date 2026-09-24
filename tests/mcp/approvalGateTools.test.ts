import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { computeGateStamp } from '@/lib/approvalGates/stamp';
import { runGetApprovalGate, GET_APPROVAL_GATE_TOOL_NAME } from '@/lib/mcp/tools/getApprovalGate';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES, buildMcpServer } from '@/lib/mcp/registry';
import { isExemptTool } from '@/lib/mcp/payloads/exemptions';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';
import { adminDb } from '../helpers/adminDb';

// `get_approval_gate` (Bug MOTIR-6191) — the runbook's door onto a gate's
// decision record, and the one that closes the loop the epic promises: a refusal
// comes back to the agent that raised the question.
//
// The RECORD's rules are `approvalGatesService.getForWorkItem`'s and are driven in
// `tests/approval-gate-read.test.ts`. What this file asserts is what only the
// TOOL layer can be wrong about: the wiring, the permission, that the grant is not
// widened — and, the part that matters most for a tool, that the PROSE an agent
// reads carries the same facts as the structured payload. An agent acts on the
// text; a note that reaches only `structuredContent` is a note the agent can
// still miss.

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;
let fx: Fixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

/** A card carrying one `awaiting` gate of `kind`, plus the stamp its reader saw. */
async function cardWithGate(kind: ApprovalGateKind, title = 'Decide this') {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  // Somewhere a decision can legally take it — from `todo` a decision's own
  // effect raises `IllegalTransitionError`, which would fail this suite for a
  // reason that has nothing to do with reading a note.
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  const gate = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${item.id}-${kind}`,
      subjectVersion: 'v1',
      state: 'awaiting',
    },
  });
  const stamp = computeGateStamp({
    subjectVersion: 'v1',
    companionSubjectVersion: null,
    descriptionMd: item.descriptionMd ?? null,
  });
  return { item, gate, stamp };
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('wiring', () => {
  it('registered, read-scoped on `project:browse`, and NOT exempt from the payload seam', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_APPROVAL_GATE_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_APPROVAL_GATE_TOOL_NAME]).toBe('project:browse');
    // It DERIVES from the v1 `ApprovalGateDecision` component, so an agent's
    // ability to read a reviewer's note cannot depend on which surface it used.
    expect(isExemptTool(GET_APPROVAL_GATE_TOOL_NAME)).toBe(false);
  });

  it('the GRANT IS NOT WIDENED — the key is one `CLI_TOKEN_GRANT` already carried', () => {
    // The property that makes this fix reach a DISPATCHED agent too: it needs no
    // new permission, so nothing about what a sandboxed run may do changes.
    //
    // ⚠️ Asserted as MEMBERSHIP, not as the grant's whole contents: the grant's
    // exact set is pinned in its own suite and legitimately grows.
    expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS[GET_APPROVAL_GATE_TOOL_NAME]);
  });

  it('⚠️ NO TOOL DECIDES A GATE, and that is the guarantee this read must not erode', () => {
    // ADR `approval-gates.md` §1: there is no agent path to approving, *"and
    // there is not meant to be"*. §2 rests the ungrantability of
    // `approval:decide_any` on exactly this — that no tool in the map asserts it.
    // A read tool is the shape most likely to grow a write later, so the claim is
    // asserted over the WHOLE map rather than about this one tool.
    expect(Object.values(TOOL_PERMISSIONS)).not.toContain('approval:decide_any');
    expect(CLI_TOKEN_GRANT).not.toContain('approval:decide_any');
  });
});

describe('`get_approval_gate`', () => {
  it('⚠️ THE DEFECT: the REQUEST-CHANGES note reaches BOTH channels', async () => {
    // The bug in one assertion. `decision_approval` is raised only on a
    // `type: decision` + `executor: coding_agent` card (ADR §8's FIFTH
    // AMENDMENT), so the author of this question is always an agent — and until
    // this tool every door onto the answer was session-authed.
    const { item, gate, stamp } = await cardWithGate('decision_approval');
    const note = 'The discriminator is the SESSION, not whether it holds turns.';
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'request_changes', noteMd: note, source: 'ui', stamp },
      fx.ctx,
    );

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'decision_approval' },
      fx.ctx,
    );

    const payload = result.structuredContent as {
      workItemKey: string;
      kind: string;
      gate: { id: string; state: string; noteMd: string; decisionSource: string };
    };
    expect(payload).toMatchObject({
      workItemKey: item.identifier,
      kind: 'decision_approval',
      gate: { id: gate.id, state: 'changes_requested', noteMd: note, decisionSource: 'ui' },
    });
    // The TEXT is what an agent acts on, so the note has to be in it verbatim —
    // a note that reaches only the structured channel is a note that gets missed.
    const text = textOf(result);
    expect(text).toContain(note);
    expect(text).toContain('changes_requested');
    // And the text says what to DO with it: act on what they wrote, not on what
    // you expect they objected to. That sentence is the whole point of the tool.
    expect(text).toMatch(/act on THAT/i);
  });

  it('an APPROVED gate reports who approved it, when, and on which version', async () => {
    const { item, gate, stamp } = await cardWithGate('design_result');
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', noteMd: 'Ship it.', source: 'ui', stamp },
      fx.ctx,
    );

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'design_result' },
      fx.ctx,
    );

    const payload = result.structuredContent as {
      gate: {
        state: string;
        decidedByLabel: string | null;
        decidedAt: string | null;
        subjectVersion: string | null;
        decidedUnderAuthority: string | null;
      };
    };
    expect(payload.gate.state).toBe('approved');
    expect(payload.gate.decidedByLabel).not.toBeNull();
    expect(payload.gate.decidedAt).not.toBeNull();
    expect(payload.gate.subjectVersion).toBe('v1');
    expect(payload.gate.decidedUnderAuthority).not.toBeNull();
    expect(textOf(result)).toContain('Ship it.');
  });

  it('an AWAITING gate says the question is OPEN and names who it waits on', async () => {
    // The arm most likely to be MISREAD. A null note on an awaiting gate is *not
    // yet decided*, and an agent that read it as approval would carry on.
    const { item } = await cardWithGate('decision_approval');

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'decision_approval' },
      fx.ctx,
    );

    const payload = result.structuredContent as {
      gate: { state: string; noteMd: string | null };
      routedToLabel: string | null;
    };
    expect(payload.gate).toMatchObject({ state: 'awaiting', noteMd: null });
    expect(payload.routedToLabel).not.toBeNull();
    const text = textOf(result);
    expect(text).toMatch(/waiting on/i);
    expect(text).toMatch(/do not read the absence as approval/i);
  });

  it('NO gate of that kind is an ANSWER in both channels, never an error', async () => {
    const { item } = await cardWithGate('design_result');

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'acceptance_result' },
      fx.ctx,
    );

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { gate: unknown }).gate).toBeNull();
    // And the prose says which of the two it is, because *your key was wrong* and
    // *nothing was ever asked here* call for opposite next actions.
    expect(textOf(result)).toMatch(/NO acceptance_result GATE/);
  });

  it('a SUPERSEDED gate reports the cause and does NOT name a decider', async () => {
    // §6b: a supersede carries no decider, no authority and no note on purpose —
    // a cause says what happened to the SUBJECT. A tool that rendered one as
    // *somebody withdrew this* would put a decision nobody made into the record.
    const { item, gate } = await cardWithGate('design_result');
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: { state: 'superseded', supersededCause: 'republished' },
    });

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'design_result' },
      fx.ctx,
    );

    const payload = result.structuredContent as {
      gate: { state: string; supersededCause: string; decidedByLabel: null; noteMd: null };
    };
    expect(payload.gate).toMatchObject({
      state: 'superseded',
      supersededCause: 'republished',
      decidedByLabel: null,
      noteMd: null,
    });
    const text = textOf(result);
    expect(text).toContain('withdrawn because: republished');
    expect(text).toMatch(/never somebody's judgement|not read a cause as somebody/i);
  });

  it('a card in ANOTHER workspace is an indistinguishable not-found', async () => {
    const { item } = await cardWithGate('design_result');
    const outsider = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });

    const result = await runGetApprovalGate(
      { key: item.identifier, kind: 'design_result' },
      outsider.ctx,
    ).catch((err: unknown) => err);

    // Thrown, not answered — and the tool's own wrapper turns it into a tool
    // ERROR rather than a transport failure (the handshake suite below).
    expect(result).toBeInstanceOf(Error);
    expect((result as { code?: string }).code).toBe('WORK_ITEM_NOT_FOUND');
  });
});

describe('through a real MCP handshake', () => {
  async function connectClient(ctx: typeof fx.ctx): Promise<InstanceType<typeof Client>> {
    const server = buildMcpServer(() => ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'approval-gate-tool', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  it('appears in `tools/list` advertising both required arguments and every kind', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();

    const tool = tools.find((t) => t.name === GET_APPROVAL_GATE_TOOL_NAME)!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['key', 'kind']);
    // The kinds are ADVERTISED: an agent picks `decision_approval` off this
    // surface, so a schema that hid the vocabulary would leave it guessing.
    const kind = (tool.inputSchema.properties as { kind: { enum: string[] } }).kind;
    expect(kind.enum).toContain('decision_approval');
    expect(kind.enum).toContain('design_result');
    await client.close();
  });

  it('a not-found key comes back as a tool ERROR, not a transport failure', async () => {
    const client = await connectClient(fx.ctx);

    const result = (await client.callTool({
      name: GET_APPROVAL_GATE_TOOL_NAME,
      arguments: { key: 'PROD-99999', kind: 'design_result' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('WORK_ITEM_NOT_FOUND');
    await client.close();
  });
});
