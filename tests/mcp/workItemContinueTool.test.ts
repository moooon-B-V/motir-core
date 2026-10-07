import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  dispatchStopReasonSchema,
  presentWorkItemContinueClaim,
} from '@/lib/api/v1/workLoop/schema';
import {
  CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME,
  CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME,
  TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME,
  runClaimWorkItemContinue,
  runCloseWorkItemContinue,
  runTouchWorkItemContinue,
} from '@/lib/mcp/tools/workItemContinue';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { toToolError } from '@/lib/mcp/toolResult';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { parseFindingsPolicy } from '@/lib/dispatch/promptTemplate';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { usersService } from '@/lib/services/usersService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// MOTIR-7262 — the three CONTINUE tools, entered at the TOOL ADAPTER, over real
// Postgres: the key resolution, the claim DTO passthrough, the ownership refusal
// on touch and close, and `dispatch_prompt`'s `continueFrom`. The same calls
// through the real MCP transport — parity with REST across two doors, the
// liveness sweep — are the story's gate (MOTIR-7264).
//
// Each case is chosen so the obvious broken adapter fails it:
//
//   1. PARITY is asserted against v1's presenter over the SAME run (a `mine`
//      re-claim) — an adapter that hand-built its payload fails the equality.
//   2. The claim BEATS once — an adapter that called `claimContinue` bare leaves
//      `lastHeartbeatAt` null, and the run on the 12-hour age reap.
//   3. Touch and close on ANOTHER user's run are refused AND the row is
//      unchanged — an adapter that passed only `runId` to `close` would close it.
//   4. A second close returns the FIRST close's stop reason — an adapter that
//      re-closed would raise DISPATCH_RUN_TERMINAL, one that overwrote would
//      change it.
//   5. `continueFrom` reaches the service — an adapter that dropped it renders
//      the fresh prompt, and a bad run would not be refused.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function member(
  fx: WorkItemFixture,
  name: string,
): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `${name.toLowerCase().replace(/\W/g, '')}+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An In Progress task with ONE local run over it that checked out a branch and
 *  then went silent seven minutes ago — past the five-minute lapse. */
async function deadCard(fx: WorkItemFixture, title = 'a card whose run died') {
  const card = await createTestWorkItem(fx, { kind: 'task', title });
  await setStatus(card.id, 'in_progress');
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      cards: [{ key: card.identifier, disposition: 'queued' }],
    },
    fx.ctx,
  );
  const branch = `subtask/${card.identifier}-work`;
  await dispatchRunService.appendEvents(
    run.id,
    [
      {
        kind: 'checkout_ready',
        workItemKey: card.identifier,
        disposition: 'running',
        data: { branch },
      },
    ],
    fx.ctx,
  );
  await adminDb.dispatchRun.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 7 * 60_000) },
  });
  return { card, deadRunId: run.id, branch };
}

function ok<T>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function errorCode(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  return text(result).split(':')[0] as string;
}

interface ClaimOut {
  outcome: string;
  reason: string | null;
  runId: string | null;
  branch: string | null;
  holder: { id: string; name: string } | null;
  deadRun: { id: string } | null;
}
interface RunOut {
  key: string;
  runId: string;
  open: boolean;
  status: string;
  stopReason: string | null;
  lastHeartbeatAt: string | null;
}

/** `dispatch_prompt`'s adapter throws and its `registerTool` wrapper maps the
 *  error — the same `toToolError` the transport answers with. */
const viaWrapper = (p: Promise<CallToolResult>) => p.catch(toToolError);

const runRow = (id: string) => adminDb.dispatchRun.findUniqueOrThrow({ where: { id } });

describe('the registry sites', () => {
  it('registers all three tools, gated work_item:edit, inside the CLI grant', () => {
    for (const name of [
      CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME,
      TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME,
      CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME,
    ] as const) {
      expect(MCP_TOOL_NAMES).toContain(name);
      expect(TOOL_PERMISSIONS[name]).toBe('work_item:edit');
    }
    expect(CLI_TOKEN_GRANT).toContain('work_item:edit');
    expect(Object.keys(EXEMPT_TOOLS)).not.toContain(CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME);
    expect(Object.keys(EXEMPT_TOOLS)).toContain(TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME);
    expect(Object.keys(EXEMPT_TOOLS)).toContain(CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME);
  });
});

describe('claim_work_item_continue', () => {
  it('claims by a lower-case key and answers exactly what v1’s presenter answers', async () => {
    const fx = await makeWorkItemFixture();
    const { card, deadRunId, branch } = await deadCard(fx);

    const claimed = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: card.identifier.toLowerCase() }, fx.ctx),
    );
    expect(claimed).toMatchObject({ outcome: 'claimed', reason: null, branch });
    expect(claimed.deadRun?.id).toBe(deadRunId);

    // The SAME run read twice: the tool's `mine` against the presenter's `mine`.
    const viaTool = ok<ClaimOut>(await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx));
    const viaService = presentWorkItemContinueClaim(
      await workItemContinueService.claimContinue(fx.projectId, card.identifier, fx.ctx),
    );
    expect(viaTool.outcome).toBe('mine');
    expect(viaTool).toEqual(JSON.parse(JSON.stringify(viaService)));
    expect(viaTool.runId).toBe(claimed.runId);
  });

  it('beats once on the claim, so the run sits on the five-minute lapse rule', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const claimed = ok<ClaimOut>(await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx));
    const row = await runRow(claimed.runId!);
    expect(row.command).toBe('continue');
    expect(row.lastHeartbeatAt).not.toBeNull();
  });

  it('answers `taken` to a second member, naming the holder, and opens nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const jo = await member(fx, 'Jo Pace');
    const first = ok<ClaimOut>(await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx));

    const second = await runClaimWorkItemContinue({ key: card.identifier }, jo.ctx);
    expect(ok<ClaimOut>(second)).toMatchObject({ outcome: 'taken', holder: { id: fx.ownerId } });
    expect(text(second)).toMatch(/Do NOT push/);
    expect(
      await adminDb.dispatchRun.count({ where: { command: 'continue', status: 'running' } }),
    ).toBe(1);
    expect(first.outcome).toBe('claimed');
  });

  it('refuses as a RESULT: no dead run, and a card whose pull request is open', async () => {
    const fx = await makeWorkItemFixture();
    const fresh = await createTestWorkItem(fx, { kind: 'task', title: 'never run' });
    await setStatus(fresh.id, 'in_progress');
    expect(
      ok<ClaimOut>(await runClaimWorkItemContinue({ key: fresh.identifier }, fx.ctx)),
    ).toMatchObject({ outcome: 'not_continuable', reason: 'no_dead_run', runId: null });

    const { card } = await deadCard(fx, 'its PR is open');
    await setStatus(card.id, 'implemented');
    expect(
      ok<ClaimOut>(await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx)),
    ).toMatchObject({ outcome: 'not_continuable', reason: 'use_fix' });
    expect(await adminDb.dispatchRun.count({ where: { command: 'continue' } })).toBe(0);
  });

  it('a card the token cannot see is WORK_ITEM_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    expect(
      errorCode(await runClaimWorkItemContinue({ key: `${fx.projectIdentifier}-9999` }, fx.ctx)),
    ).toBe('WORK_ITEM_NOT_FOUND');
  });
});

describe('touch_work_item_continue', () => {
  it('moves the heartbeat of the caller’s own open run', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const { runId } = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx),
    );
    await adminDb.dispatchRun.update({
      where: { id: runId! },
      data: { lastHeartbeatAt: new Date(Date.now() - 60_000) },
    });
    const before = (await runRow(runId!)).lastHeartbeatAt!;

    const touched = ok<RunOut>(
      await runTouchWorkItemContinue({ key: card.identifier, runId: runId! }, fx.ctx),
    );
    expect(touched).toMatchObject({ key: card.identifier, runId, open: true, stopReason: null });
    expect((await runRow(runId!)).lastHeartbeatAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it('refuses another member’s run and writes nothing; an unknown run is NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const jo = await member(fx, 'Jo Pace');
    const { runId } = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx),
    );
    const before = await runRow(runId!);

    expect(
      errorCode(await runTouchWorkItemContinue({ key: card.identifier, runId: runId! }, jo.ctx)),
    ).toBe('CONTINUE_RUN_NOT_YOURS');
    expect(
      errorCode(
        await runCloseWorkItemContinue(
          { key: card.identifier, runId: runId!, outcome: 'completed' },
          jo.ctx,
        ),
      ),
    ).toBe('CONTINUE_RUN_NOT_YOURS');
    expect(await runRow(runId!)).toEqual(before);

    expect(
      errorCode(
        await runTouchWorkItemContinue({ key: card.identifier, runId: 'run_nope' }, fx.ctx),
      ),
    ).toBe('CONTINUE_RUN_NOT_FOUND');
  });

  it('refuses a run that is not a continue of THIS card', async () => {
    const fx = await makeWorkItemFixture();
    const { card, deadRunId } = await deadCard(fx);
    const { card: other } = await deadCard(fx, 'another dead card');
    const { runId } = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: other.identifier }, fx.ctx),
    );
    // Another card's continue run, and this card's own (non-continue) dead run.
    for (const id of [runId!, deadRunId]) {
      expect(
        errorCode(await runTouchWorkItemContinue({ key: card.identifier, runId: id }, fx.ctx)),
      ).toBe('CONTINUE_RUN_NOT_FOUND');
    }
  });
});

describe('close_work_item_continue', () => {
  it('closes with the stop reason given, idempotently, and a touch then reads it closed', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const { runId } = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx),
    );

    const closed = ok<RunOut>(
      await runCloseWorkItemContinue(
        { key: card.identifier, runId: runId!, outcome: 'completed' },
        fx.ctx,
      ),
    );
    expect(closed).toMatchObject({ open: false, stopReason: 'completed' });
    const row = await runRow(runId!);
    expect(row.stopReason).toBe('completed');
    expect(row.endedAt).not.toBeNull();

    // A retry with a DIFFERENT outcome returns the first close, unchanged.
    const again = ok<RunOut>(
      await runCloseWorkItemContinue(
        { key: card.identifier, runId: runId!, outcome: 'halted' },
        fx.ctx,
      ),
    );
    expect(again).toEqual(closed);
    expect(await runRow(runId!)).toEqual(row);

    const touched = await runTouchWorkItemContinue({ key: card.identifier, runId: runId! }, fx.ctx);
    expect(ok<RunOut>(touched)).toMatchObject({ open: false, stopReason: 'completed' });
    expect(text(touched)).toMatch(/STOP pushing/);
  });

  it('accepts the whole stop-reason set the REST close body accepts', () => {
    expect(dispatchStopReasonSchema.options).toEqual([
      'drained',
      'completed',
      'max',
      'halted',
      'interrupted',
      'replanned',
      'gated',
      'abandoned',
    ]);
  });
});

describe('dispatch_prompt continueFrom', () => {
  it('renders the continue prompt the service renders for the same run', async () => {
    const fx = await makeWorkItemFixture();
    const { card, deadRunId, branch } = await deadCard(fx);
    await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx);

    const viaTool = ok<{ branch: string | null; prompt: string }>(
      await runDispatchPrompt({ key: card.identifier, continueFrom: deadRunId }, fx.ctx),
    );
    const viaService = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
      {
        sessionBranch: null,
        findingsPolicy: parseFindingsPolicy(undefined).policy!,
        continueFrom: deadRunId,
      },
    );
    expect(viaTool.branch).toBe(branch);
    expect(viaTool.prompt).toBe(viaService.prompt);

    // Without it, the fresh prompt — so the parameter is what changed it.
    const fresh = ok<{ prompt: string }>(await runDispatchPrompt({ key: card.identifier }, fx.ctx));
    expect(fresh.prompt).not.toBe(viaTool.prompt);
  });

  it('refuses a run that cannot be continued with CONTINUE_FROM_INVALID', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const { runId } = ok<ClaimOut>(
      await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx),
    );
    // The continue run itself is still running.
    expect(
      errorCode(
        await viaWrapper(runDispatchPrompt({ key: card.identifier, continueFrom: runId! }, fx.ctx)),
      ),
    ).toBe('CONTINUE_FROM_INVALID');
    expect(
      errorCode(
        await viaWrapper(
          runDispatchPrompt({ key: card.identifier, continueFrom: 'run_nope' }, fx.ctx),
        ),
      ),
    ).toBe('CONTINUE_FROM_INVALID');
  });
});

describe('what the agent reads — each outcome said as an instruction', () => {
  it('claimed / mine name the branch, the run to touch and the dead run to continue from', async () => {
    const fx = await makeWorkItemFixture();
    const { card, deadRunId, branch } = await deadCard(fx);
    const claimed = await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx);
    const { runId } = ok<ClaimOut>(claimed);
    expect(text(claimed)).toContain(`branch ${branch}`);
    expect(text(claimed)).toContain(`continueFrom ${deadRunId}`);
    expect(text(claimed)).toContain(`runId ${runId}`);
    const mine = await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx);
    expect(text(mine)).toMatch(/RESUME, not a lost race/);
  });

  it('taken says who and since when, and not to push', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const jo = await member(fx, 'Jo Pace');
    await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx);
    const taken = text(await runClaimWorkItemContinue({ key: card.identifier }, jo.ctx));
    expect(taken).toContain(fx.owner.name);
    expect(taken).toMatch(/\(since \d{4}-/);
  });

  it('each refusal says what to do instead', async () => {
    const fx = await makeWorkItemFixture();
    const jo = await member(fx, 'Jo Pace');

    // run_alive — the run heard a minute ago, by its dispatcher.
    const alive = await createTestWorkItem(fx, { kind: 'task', title: 'alive' });
    await setStatus(alive.id, 'in_progress');
    await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        cards: [{ key: alive.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    expect(text(await runClaimWorkItemContinue({ key: alive.identifier }, jo.ctx))).toMatch(
      /still alive/,
    );

    // continue_the_parent — names the parent to claim instead.
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const leg = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'a leg',
      parentId: story.id,
    });
    await setStatus(leg.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: [{ key: leg.identifier, disposition: 'queued' }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'halted' }, fx.ctx);
    expect(text(await runClaimWorkItemContinue({ key: leg.identifier }, fx.ctx))).toContain(
      `Claim the continue of ${story.identifier} instead`,
    );

    // Any other reason is named.
    const never = await createTestWorkItem(fx, { kind: 'task', title: 'never run' });
    await setStatus(never.id, 'in_progress');
    expect(text(await runClaimWorkItemContinue({ key: never.identifier }, fx.ctx))).toContain(
      '(no_dead_run)',
    );
  });

  it('a run that stopped at a gate: refused while it waits or was sent back, claimed as a RESUME once approved (MOTIR-7708)', async () => {
    const fx = await makeWorkItemFixture();
    const gatedCard = async (
      title: string,
      state: 'awaiting' | 'changes_requested' | 'approved' | null,
    ) => {
      const card = await createTestWorkItem(fx, { kind: 'task', title });
      await setStatus(card.id, 'in_progress');
      await adminDb.workItem.update({ where: { id: card.id }, data: { assigneeId: fx.ownerId } });
      const { run } = await dispatchRunService.open(
        {
          projectKey: fx.projectIdentifier,
          command: 'run',
          reportedBy: 'cli',
          cards: [{ key: card.identifier, disposition: 'queued' }],
        },
        fx.ctx,
      );
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'checkout_ready',
            workItemKey: card.identifier,
            disposition: 'running',
            data: { branch: `subtask/${card.identifier}-work` },
          },
        ],
        fx.ctx,
      );
      await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
      if (state === null) return card;
      const gate = await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: card.id,
          kind: 'design_result',
          subjectId: `subject-${randomToken()}`,
          state,
          ...(state === 'awaiting' ? {} : { decidedById: fx.ownerId, decidedAt: new Date() }),
        },
      });
      await adminDb.dispatchRunHeldGate.create({
        data: {
          workspaceId: fx.workspaceId,
          dispatchRunId: run.id,
          gateId: gate.id,
          workItemId: card.id,
          kind: 'design_result',
        },
      });
      return card;
    };

    const waiting = await gatedCard('still waiting', 'awaiting');
    expect(text(await runClaimWorkItemContinue({ key: waiting.identifier }, fx.ctx))).toContain(
      `still waiting for approval (${waiting.identifier} design_result (awaiting))`,
    );
    const sentBack = await gatedCard('sent back', 'changes_requested');
    expect(text(await runClaimWorkItemContinue({ key: sentBack.identifier }, fx.ctx))).toContain(
      'was sent back, not approved',
    );
    const approved = await gatedCard('approved', 'approved');
    const resumed = text(await runClaimWorkItemContinue({ key: approved.identifier }, fx.ctx));
    expect(resumed).toContain(`Claimed the RESUME of ${approved.identifier}`);
    expect(resumed).toContain(`${approved.identifier} design_result (approved)`);
    // A gated run that recorded no gates resumes too, and says so.
    const unrecorded = await gatedCard('no gates recorded', null);
    expect(text(await runClaimWorkItemContinue({ key: unrecorded.identifier }, fx.ctx))).toContain(
      'now approved: none recorded',
    );
  });

  it('a PARENT continue names what already landed and what is still to run', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'the story' });
    const landed = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'first',
      parentId: story.id,
    });
    const inFlight = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'second',
      parentId: story.id,
    });
    await setStatus(story.id, 'in_progress');
    await setStatus(landed.id, 'implemented');
    await setStatus(inFlight.id, 'in_progress');
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: [landed, inFlight].map((c) => ({
          key: c.identifier,
          disposition: 'queued' as const,
        })),
      },
      fx.ctx,
    );
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'card_settled',
          workItemKey: landed.identifier,
          disposition: 'integrated',
          sessionBranch: 'motir/auto-20260927-0900',
        },
      ],
      fx.ctx,
    );
    await adminDb.dispatchRun.update({
      where: { id: run.id },
      data: { lastHeartbeatAt: new Date(Date.now() - 8 * 60_000) },
    });

    const result = await runClaimWorkItemContinue({ key: story.identifier }, fx.ctx);
    expect(ok<{ mode: string }>(result).mode).toBe('parent');
    expect(text(result)).toContain(`already landed ${landed.identifier}`);
    expect(text(result)).toContain(`still to run ${inFlight.identifier}`);
    // The leg's continue run is the story's own — touch and close accept it from the leg.
    const { runId } = ok<ClaimOut>(result);
    expect(
      ok<RunOut>(
        await runTouchWorkItemContinue({ key: inFlight.identifier, runId: runId! }, fx.ctx),
      ).open,
    ).toBe(true);
  });

  it('names the open pull request a branch heads, and says `none` for an empty scope list', async () => {
    const fx = await makeWorkItemFixture();
    const { card } = await deadCard(fx);
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    const pr = await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/the-pr-head',
      baseRef: 'main',
      checks: {},
    });
    expect(text(await runClaimWorkItemContinue({ key: card.identifier }, fx.ctx))).toContain(
      `open pull request https://github.com/acme/${repo.name}/pull/${pr.number}`,
    );

    // Two dead scope runs: one whose only leg is in flight, one whose only leg landed.
    for (const legStatus of ['in_progress', 'implemented'] as const) {
      const story = await createTestWorkItem(fx, { kind: 'story', title: `story ${legStatus}` });
      const leg = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: 'the leg',
        parentId: story.id,
      });
      await setStatus(story.id, 'in_progress');
      await setStatus(leg.id, legStatus);
      const { run } = await dispatchRunService.open(
        {
          projectKey: fx.projectIdentifier,
          command: 'run_scope',
          reportedBy: 'cli',
          scopeKey: story.identifier,
          cards: [{ key: leg.identifier, disposition: 'queued' }],
        },
        fx.ctx,
      );
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'card_settled',
            workItemKey: leg.identifier,
            disposition: legStatus === 'implemented' ? 'integrated' : 'running',
            sessionBranch: `motir/auto-${randomToken(6)}`,
          },
        ],
        fx.ctx,
      );
      await adminDb.dispatchRun.update({
        where: { id: run.id },
        data: { lastHeartbeatAt: new Date(Date.now() - 8 * 60_000) },
      });
      const said = text(await runClaimWorkItemContinue({ key: story.identifier }, fx.ctx));
      expect(said).toContain(
        legStatus === 'in_progress' ? 'already landed none' : 'still to run none',
      );
    }
  });
});
