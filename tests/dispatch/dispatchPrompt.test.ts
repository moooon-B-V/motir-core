import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DISPATCH_PROMPT_TOOL_NAME, runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { toolScope } from '@/lib/mcp/scopes';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The DISPATCH-PROMPT surface over REAL Postgres (Story 7.9 · MOTIR-1802) — the
// server-generated prompt the BYOK CLI prints byte-for-byte (MOTIR-881).
//
// The grammar itself is unit-tested purely in `promptTemplate.test.ts`; THIS file
// pins the half that can only be wrong against real state:
//   1. A real card's title / description / acceptance criteria / context refs and
//      its resolved parent + dependencies actually reach the prompt.
//   2. The GIT WORKFLOW variant is chosen SERVER-SIDE from the item's inherited
//      session lineage — and the caller has no input that can change it.
//   3. `targetRepo` resolves against the workspace's connected repo set, the same
//      way the ready dispatch payload resolves it (MOTIR-1804).
//   4. The tool honors access exactly like its siblings — a cross-tenant key and
//      an unknown key are indistinguishable — and it is a pure READ.
//   5. The prompt is a pure function of server state: two calls are byte-identical.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const CARD = [
  'Assemble the canonical prompt from the work item.',
  '',
  '## Acceptance criteria',
  '',
  '- Every section is present.',
  '- The variant is server-chosen.',
  '',
  '## Context refs',
  '',
  '- `lib/dispatch/promptTemplate.ts` — the grammar',
].join('\n');

/** Connect one repo to the fixture's workspace — the 7.10.3 installation mirror
 *  that `targetRepo` resolves against (same shape as `dispatchTargetRepo.test.ts`). */
