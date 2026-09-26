import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { plansService } from '@/lib/services/plansService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { runValidateSprint } from '@/lib/mcp/tools/validateSprint';
import { runValidateWorkItem } from '@/lib/mcp/tools/validateWorkItem';
import type { SprintValidityDto } from '@/lib/dto/sprints';
import type { WorkItemDto, WorkItemValidityDto } from '@/lib/dto/workItems';
import { MotirClient } from '../../packages/cli/src/client';
import { claimScopeForRun, resolveScopeTarget } from '../../packages/cli/src/commands/scope';
import { resolveOwnerId } from '../../packages/cli/src/commands/dispatch';
import type { ProjectSession } from '../../packages/cli/src/session';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import { makeCliWorkspace, type CliWorkspace } from '../helpers/cliHarness';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';

// The motir-core STORY GATE for HARD and SOFT blocks (Story MOTIR-6354 ·
// MOTIR-6364). Each feature card shipped units that stub the other side of its
// seam; this suite puts the two halves on real Postgres and a real socket:
//
//   • readiness → CLI    — the BUILT `motir` binary reads the real
//                          `/api/v1/work-items/{key}` verdict and decides HARD vs
//                          SOFT from it (MOTIR-6366 × MOTIR-6355);
//   • ready → scoped run — the CLI's own scope module builds its set from the
//                          real `/ready?allowSoftBlock=true&ancestor=` response;
//   • sprint validity    — `validate_sprint`, committed and projected, checks OWN
//                          blockers only (MOTIR-6368);
//   • softBlocks         — `validate_work_item` reports the ancestor's block
//                          without gating on it (MOTIR-6368).
//
// The banner half (MOTIR-6377) needs a DOM, so it lives beside this file in
// `hardSoftBlocksBannerSeam.test.tsx`. Nothing here mocks the readiness service,
// the ready route or the sprint validity.
//
// THE SEED, built fresh per test:
//
//   openEpic                     (todo — never finished)
//   E  ── blocked_by ──▶ openEpic
//   └── story
//        ├── S1                  no blockers of its own  → SOFT-blocked by E
//        └── S2 ── blocked_by ──▶ X                      → HARD-blocked
//   otherStory
//   └── X                        (todo)

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

interface Seed {
  fx: WorkItemFixture;
  openEpic: WorkItemDto;
  epic: WorkItemDto;
  story: WorkItemDto;
  s1: WorkItemDto;
  s2: WorkItemDto;
  x: WorkItemDto;
}

async function make(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

async function seed(): Promise<Seed> {
  const fx = await makeWorkItemFixture();
  const openEpic = await make(fx, 'epic', 'The unfinished epic');
  const epic = await make(fx, 'epic', 'The blocked epic');
  await block(fx, epic.id, openEpic.id);
  const story = await make(fx, 'story', 'The story under E', epic.id);
  const s1 = await make(fx, 'subtask', 'Soft only', story.id);
  const s2 = await make(fx, 'subtask', 'Own blocker', story.id);
  const otherStory = await make(fx, 'story', 'Another story');
  const x = await make(fx, 'subtask', 'The other story’s open subtask', otherStory.id);
  await block(fx, s2.id, x.id);
  return { fx, openEpic, epic, story, s1, s2, x };
}

async function mintToken(fx: WorkItemFixture): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'hard-soft-gate',
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  return token;
}

async function statusOf(fx: WorkItemFixture, id: string): Promise<string> {
  return (await workItemsService.getWorkItem(id, fx.ctx)).status;
}

