import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { plansService } from '@/lib/services/plansService';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { permissionDenial, PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `update_plan_proposal` + `withdraw_plan_proposal` (Story MOTIR-3533 · Subtask
// MOTIR-3541) — the MCP door onto a LANDED plan.
//
// Both tools are THIN: the lock, the frozen-status gate, the ref re-validation,
// the referrer check and the trail write are all `plansService`, and
// `tests/integration/plans/correctAndWithdrawProposal.test.ts` proves them
// there. What is asserted HERE is what only the transport can answer:
//
//   1. THE TOOLS EXIST AND REACH THE SERVICE — through the real MCP transport,
//      with a real argument schema, not a direct service call.
//   2. ⚠️ THE PERMISSION CONTRACT, IN BOTH DIRECTIONS — and the one that matters
//      is the REFUSAL. A token built from `CLI_TOKEN_GRANT` must be DENIED, and
//      the assertion is built from that CONSTANT rather than from an inline
//      permission list, so a later widening of the grant fails HERE instead of
//      silently changing what a sandboxed run may do to a plan. MOTIR-3058 and
//      MOTIR-3051 both shipped green against an admin token and refused the one
//      caller they were built for; this is the assertion neither had.
//   3. NOTHING BECOMES A WORK ITEM, on either tool.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'correct-plan-proposal', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

/** A plan with two `add`s appended in SEPARATE calls, so both ids are refable. */
async function planWithTwoAdds(client: Client, fx: WorkItemFixture) {
  const created = await call(client, CREATE_PLAN_TOOL_NAME, {
    projectKey: fx.projectIdentifier,
    title: 'A correctable plan',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  const planId = (created.structuredContent as unknown as { id: string }).id;

  const first = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
  });
  const firstId = (first.structuredContent as unknown as { planItemIds: string[] }).planItemIds[0]!;

  const second = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
    planId,
    proposals: [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
  });
  const secondId = (second.structuredContent as unknown as { planItemIds: string[] })
    .planItemIds[0]!;

  return { planId, firstId, secondId };
}

describe('the two tools are registered, permissioned and free', () => {
  it('are in the registry and declared in TOOL_PERMISSIONS', () => {
    expect(MCP_TOOL_NAMES).toContain(UPDATE_PLAN_PROPOSAL_TOOL_NAME);
    expect(MCP_TOOL_NAMES).toContain(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME);
    expect(TOOL_PERMISSIONS[UPDATE_PLAN_PROPOSAL_TOOL_NAME]).toBe('ai:view_plan');
    expect(TOOL_PERMISSIONS[WITHDRAW_PLAN_PROPOSAL_TOOL_NAME]).toBe('ai:view_plan');
  });

  it('the gate opens with the key and closes without it', () => {
    for (const tool of [
      UPDATE_PLAN_PROPOSAL_TOOL_NAME,
      WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    ] as const) {
      const withoutIt = GRANTABLE_PERMISSIONS.filter((p) => p !== TOOL_PERMISSIONS[tool]);
      expect(permissionDenial(tool, withoutIt), `${tool} should be denied`).not.toBeNull();
      expect(permissionDenial(tool, GRANTABLE_PERMISSIONS)).toBeNull();
    }
  });

  it('are NOT billable — correcting a plan starts no model job', () => {
    expect(isBillableTool(UPDATE_PLAN_PROPOSAL_TOOL_NAME)).toBe(false);
    expect(isBillableTool(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME)).toBe(false);
  });

  it('their descriptions state the contract an agent plans against', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const correct = byName.get(UPDATE_PLAN_PROPOSAL_TOOL_NAME)!;
    expect(correct.description).toContain('planned');
    expect(correct.description).toContain('approved');
    expect(correct.description).toContain('update_work_item');
    expect(correct.description).toContain('declined');

    const withdraw = byName.get(WITHDRAW_PLAN_PROPOSAL_TOOL_NAME)!;
    // The dangling-ref behaviour is the one an agent cannot guess and would
    // otherwise discover by being refused.
    expect(withdraw.description).toMatch(/referenc/i);
    expect(withdraw.description).toContain('remove');
  });
});

// ── ⚠️ THE ASSERTION THIS CARD EXISTS FOR ───────────────────────────────────