async function connectRepo(fx: WorkItemFixture, name: string): Promise<void> {
  const inst = await db.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  await db.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      repoId: `repo-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
}

const struct = (r: CallToolResult) => r.structuredContent as unknown as DispatchPromptDto;

/** Connect an in-memory MCP client to a server bound to `ctx` (no scope gate) —
 *  the `tool-coverage.test.ts` pattern, so the REGISTERED tool is exercised
 *  including its `toToolError` wrapper. */
async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'dispatch-prompt', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(client: Client, key: string): Promise<CallToolResult> {
  return (await client.callTool({
    name: DISPATCH_PROMPT_TOOL_NAME,
    arguments: { key },
  })) as CallToolResult;
}

describe('dispatchPromptService.getDispatchPrompt — over real state', () => {
  it('interpolates the real card: title, body, acceptance criteria, refs, parent, deps', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Dispatch prompt story' },
      fx.ctx,
    );
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Landed first' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        title: 'Server-side prompt assembly',
        parentId: parent.id,
        descriptionMd: CARD,
        type: 'code',
        executor: 'coding_agent',
        storyPoints: 8,
        estimateMinutes: 90,
      },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );

    expect(dto.key).toBe(item.identifier);
    expect(dto.prompt).toContain(`You are executing Subtask ${item.identifier}:`);
    expect(dto.prompt).toContain('Server-side prompt assembly');
    expect(dto.prompt).toContain('Assemble the canonical prompt from the work item.');
    expect(dto.prompt).toContain('- Every section is present.');
    expect(dto.prompt).toContain('    - lib/dispatch/promptTemplate.ts');
    expect(dto.prompt).toContain(`- Parent: ${parent.identifier} — Dispatch prompt story`);
    expect(dto.prompt).toContain(`- Depends on (already landed): ${blocker.identifier}`);
    expect(dto.prompt).toContain('- Sizing: 8 story points · ~90 min');
    // All four sections, from a REAL card.
    for (const heading of ['CONTEXT', 'WHAT TO DO', 'ACCEPTANCE CRITERIA', 'GIT WORKFLOW']) {
      expect(dto.prompt).toContain(`\n${heading}`);
    }
  });

  it('is a PURE function of server state — two calls are byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Stable', descriptionMd: CARD },
      fx.ctx,
    );
    const first = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    const second = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(second.prompt).toBe(first.prompt);
    expect(second).toEqual(first);
  });

  it('lists dependency keys in ascending key order, whatever order the links were made', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Dependent' },
      fx.ctx,
    );
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Dep A' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Dep B' },
      fx.ctx,
    );
    // Linked newest-first on purpose — the prompt must still read lowest-key-first.
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: a.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.prompt).toContain(`- Depends on (already landed): ${a.identifier}, ${b.identifier}`);
  });

  it('a manual / human item yields the human-instruction form with no git workflow', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Provision the API key',
        descriptionMd: CARD,
        type: 'manual',
        executor: 'human',
      },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.prompt).toContain('This is a MANUAL work item');
    expect(dto.prompt).not.toContain('\nGIT WORKFLOW');
    expect(dto.workflowMode).toBe('per_item_pr');
    expect(dto.sessionBranch).toBeNull();
  });

  it.each([
    ['design', 'Draw the ACCESS PATH'],
    ['test', 'Make each test fail for the right reason first'],
    ['decision', 'ships a decision, not a survey'],
  ] as const)('a %s item yields its own WHAT TO DO variant', async (type, marker) => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      // `executor` is pinned: `decision` DEFAULTS to `human`
      // (lib/issues/executorDefaults.ts), which is the manual form — this case is
      // about the agent-executed variant of each type, not about that default.
      {
        projectId: fx.projectId,
        kind: 'task',
        title: `A ${type} card`,
        type,
        executor: 'coding_agent',
      },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.prompt).toContain(marker);
  });
});

describe('dispatchPromptService — the GIT WORKFLOW variant is chosen SERVER-SIDE', () => {
  it('an item with an INHERITED session branch gets the session-lineage variant', async () => {
    const fx = await makeWorkItemFixture();
    const dep = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Integrated dep' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Consumer', descriptionMd: CARD },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: dep.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // The dep is INTEGRATED on a session branch awaiting one human review — the
    // real 7.8.11 write path (in_progress first, the only legal edge), not a
    // hand-set column.
    await workItemsService.updateStatus(dep.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(dep.id, 'session/PROD-run', fx.ctx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.workflowMode).toBe('session_lineage');
    expect(dto.sessionBranch).toBe('session/PROD-run');
    expect(dto.prompt).toContain('inherits the session branch session/PROD-run');
    expect(dto.prompt).toContain('mark_integrated');
    expect(dto.prompt).not.toContain('origin/main');
  });

  it('an item with NO lineage gets the per-item-PR variant', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Standalone', descriptionMd: CARD },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.workflowMode).toBe('per_item_pr');
    expect(dto.sessionBranch).toBeNull();
    expect(dto.prompt).toContain('origin/main');
    expect(dto.prompt).not.toContain('mark_integrated');
  });

  it('an ALREADY-integrated item keeps its own lineage instead of being sent back to main', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Already on a branch' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(item.id, 'session/PROD-own', fx.ctx);
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.workflowMode).toBe('session_lineage');
    expect(dto.sessionBranch).toBe('session/PROD-own');
  });

  it('the caller cannot REDIRECT an inherited lineage — the seed is a fallback only', async () => {
    // The narrow contract the `motir auto` seed (MOTIR-882) is allowed to have:
    // an item whose dependency is already integrated somewhere keeps THAT
    // branch, so no caller can strand an integrated chain across two branches.
    const fx = await makeWorkItemFixture();
    const dep = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Integrated dep' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Consumer' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: dep.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.updateStatus(dep.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(dep.id, 'session/PROD-real', fx.ctx);

    const res = await runDispatchPrompt(
      { key: item.identifier, sessionBranch: 'attacker/branch' },
      fx.ctx,
    );
    expect(struct(res).sessionBranch).toBe('session/PROD-real');
    expect(struct(res).prompt).not.toContain('attacker/branch');
  });

  it('the caller cannot redirect an item that is ALREADY integrated on its own branch', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Already on a branch' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(item.id, 'session/PROD-own', fx.ctx);

    const res = await runDispatchPrompt(
      { key: item.identifier, sessionBranch: 'attacker/branch' },
      fx.ctx,
    );
    expect(struct(res).sessionBranch).toBe('session/PROD-own');
  });

  it('the seed DOES apply to an item with no lineage — the unattended run’s first item', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'First of the run', descriptionMd: CARD },
      fx.ctx,
    );
    // Without the seed it is a per-item PR…
    const unseeded = await runDispatchPrompt({ key: item.identifier }, fx.ctx);
    expect(struct(unseeded).workflowMode).toBe('per_item_pr');

    // …and with it, the SAME item joins the run's branch instead.
    const res = await runDispatchPrompt(
      { key: item.identifier, sessionBranch: 'motir/auto-20260729-010203' },
      fx.ctx,
    );
    expect(struct(res).workflowMode).toBe('session_lineage');
    expect(struct(res).sessionBranch).toBe('motir/auto-20260729-010203');
    expect(struct(res).prompt).toContain('inherits the session branch motir/auto-20260729-010203');
    expect(struct(res).prompt).not.toContain('origin/main');
  });

  it('a MANUAL item ignores the seed entirely — it has no branch to join', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Human work', type: 'manual' },
      fx.ctx,
    );
    const res = await runDispatchPrompt(
      { key: item.identifier, sessionBranch: 'motir/auto-20260729-010203' },
      fx.ctx,
    );
    expect(struct(res).workflowMode).toBe('per_item_pr');
    expect(struct(res).sessionBranch).toBeNull();
    expect(struct(res).prompt).not.toContain('motir/auto-20260729-010203');
  });

  it('the MODE and the REPO stay unselectable — only the branch SEED is an input', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Fixed variant' },
      fx.ctx,
    );
    const res = await runDispatchPrompt(
      // Neither key is in the schema; they must have no effect.
      { key: item.identifier, workflowMode: 'session_lineage', targetRepo: 'evil' } as {
        key: string;
      },
      fx.ctx,
    );
    expect(struct(res).workflowMode).toBe('per_item_pr');
    expect(struct(res).sessionBranch).toBeNull();
    expect(struct(res).targetRepo).not.toBe('evil');
  });

  it('rejects a branch seed that is not a safe git ref, at the schema boundary', async () => {
    // The seed is interpolated into prompt text that instructs an agent to run
    // `git … origin/<branch>`, so a name carrying whitespace, a shell
    // metacharacter or a leading dash never reaches the assembler.
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Seed validation' },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    for (const bad of ['main; rm -rf /', '--upload-pack=evil', 'a branch', '$(whoami)']) {
      const res = (await client.callTool({
        name: DISPATCH_PROMPT_TOOL_NAME,
        arguments: { key: item.identifier, sessionBranch: bad },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
    }
    // A real branch name passes the same gate.
    const ok = (await client.callTool({
      name: DISPATCH_PROMPT_TOOL_NAME,
      arguments: { key: item.identifier, sessionBranch: 'motir/auto-20260729-010203' },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
  });
});

describe('dispatchPromptService — targetRepo resolution', () => {
  it('resolves the workspace’s SINGLE connected repo when the item has no pin', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unpinned' },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.targetRepo).toBe('motir-core');
    expect(dto.prompt).toContain('- Repo: motir-core');
    expect(dto.prompt).toContain('git worktree add ../motir-core-');
  });

  it('honors the item’s explicit pin over the connected-set default', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Pinned', targetRepo: 'motir-ai' },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.targetRepo).toBe('motir-ai');
    expect(dto.prompt).toContain('- Repo: motir-ai');
  });

  it('says so honestly when Motir cannot tell (no connection, no pin) — never a guess', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Unknown repo' },
      fx.ctx,
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(dto.targetRepo).toBeNull();
    expect(dto.prompt).toContain('- Repo: not pinned.');
    expect(dto.prompt).toContain('git worktree add ../<repo>-');
  });
});

describe('dispatch_prompt tool — access + shape', () => {
  it('summarizes for a human and ships the DTO as structuredContent', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Tooled', descriptionMd: CARD },
      fx.ctx,
    );
    const res = await runDispatchPrompt({ key: item.identifier.toLowerCase() }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain(`Dispatch prompt for ${item.identifier}`);
    expect(text).toContain('Repo: motir-core');
    expect(text).toContain('Git workflow: one pull request of its own');
    const dto = struct(res);
    expect(Object.keys(dto).sort()).toEqual([
      'key',
      'prompt',
      'sessionBranch',
      'targetRepo',
      'targetRepoCloneUrl',
      'targetRepoDefaultBranch',
      'workflowMode',
    ]);
    // The routing coordinates (MOTIR-1783) ride the SAME payload as `next_ready`,
    // so a CLI reading either surface handles one shape.
    expect(dto.targetRepoCloneUrl).toBe('https://github.com/moooon/motir-core.git');
    expect(dto.targetRepoDefaultBranch).toBe('main');
    // The summary embeds the prompt, so a human reading the session sees it.
    expect(text).toContain(dto.prompt);
  });

  it('the human summary states an unknown repo rather than implying one', async () => {
    const fx = await makeWorkItemFixture();
    const dep = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Integrated' },
      fx.ctx,
    );
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'No repo' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: item.id, toId: dep.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.updateStatus(dep.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(dep.id, 'session/PROD-sum', fx.ctx);

    const res = await runDispatchPrompt({ key: item.identifier }, fx.ctx);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Repo: not pinned (Motir cannot say)');
    expect(text).toContain('Git workflow: session lineage on session/PROD-sum');
  });

  it('a work item read through ANOTHER workspace’s project id is not found', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const theirItem = await workItemsService.createWorkItem(
      { projectId: theirs.projectId, kind: 'task', title: 'Theirs' },
      theirs.ctx,
    );
    // The service's own tenant guard, reached directly (the tool resolves the
    // project by key first, so this is the defence for any other caller).
    await expect(
      dispatchPromptService.getDispatchPrompt(theirs.projectId, theirItem.identifier, mine.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('is a pure READ — it does not claim the item or change its status', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Untouched' },
      fx.ctx,
    );
    const before = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    await runDispatchPrompt({ key: item.identifier }, fx.ctx);
    const after = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      item.identifier,
      fx.ctx,
    );
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toBe(before.updatedAt);
    // …and it is gated by the read-only scope, so a read-only token can call it.
    expect(toolScope(DISPATCH_PROMPT_TOOL_NAME)).toBe('read');
    expect(MCP_TOOL_NAMES).toContain(DISPATCH_PROMPT_TOOL_NAME);
  });

  it('an UNKNOWN key and a CROSS-TENANT key are indistinguishable (no existence leak)', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Rival', identifier: 'PROD' });
    const theirItem = await workItemsService.createWorkItem(
      { projectId: theirs.projectId, kind: 'task', title: 'Their secret' },
      theirs.ctx,
    );

    // Through the REGISTERED tool over the real transport, so the error the
    // agent actually receives is what is compared (`toToolError`'s `CODE: msg`).
    const client = await connectClient(mine.ctx);
    const crossTenant = await callTool(client, theirItem.identifier);
    const unknown = await callTool(client, 'PROD-99999');

    expect(crossTenant.isError).toBe(true);
    expect(unknown.isError).toBe(true);
    const textOf = (r: CallToolResult) => (r.content as { text: string }[])[0]!.text;
    // Same error code either way — the response cannot tell them apart, and it
    // never echoes the other tenant's title.
    expect(textOf(crossTenant).split(':')[0]).toBe(textOf(unknown).split(':')[0]);
    expect(textOf(crossTenant)).not.toContain('Their secret');
  });

  it('an unknown PROJECT key reads as an error, not a crash', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    expect((await callTool(client, 'NOPE-1')).isError).toBe(true);
  });

  it('is registered on the server and callable by its documented name', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Registered', descriptionMd: CARD },
      fx.ctx,
    );
    const client = await connectClient(fx.ctx);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain(DISPATCH_PROMPT_TOOL_NAME);
    const res = await callTool(client, item.identifier);
    expect(res.isError).toBeFalsy();
    expect(struct(res).prompt).toContain('You are executing Task');
  });
});
