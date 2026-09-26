import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runPublishTestInstructions } from '@/lib/mcp/tools/publishTestInstructions';
import { TEST_INSTRUCTIONS_MAX_BODY_BYTES } from '@/lib/testInstructions/caps';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { organizationIdOf } from '../helpers/organizationOf';
import { randomToken } from '../helpers/random';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

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

const BODY = '## Locally\n\n```sh\npnpm install\n```\n\n## Click-path\n\n1. Open /items/ACME-7';

function args(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    bodyMd: BODY,
    repos: [{ repo: 'web', commitSha: SHA }],
    ...over,
  } as Parameters<typeof runPublishTestInstructions>[0];
}

const repoEntry = (repo: string, commitSha = SHA) => ({ repo, commitSha });

function errorText(res: CallToolResult): string {
  expect(res.isError).toBe(true);
  const first = res.content[0];
  return first && first.type === 'text' ? first.text : '';
}

async function storedRows() {
  return adminDb.testInstructions.findMany();
}

describe('runPublishTestInstructions — success', () => {
  it('stores ONE record on a STORY with a section per repository, resolving by bare name or owner/name', async () => {
    const { fx, web } = await scenario();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story run' });
    const api = await connectRepo(fx, 'acme', 'api');

    const first = await runPublishTestInstructions(
      args(story.identifier, { repos: [repoEntry('web'), repoEntry('acme/api', 'e'.repeat(40))] }),
      fx.ctx,
    );
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      workItemKey: story.identifier,
      repos: [
        { repoId: web.id, commitSha: SHA },
        { repoId: api.id, commitSha: 'e'.repeat(40) },
      ],
      created: true,
      isCurrent: true,
      dispatchRunId: null,
    });

    // The same run (none) retrying with other spellings of the same repositories.
    const retry = await runPublishTestInstructions(
      args(story.identifier, {
        repos: [repoEntry('ACME/WEB'), repoEntry('api', 'e'.repeat(40))],
      }),
      fx.ctx,
    );
    expect(retry.structuredContent).toMatchObject({ created: false });
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyMd).toBe(BODY);
  });

  // ⚠️ `repos` IS OPTIONAL (MOTIR-5689), and this door is the one place the
  // change is easy to misread: it is optional because a PERSON's form names no
  // repository, not because an agent may skip it. Both spellings of absent are
  // covered, and the card is given a CONNECTED repository, so an implementation
  // that filled the list from what it could find would answer with a section.
  it.each([
    ['OMITTED', undefined],
    ['EMPTY', [] as Array<{ repo: string; commitSha: string }>],
  ])('stores a BODY-ONLY record when `repos` is %s', async (_name, repos) => {
    const { fx, card } = await scenario();
    const result = await runPublishTestInstructions(args(card.identifier, { repos }), fx.ctx);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workItemKey: card.identifier,
      repos: [],
      created: true,
      isCurrent: true,
    });
    // The summary line says so rather than trailing an empty dash.
    expect((result.content?.[0] as { text: string }).text).toContain('no repository sections.');
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyMd).toBe(BODY);
  });

  it('attributes the record to the RUNNING run whose SCOPE TARGET is the item, or that holds a leg for it — and to none otherwise', async () => {
    const { fx, card } = await scenario();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Scoped story' });
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
    const scoped = await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId: story.id,
      },
    });

    const withLeg = await runPublishTestInstructions(args(card.identifier), fx.ctx);
    expect(withLeg.structuredContent).toMatchObject({ dispatchRunId: running.id });
    expect(finished.id).not.toBe(running.id);

    // The story is not a leg of the scoped run — it is its TARGET.
    const onTarget = await runPublishTestInstructions(args(story.identifier), fx.ctx);
    expect(onTarget.structuredContent).toMatchObject({ dispatchRunId: scoped.id });

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
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Reader',
      permissions: ['project:browse', 'comment:add'],
    });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'member',
    });
    await setProjectRoleAs({
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
      await runPublishTestInstructions(
        args(card.identifier, { repos: [repoEntry('stray')] }),
        fx.ctx,
      ),
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
      args(card.identifier, { repos: [repoEntry('other/web')] }),
      fx.ctx,
    );
    expect(ok.isError).toBeFalsy();
  });

  it('a body over the cap, naming the field and the limit', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(
        args(card.identifier, { bodyMd: 'x'.repeat(TEST_INSTRUCTIONS_MAX_BODY_BYTES + 1) }),
        fx.ctx,
      ),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_CAP_EXCEEDED: /);
    expect(text).toContain('bodyMd');
    expect(text).toContain(String(TEST_INSTRUCTIONS_MAX_BODY_BYTES));
  });

  it('a blank body', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(args(card.identifier, { bodyMd: '   ' }), fx.ctx),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_INVALID_FIELD: "bodyMd"/);
  });

  it('a malformed field', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(
        args(card.identifier, { repos: [repoEntry('web', 'main')] }),
        fx.ctx,
      ),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_INVALID_FIELD: "repos\[0\]\.commitSha"/);
  });

  it('an ABSENT body (a caller that skipped the schema) is the typed refusal, not a crash', async () => {
    // The transport's schema requires a body; the adapter is also reachable from
    // a direct caller, so an omitted one must degrade to the refusal (MOTIR-5337).
    // `repos` is the OTHER half of that arm, and it changed verdict — see the
    // body-only case below.
    const { fx, card } = await scenario();
    const noBody = errorText(
      await runPublishTestInstructions(args(card.identifier, { bodyMd: undefined }), fx.ctx),
    );
    expect(noBody).toMatch(/^TEST_INSTRUCTIONS_INVALID_FIELD: "bodyMd"/);
    expect(await storedRows()).toHaveLength(0);
  });

  it('the same repository twice', async () => {
    const { fx, card } = await scenario();
    const text = errorText(
      await runPublishTestInstructions(
        args(card.identifier, { repos: [repoEntry('web'), repoEntry('acme/web')] }),
        fx.ctx,
      ),
    );
    expect(text).toMatch(/^TEST_INSTRUCTIONS_INVALID_FIELD: "repos\[1\]\.repo"/);
    expect(await storedRows()).toHaveLength(0);
  });
});