function structured<T>(result: CallToolResult): T {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as T;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('SEAM — the real readiness payload drives the CLI’s HARD/SOFT decision (keyed run)', () => {
  let ws: CliWorkspace;

  beforeEach(() => {
    ws = makeCliWorkspace();
  });

  it('S1 --allow-soft-block is claimed; S2 --allow-soft-block is refused naming its blocker; S1 without the flag is refused with a hint naming --allow-soft-block', async () => {
    const { fx, epic, s1, s2, x } = await seed();
    const token = await mintToken(fx);
    expect(
      (await ws.run(['auth', 'login', '--server', server.url, '--token', token])).exitCode,
    ).toBe(0);
    expect((await ws.run(['link', '--project', fx.projectIdentifier])).exitCode).toBe(0);

    // S1 WITHOUT the flag — SOFT, so the refusal points at the soft override.
    const plain = await ws.run(['run', s1.identifier, '--print']);
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain(`${s1.identifier} is not ready`);
    expect(plain.stderr).toContain(`its ancestor ${epic.identifier} is blocked`);
    expect(plain.stderr).toContain('--allow-soft-block');
    expect(await statusOf(fx, s1.id)).toBe('todo');

    // S2 WITH the flag — HARD (its own edge to X), so the flag does not reach it.
    const hard = await ws.run(['run', s2.identifier, '--print', '--allow-soft-block']);
    expect(hard.exitCode).toBe(1);
    expect(hard.stderr).toContain(`${s2.identifier} is not ready`);
    expect(hard.stderr).toContain(x.identifier);
    expect(hard.stderr).toContain('overrides only an ancestor');
    expect(await statusOf(fx, s2.id)).toBe('todo');

    // S1 WITH the flag — dispatched, and the claim lands in Postgres.
    const soft = await ws.run(['run', s1.identifier, '--print', '--allow-soft-block']);
    expect(soft.exitCode).toBe(0);
    expect(soft.stderr).toContain(
      `${s1.identifier} is held only by its ancestor ${epic.identifier}'s block`,
    );
    expect(await statusOf(fx, s1.id)).toBe('in_progress');
  });
});

describe('SEAM — the real ready route builds the scoped run (`motir run <story> --allow-soft-block`)', () => {
  async function session(fx: WorkItemFixture): Promise<ProjectSession> {
    const client = new MotirClient({ serverUrl: server.url, token: await mintToken(fx) });
    return {
      client,
      serverUrl: server.url,
      projectKey: fx.projectIdentifier,
      link: { dir: '/', path: '/.motir.json', config: { project: fx.projectIdentifier } },
    } as unknown as ProjectSession;
  }

  it('with the flag the ready read holds S1 and skips S2; without it the scope is empty', async () => {
    const { fx, epic, story, s1, s2, x } = await seed();
    const sess = await session(fx);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A pass-through spy — the REAL client method runs against the REAL route;
    // the spy only records what it was asked and what the server answered.
    const readSpy = vi.spyOn(sess.client, 'listReadyForDispatch');
    try {
      const ownerId = await resolveOwnerId(sess.client);

      // The target's own verdict comes from the real get-work-item read: the
      // story has no own blocker, only E's — SOFT, so the flag may proceed.
      const withFlag = { allowSoftBlock: true };
      const decision = await resolveScopeTarget(
        sess.client,
        story.identifier,
        withFlag,
        server.url,
      );
      expect(decision.action).toBe('scope');
      if (decision.action !== 'scope') return;
      expect(decision.readiness).toMatchObject({
        ready: false,
        openBlockers: [],
        blockedByAncestor: { identifier: epic.identifier },
      });

      // ── WITHOUT the flag: E prunes the walk, so nothing is ready, nothing claimed.
      stderr.mockClear();
      const empty = await claimScopeForRun(sess, decision.target, {}, ownerId, decision.readiness);
      expect(empty).toBeNull();
      expect(await readSpy.mock.results[0]!.value).toEqual([]);
      expect(readSpy.mock.calls[0]![0]).not.toHaveProperty('allowSoftBlock');
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
        `${story.identifier}: nothing is ready to start.`,
      );
      expect(await statusOf(fx, s1.id)).toBe('todo');

      // ── WITH the flag: the widened read returns S1 and never S2 (HARD).
      stderr.mockClear();
      const claimed = await claimScopeForRun(
        sess,
        decision.target,
        withFlag,
        ownerId,
        decision.readiness,
      );
      expect(readSpy.mock.calls[1]![0]).toMatchObject({
        ancestor: [story.identifier],
        allowSoftBlock: true,
      });
      const ready = (await readSpy.mock.results[1]!.value) as { key: string }[];
      expect(ready.map((r) => r.key)).toEqual([s1.identifier]);

      // S2 is skipped from the ready set and NAMED — by the claim, which
      // validates the story's subtree first: S2's own edge to X (outside the
      // story, not done) makes the scope unfinishable, so nothing is locked.
      // (The card expected the run to proceed with S1 alone; the shipped claim
      // gate refuses a scope holding a HARD-blocked member — see the report.)
      expect(claimed).toBeNull();
      const told = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(told).toContain(s2.identifier);
      expect(told).toContain(x.identifier);
      expect(await statusOf(fx, s1.id)).toBe('todo');
      expect(await statusOf(fx, s2.id)).toBe('todo');
    } finally {
      stderr.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('with the flag a soft-blocked story whose children have no HARD block is CLAIMED, built from the widened ready read', async () => {
    const { fx, epic, s1 } = await seed();
    // A second story under the same blocked epic, holding only a soft-blocked leaf.
    const clean = await make(fx, 'story', 'A clean story under E', epic.id);
    const s3 = await make(fx, 'subtask', 'Soft only too', clean.id);
    const sess = await session(fx);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ownerId = await resolveOwnerId(sess.client);
      const decision = await resolveScopeTarget(
        sess.client,
        clean.identifier,
        { allowSoftBlock: true },
        server.url,
      );
      if (decision.action !== 'scope') throw new Error(`expected a scope, got ${decision.action}`);

      const claimed = await claimScopeForRun(
        sess,
        decision.target,
        { allowSoftBlock: true },
        ownerId,
        decision.readiness,
      );
      expect(claimed).not.toBeNull();
      expect(claimed!.claim.outcome).toBe('claimed');
      expect(claimed!.ready.map((r) => r.key)).toEqual([s3.identifier]);
      expect(await statusOf(fx, s3.id)).toBe('in_progress');
      // Scoped to the named story: S1 (another story's leaf) is untouched.
      expect(await statusOf(fx, s1.id)).toBe('todo');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('SEAM — sprint validity checks OWN blockers only; committed and projected twins agree', () => {
  async function bothTwins(fx: WorkItemFixture, sprintId: string): Promise<SprintValidityDto> {
    const committed = structured<SprintValidityDto>(
      await runValidateSprint(
        { projectKey: fx.projectIdentifier, sprintId, condition: 'loose' },
        fx.ctx,
      ),
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'No-op plan' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const projected = structured<SprintValidityDto>(
      await runValidateSprint({ planId: plan.id, condition: 'loose' }, fx.ctx),
    );
    expect(projected).toEqual(committed);
    return committed;
  }

  it('a sprint holding S1 but not E is valid; adding S2 without its blocker makes it invalid', async () => {
    const { fx, s1, s2, x } = await seed();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Gate' }, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await adminDb.workItem.update({ where: { id: s1.id }, data: { sprintId: sprint.id } });

    expect(await bothTwins(fx, sprint.id)).toEqual({
      sprintId: sprint.id,
      valid: true,
      blockers: [],
    });

    await adminDb.workItem.update({ where: { id: s2.id }, data: { sprintId: sprint.id } });
    const invalid = await bothTwins(fx, sprint.id);
    expect(invalid.valid).toBe(false);
    expect(invalid.blockers).toEqual([
      {
        item: s2.identifier,
        blockedBy: x.identifier,
        blockerStatus: 'todo',
        blockerSprintId: null,
      },
    ]);
  });
});

describe('SEAM — validate_work_item reports the ancestor’s block as a non-gating softBlock', () => {
  it('names E once — on S1 (valid) and on the story (whose validity is S2’s own edge alone)', async () => {
    const { fx, openEpic, epic, story, s1, s2, x } = await seed();
    const expected = [
      {
        via: { key: epic.identifier, title: epic.title },
        blockedBy: { key: openEpic.identifier, title: openEpic.title },
        blockerStatus: 'todo',
      },
    ];

    const leaf = structured<WorkItemValidityDto>(
      await runValidateWorkItem({ key: s1.identifier, condition: 'loose' }, fx.ctx),
    );
    expect(leaf.valid).toBe(true);
    expect(leaf.softBlocks).toEqual(expected);

    const onStory = structured<WorkItemValidityDto>(
      await runValidateWorkItem({ key: story.identifier, condition: 'loose' }, fx.ctx),
    );
    expect(onStory.softBlocks).toEqual(expected);
    // E's block never reaches `blockers`: the only one is S2's own edge to X.
    // (The card expected `valid: true` here; S2 lives in this story, so its
    // out-of-subtree HARD blocker keeps the story invalid — see the report.)
    expect(onStory.valid).toBe(false);
    expect(onStory.blockers.map((b) => `${b.item}→${b.blockedBy}`)).toEqual([
      `${s2.identifier}→${x.identifier}`,
    ]);
  });
});
