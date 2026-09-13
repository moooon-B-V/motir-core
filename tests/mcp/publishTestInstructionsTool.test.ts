import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { runPublishTestInstructions } from '@/lib/mcp/tools/publishTestInstructions';
import { TEST_INSTRUCTIONS_MAX_STEPS } from '@/lib/testInstructions/caps';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';

// `publish_test_instructions` at the ADAPTER (Story MOTIR-4906 · MOTIR-5331) —
// one case per refusal, each asserting its OWN code and a message that names
// the reason, because an agent refused with a generic error carries on as
// though its instructions landed. The transport, the permission gate and the
// CLI grant are `publishTestInstructionsTransport.test.ts`'s.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SHA = 'f'.repeat(40);

async function connectRepo(fx: WorkItemFixture, owner: string, name: string, link = true) {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${owner}`,
      workspaceId: fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `repo-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  if (link) {
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: repo.id,
      name: `${owner}-${name}`,
    });
  }
  return repo;
}

async function scenario() {
  const fx = await makeWorkItemFixture();
  const card = await createTestWorkItem(fx, { kind: 'task', title: 'Card' });
  const web = await connectRepo(fx, 'acme', 'web');
  return { fx, card, web };
}

function args(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    repo: 'web',
    commitSha: SHA,
    clickPathSteps: ['Open /items/ACME-7'],
    setupCommands: [{ label: 'Install', command: 'pnpm install' }],
    ...over,
  } as Parameters<typeof runPublishTestInstructions>[0];
}

function errorText(res: CallToolResult): string {
  expect(res.isError).toBe(true);
  const first = res.content[0];
  return first && first.type === 'text' ? first.text : '';
}

async function storedRows() {
  return adminDb.testInstructions.findMany();
}

describe('runPublishTestInstructions — success', () => {
  it('stores the record, resolving the repository by bare name or owner/name', async () => {
    const { fx, card, web } = await scenario();

    const byName = await runPublishTestInstructions(args(card.identifier), fx.ctx);
    expect(byName.isError).toBeFalsy();
    expect(byName.structuredContent).toMatchObject({
      workItemKey: card.identifier,
      repoId: web.id,
      commitSha: SHA,
      created: true,
      isCurrent: true,
      dispatchRunId: null,
    });

    const byFull = await runPublishTestInstructions(
      args(card.identifier, { repo: 'ACME/WEB' }),
      fx.ctx,
    );
    expect(byFull.structuredContent).toMatchObject({ created: false });
    expect(await storedRows()).toHaveLength(1);
  });

  it('attributes the record to the RUNNING dispatch run holding a leg for the item, and to none otherwise', async () => {
    const { fx, card } = await scenario();
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Other card' });

    const finished = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        status: 'succeeded',
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });
    const running = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run',
        status: 'running',
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });

    const withRun = await runPublishTestInstructions(args(card.identifier), fx.ctx);
    expect(withRun.structuredContent).toMatchObject({ dispatchRunId: running.id });
    expect(finished.id).not.toBe(running.id);

    // A running run for a DIFFERENT card does not claim this one.
    const withoutRun = await runPublishTestInstructions(args(other.identifier), fx.ctx);
    expect(withoutRun.structuredContent).toMatchObject({ dispatchRunId: null });
  });
});

describe('runPublishTestInstructions — every refusal carries its own code and reason', () => {
  it('an unknown item', async () => {
    const { fx } = await scenario();
    const text = errorText(await runPublishTestInstructions(args('PROD-99999'), fx.ctx));
    expect(text).toMatch(/NOT_FOUND/);
  });

  it('a member whose CUSTOM role lacks work_item:edit', async () => {
    const { fx, card } = await scenario();
    const viewer = await usersService.createUser({
      email: 'viewer@ex.com',
      password: 'hunter2hunter2',
      name: 'Viewer',
    });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    const role = await projectRoleDefinitionService.create({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Reader',
      permissions: ['project:browse', 'comment:add'],
    });
    await projectMembersService.addMember({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'member',
    });
    await projectMembersService.setRole({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: role.id,
    });

    const text = errorText(
      await runPublishTestInstructions(args(card.identifier), {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
      }),
    );
    expect(text).toMatch(/^PERMISSION_DENIED: .*work_item:edit/);
    expect(await storedRows()).toHaveLength(0);
  });

  it('a repository outside the project, naming the valid set', async () => {
    const { fx, card } = await scenario();
    await connectRepo(fx, 'acme', 'stray', false);
    const text = errorText(
      await runPublishTestInstructions(args(card.identifier, { repo: 'stray' }), fx.ctx),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT: /);
    expect(text).toContain('acme/web');
  });

  it('an AMBIGUOUS bare name, which must be given as owner/name', async () => {
    const { fx, card } = await scenario();
    await connectRepo(fx, 'other', 'web');
    const text = errorText(await runPublishTestInstructions(args(card.identifier), fx.ctx));
    expect(text).toMatch(/^TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT: /);
    expect(text).toContain('acme/web');
    expect(text).toContain('other/web');
    const ok = await runPublishTestInstructions(
      args(card.identifier, { repo: 'other/web' }),
      fx.ctx,
    );
    expect(ok.isError).toBeFalsy();
  });

  it('a cap exceeded, naming the field and the limit', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(
        args(card.identifier, {
          clickPathSteps: Array.from({ length: TEST_INSTRUCTIONS_MAX_STEPS + 1 }, () => 'step'),
        }),
        fx.ctx,
      ),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_CAP_EXCEEDED: /);
    expect(text).toContain('clickPathSteps');
    expect(text).toContain(String(TEST_INSTRUCTIONS_MAX_STEPS));
  });

  it('both steps and not-applicable', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(
        args(card.identifier, {
          clickPathNotApplicable: true,
          clickPathNotApplicableReason: 'no UI',
        }),
        fx.ctx,
      ),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_CLICK_PATH_INVALID: .*not both/);
  });

  it('neither steps nor not-applicable', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(args(card.identifier, { clickPathSteps: [] }), fx.ctx),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_CLICK_PATH_INVALID: .*clickPathNotApplicable/);
  });

  it('a malformed field', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(args(card.identifier, { commitSha: 'main' }), fx.ctx),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_INVALID_FIELD: "commitSha"/);
  });
});