describe('a CLI-minted token is REFUSED, and the refusal names the missing key', () => {
  it('CLI_TOKEN_GRANT does not carry `ai:view_plan`, so both tools are denied', () => {
    // Built from the CONSTANT, never from an inline list. That is the whole
    // mechanism: widening `CLI_TOKEN_GRANT` later fails THIS test rather than
    // quietly handing a sandboxed run the plan-authoring surface.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');

    for (const tool of [
      UPDATE_PLAN_PROPOSAL_TOOL_NAME,
      WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    ] as const) {
      const denial = permissionDenial(tool, [...CLI_TOKEN_GRANT]);
      expect(denial, `${tool} must refuse a CLI-minted token`).not.toBeNull();
      const text = textOf(denial!);
      expect(text).toContain(PERMISSION_NOT_GRANTED_CODE);
      // It names the key the operator would have to grant, not just "denied".
      expect(text).toContain('ai:view_plan');
      expect(text).toContain(tool);
    }
  });

  it('is the SAME refusal a CLI token already gets on `add_plan_items` — not a new limit', () => {
    // The contract `motir-meta/prompts/_shared.md` states: such a run can open a
    // plan (`create_plan` needs only `work_item:edit`) and is refused on its
    // first append. These two tools join the refused set; nothing about what a
    // sandboxed run may do to a plan has changed.
    expect(permissionDenial(CREATE_PLAN_TOOL_NAME, [...CLI_TOKEN_GRANT])).toBeNull();
    expect(permissionDenial(ADD_PLAN_ITEMS_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
    expect(permissionDenial(UPDATE_PLAN_ITEM_TOOL_NAME, [...CLI_TOKEN_GRANT])).not.toBeNull();
  });
});

describe('driven through the real transport with a workspace PAT', () => {
  it('corrects a proposal’s parent and dependency edges on a `planned` plan', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    // Close it for review — the case the story exists for.
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}${firstId}`,
      blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
    });
    expect(corrected.isError).toBeFalsy();

    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: secondId } });
    expect(row.parentRef).toBe(`${TEMP_REF_PREFIX}${firstId}`);
    expect(row.blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${firstId}`]);
  });

  it('corrects a `modify`’s patch — the shape the live artifact got wrong', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'An existing card' });
    const { planId, firstId } = await planWithTwoAdds(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
    });
    const modifyId = (appended.structuredContent as unknown as { planItemIds: string[] })
      .planItemIds[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByAdd: [`${TEMP_REF_PREFIX}${firstId}`] },
    });
    expect(corrected.isError).toBeFalsy();
    expect(
      await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } }).then((r) => r.patch),
    ).toEqual({ blockedByAdd: [`${TEMP_REF_PREFIX}${firstId}`] });
  });

  it('REFUSES a correction that names no proposal, through the transport', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, secondId } = await planWithTwoAdds(client, fx);

    const result = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}nothing`,
    });
    // Typed and readable — not a JSON-RPC internal error carrying ORM prose.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('UNRESOLVED_PLAN_REF');
  });

  it('withdraws a proposal, and REFUSES one a sibling still references', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
    });

    const refused = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: firstId,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('PLAN_PROPOSAL_REFERENCED');
    expect(textOf(refused)).toContain(secondId);

    // Clear the reference, then it withdraws.
    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      blockedByRefs: [],
    });
    const ok = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: firstId,
    });
    expect(ok.isError).toBeFalsy();
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REFUSES both once the plan is approved, naming the status and the work item', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, secondId } = await planWithTwoAdds(client, fx);
    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });

    const { plansService } = await import('@/lib/services/plansService');
    await plansService.approvePlan(planId, fx.ctx);

    const correction = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      title: 'Too late',
    });
    expect(correction.isError).toBe(true);
    expect(textOf(correction)).toContain('PLAN_NOT_EDITABLE');
    expect(textOf(correction)).toContain('update_work_item');

    const withdraw = await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
    });
    expect(withdraw.isError).toBe(true);
    expect(textOf(withdraw)).toContain('PLAN_NOT_EDITABLE');
  });

  it('creates NO work item — the property the whole surface rests on', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${TEMP_REF_PREFIX}${firstId}`,
      title: 'Renamed',
    });
    await call(client, WITHDRAW_PLAN_PROPOSAL_TOOL_NAME, { planId, planItemId: secondId });

    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });
});

describe('the deepen tool is untouched', () => {
  it('`update_plan_item` still cannot reach the structural fields', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    const deepen = tools.find((t) => t.name === UPDATE_PLAN_ITEM_TOOL_NAME)!;
    const props = Object.keys(
      (deepen.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(props).not.toContain('parentRef');
    expect(props).not.toContain('blockedByRefs');
    expect(props).not.toContain('targetRepo');
    expect(props).not.toContain('patch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A ref written as a `MOTIR-<n>` KEY, on the CORRECTION door (MOTIR-3934)
// ─────────────────────────────────────────────────────────────────────────────

describe('update_plan_proposal — a ref written as a `MOTIR-<n>` KEY (MOTIR-3934)', () => {
  // The defect this closes: `add_plan_items` resolves a key at every one of the
  // five ref sites (MOTIR-3576 / MOTIR-3859) and the CORRECTION door resolved at
  // none of them. It stored the raw `"MOTIR-3884"`, which nothing downstream can
  // match — the projection reported the plan invalid, and approve refused with
  // `INVALID_PLAN_REF_GRAPH · dangling`, in front of a reviewer, on a plan
  // somebody had already read. That is exactly the moment MOTIR-3533's
  // append-time refusal exists to move the error away from.
  //
  // The tool's own schema advertises three accepted forms — a key, a real id and
  // a `planItem:` ref. One door honoured all three; the other honoured two and
  // silently corrupted the third.

  /** The structural columns a plan actually stored, past the service. */
  async function stored(planItemId: string) {
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: planItemId } });
    return {
      parentRef: row.parentRef,
      blockedByRefs: row.blockedByRefs,
      patch: row.patch as {
        parentRef?: string;
        blockedByAdd?: string[];
        blockedByRemove?: string[];
      } | null,
    };
  }

  /** A `generating` plan, opened through the transport. */
  async function openPlan(client: Client, fx: WorkItemFixture): Promise<string> {
    const created = await call(client, CREATE_PLAN_TOOL_NAME, {
      projectKey: fx.projectIdentifier,
      title: 'A plan whose refs are written as keys',
      plannedWithHarness: 'Claude Code',
      plannedWithModel: 'claude-opus-5',
    });
    return (created.structuredContent as unknown as { id: string }).id;
  }

  const idsOf = (r: CallToolResult): string[] =>
    (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

  it('⚠️ THE FIXTURE: the SAME edge through BOTH doors stores the SAME value', async () => {
    // The measurement the card was filed from, as a test: four `modify`
    // proposals in one plan, three appended and one corrected. Three stored the
    // work item's id; the corrected one stored the key verbatim.
    const fx = await makeWorkItemFixture();
    const viaAppend = await createTestWorkItem(fx, { kind: 'task', title: 'Corrected by append' });
    const viaCorrection = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Corrected by the correction door',
    });
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'The blocker' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'modify', workItemId: viaAppend.id, patch: { blockedByAdd: [blocker.identifier] } },
        { op: 'modify', workItemId: viaCorrection.id, patch: { priority: 'low' } },
      ],
    });
    const [appendedId, correctedId] = idsOf(appended);

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: correctedId,
      patch: { blockedByAdd: [blocker.identifier] },
    });
    expect(corrected.isError).toBeFalsy();

    // The whole bug in one assertion: the two doors write the same field, so the
    // stored value cannot depend on which one the author reached for.
    expect((await stored(correctedId!)).patch?.blockedByAdd).toEqual([blocker.id]);
    expect((await stored(correctedId!)).patch?.blockedByAdd).toEqual(
      (await stored(appendedId!)).patch?.blockedByAdd,
    );
  });

  it('resolves a key in `patch.blockedByRemove` — the field the defect was FOUND on', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'The blocker' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
    });
    const modifyId = idsOf(appended)[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByRemove: [blocker.identifier] },
    });
    expect(corrected.isError).toBeFalsy();
    expect((await stored(modifyId)).patch?.blockedByRemove).toEqual([blocker.id]);
  });

  it('resolves a key in `patch.parentRef` — the RE-PARENT site', async () => {
    const fx = await makeWorkItemFixture();
    const home = await createTestWorkItem(fx, { kind: 'story', title: 'Where it is' });
    const destination = await createTestWorkItem(fx, { kind: 'story', title: 'Where it belongs' });
    const card = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'The card',
      parentId: home.id,
    });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: card.id, patch: { priority: 'low' } }],
    });
    const modifyId = idsOf(appended)[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { parentRef: destination.identifier },
    });
    expect(corrected.isError).toBeFalsy();
    expect((await stored(modifyId)).patch?.parentRef).toBe(destination.id);
  });

  it('resolves keys in the TOP-LEVEL `parentRef` and `blockedByRefs` of an `add`', async () => {
    // The card's third criterion: the same normalisation on every field the
    // correction door reaches, not only the one the bug was found on.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'The blocker' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: 'Its subtask', kind: 'subtask' } }],
    });
    const addId = idsOf(appended)[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId,
      parentRef: story.identifier,
      blockedByRefs: [blocker.identifier],
    });
    expect(corrected.isError).toBeFalsy();

    const row = await stored(addId);
    expect(row.parentRef).toBe(story.id);
    expect(row.blockedByRefs).toEqual([blocker.id]);
  });

  it('is case-INSENSITIVE, and leaves an ID and a `planItem:` temp-ref UNTOUCHED', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const client = await connectClient(fx.ctx);
    const { planId, firstId, secondId } = await planWithTwoAdds(client, fx);

    const lowercased = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: story.identifier.toLowerCase(),
      blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
    });
    expect(lowercased.isError).toBeFalsy();

    const row = await stored(secondId);
    expect(row.parentRef).toBe(story.id);
    // A cuid has no dash and a temp-ref is excluded outright, so the
    // discriminator misclassifies neither.
    expect(row.blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${firstId}`]);

    const byId = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: story.id,
    });
    expect(byId.isError).toBeFalsy();
    expect((await stored(secondId)).parentRef).toBe(story.id);
  });

  it('⚠️ REFUSES a key that names no work item — at the CORRECTION call, not at approve', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { planId, secondId } = await planWithTwoAdds(client, fx);
    const before = await stored(secondId);

    const refused = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: secondId,
      parentRef: `${fx.projectIdentifier}-999999`,
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('999999');
    // A refusal leaves the proposal byte-identical.
    expect(await stored(secondId)).toEqual(before);

    // ⚠️ THE SAME TYPED ERROR `add_plan_items` RAISES — asserted by driving the
    // same dangling key through the OTHER door and comparing, rather than
    // against a literal, so the two cannot drift into two failure modes a
    // caller has to tell apart.
    const appendRefused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'add',
          proposedFields: { title: 'Hangs off nothing', kind: 'task' },
          parentRef: `${fx.projectIdentifier}-999999`,
        },
      ],
    });
    expect(appendRefused.isError).toBe(true);
    expect(textOf(refused)).toBe(textOf(appendRefused));
  });

  it('REFUSES a dangling key in a `modify` patch too, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
    });
    const modifyId = idsOf(appended)[0]!;

    const refused = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByRemove: [`${fx.projectIdentifier}-999999`] },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('999999');
    expect((await stored(modifyId)).patch).toEqual({ priority: 'low' });

    // Same door-to-door equality as above, on the patch site this bug was found
    // on rather than on the top-level one.
    const appendRefused = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { blockedByRemove: [`${fx.projectIdentifier}-999999`] },
        },
      ],
    });
    expect(appendRefused.isError).toBe(true);
    expect(textOf(refused)).toBe(textOf(appendRefused));
  });

  it('a removal naming an edge that does NOT exist stays a no-op, not an error', async () => {
    // A defensive sweep must not be punished: the ref RESOLVES (the work item is
    // real), there simply is no such edge on the target. It removes nothing and
    // approve succeeds.
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The target' });
    const neverABlocker = await createTestWorkItem(fx, { kind: 'task', title: 'Not a blocker' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
    });
    const modifyId = idsOf(appended)[0]!;

    const corrected = await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByRemove: [neverABlocker.identifier] },
    });
    expect(corrected.isError).toBeFalsy();
    expect((await stored(modifyId)).patch?.blockedByRemove).toEqual([neverABlocker.id]);

    await call(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId, proposals: [], final: true });
    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');
  });

  it('⚠️ THE REGRESSION THIS CARD IS: a corrected key-form plan CLOSES and APPROVES', async () => {
    // End to end, the shape the card measured. A `modify` whose edge removal was
    // written through the CORRECTION door with a key: it used to close to
    // `planned` and then fail at the approve button with `dangling`.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'The story' });
    const blocker = await createTestWorkItem(fx, { kind: 'task', title: 'The blocker' });
    const dependent = await createTestWorkItem(fx, { kind: 'task', title: 'The dependent' });
    await createTestWorkItem(fx, { kind: 'task', title: 'Unused' });
    const client = await connectClient(fx.ctx);
    const planId = await openPlan(client, fx);

    // The edge exists on the live tree, so the removal has something to remove.
    await adminDb.workItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        fromId: dependent.id,
        toId: blocker.id,
        kind: 'is_blocked_by',
        createdById: fx.ownerId,
      },
    });

    const appended = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [
        { op: 'add', proposedFields: { title: 'A new subtask', kind: 'subtask' } },
        { op: 'modify', workItemId: dependent.id, patch: { priority: 'low' } },
      ],
    });
    const [addId, modifyId] = idsOf(appended);

    // BOTH doors' worth of correction, all in the key form.
    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: addId,
      parentRef: story.identifier,
      blockedByRefs: [blocker.identifier],
    });
    await call(client, UPDATE_PLAN_PROPOSAL_TOOL_NAME, {
      planId,
      planItemId: modifyId,
      patch: { blockedByRemove: [blocker.identifier] },
    });

    const closed = await call(client, ADD_PLAN_ITEMS_TOOL_NAME, {
      planId,
      proposals: [],
      final: true,
    });
    expect(closed.isError).toBeFalsy();

    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');

    // The `add` materialized under the right parent, blocked by the right item.
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'A new subtask' },
    });
    expect(created.parentId).toBe(story.id);
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: created.id, toId: blocker.id, kind: 'is_blocked_by' },
      }),
    ).toBe(1);

    // And the removal actually landed — the edge the correction named is gone.
    expect(
      await adminDb.workItemLink.count({
        where: { fromId: dependent.id, toId: blocker.id, kind: 'is_blocked_by' },
      }),
    ).toBe(0);
  });
});
