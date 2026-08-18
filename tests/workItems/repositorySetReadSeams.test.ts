import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { presentMcpWorkItem, presentMcpReadyDispatch } from '@/lib/mcp/payloads/workItems';
import { buildEntryParts, isRegisteredDiffKey } from '@/lib/activity/renderers';
import { firstRepoStraddleCriterion } from '@/lib/workItems/proseVsGraph';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The repository SET's READ SEAMS (Story MOTIR-2725 · MOTIR-2728, ADR
// `docs/decisions/work-item-repository-set.md` §3).
//
// A stored field with no read path is, from a consumer's side, indistinguishable
// from a field that was never built — and there are four separate consumers here.
// The property this file defends is not "each surface has a `targetRepos`" but
// the stronger one the ADR pins: **`targetRepo` IS `targetRepos[0] ?? null` on
// every surface**, so the scalar can never become a second fact.
//
// The DISPATCH shape is asserted UNCHANGED, in the same file and against the same
// card, because "the item shape gained the set and the dispatch shape did not" is
// a claim about a difference and is only meaningful if both are read at once.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function connectRepo(caller: V1ProjectCaller, name: string, defaultBranch = 'main') {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${caller.fixture.workspaceId}` },
    create: {
      installationId: `inst-${caller.fixture.workspaceId}`,
      workspaceId: caller.fixture.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: caller.fixture.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch,
      archived: false,
      provider: 'github',
    },
  });
}

async function twoRepoCard(caller: V1ProjectCaller) {
  await connectRepo(caller, 'motir-core');
  await connectRepo(caller, 'motir-ai', 'trunk');
  return workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: 'task',
      title: 'A card that ships in two repositories',
      targetRepos: ['motir-ai', 'motir-core'],
    },
    caller.ctx,
  );
}

describe('the write→read SEAM — one card, three consumers, real Postgres', () => {
  it('returns both elements, IN ORDER, through the internal DTO, /api/v1 and the MCP item payload', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const created = await twoRepoCard(caller);

    // 1. The internal DTO, read back off the row rather than off the create's
    //    return value — two mocked halves agreeing is exactly the state in which
    //    a key has already drifted.
    const row = await adminDb.workItem.findUnique({ where: { id: created.id } });
    const dto = toWorkItemDto(row!);
    expect(dto.targetRepos).toEqual(['motir-ai', 'motir-core']);

    // 2. The public read, through the shipped presenter AND its own schema — a
    //    field the schema never declared fails here rather than reaching a client.
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      created.identifier,
      caller.ctx,
    );
    const body = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}));
    expect(body.targetRepos).toEqual(['motir-ai', 'motir-core']);

    // 3. The MCP ITEM payload.
    expect(presentMcpWorkItem(dto).targetRepos).toEqual(['motir-ai', 'motir-core']);
  });

  it('keeps `targetRepo` equal to the set’s FIRST element on every surface', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const created = await twoRepoCard(caller);
    const row = await adminDb.workItem.findUnique({ where: { id: created.id } });
    const dto = toWorkItemDto(row!);
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      created.identifier,
      caller.ctx,
    );
    const body = presentWorkItemDetail(detail, 0, {});

    // Asserted against the SET on each surface, not against a repeated literal —
    // the claim is a relationship between two fields, so a test that hard-coded
    // 'motir-ai' three times would pass while the two drifted together.
    expect(dto.targetRepo).toBe(dto.targetRepos[0]);
    expect(body.targetRepo).toBe(body.targetRepos[0]);
    const mcp = presentMcpWorkItem(dto);
    expect(mcp.targetRepo).toBe(mcp.targetRepos[0]);
  });

  it('renders the EMPTY set as an empty array and a null scalar, everywhere', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    const created = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title: 'Unpinned' },
      caller.ctx,
    );
    const row = await adminDb.workItem.findUnique({ where: { id: created.id } });
    const dto = toWorkItemDto(row!);
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      created.identifier,
      caller.ctx,
    );
    const body = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}));

    expect(dto).toMatchObject({ targetRepo: null, targetRepos: [] });
    expect(body).toMatchObject({ targetRepo: null, targetRepos: [] });
    expect(presentMcpWorkItem(dto)).toMatchObject({ targetRepo: null, targetRepos: [] });
  });
});

describe('the DISPATCH shape is UNCHANGED — this story’s boundary (ADR §2)', () => {
  it('carries a single-valued targetRepo with its coordinates, and NO set', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['work_items:write'] });
    await twoRepoCard(caller);

    const dispatch = await workItemsService.getNextReady(caller.fixture.projectId, {}, caller.ctx);
    const payload = presentMcpReadyDispatch(dispatch!, 0);

    // The primary, with its OWN mirrored default branch — `trunk`, not `main`.
    expect(payload).toMatchObject({
      targetRepo: 'motir-ai',
      targetRepoDefaultBranch: 'trunk',
    });
    expect(payload).not.toHaveProperty('targetRepos');
  });
});

describe('the /api/v1 contract — additive, and its version says so', () => {
  it('moves V1_CONTRACT_VERSION for the addition (Amendment 8)', () => {
    // Not a decorative bump: the number rides `X-Motir-Api-Version` on every
    // response, and an additive change a client cannot detect is a change it
    // cannot adopt.
    //
    // ⚠️ AT LEAST 1.9.0, not EXACTLY it (MOTIR-2903). This card's addition took
    // 1.9.0; the assertion this replaces pinned that string, which made the
    // NEXT additive change under §8 — every one of which is REQUIRED to move
    // this number — red-light itself on a guard belonging to a card it does not
    // touch. What the guard is for is that the version moved PAST the last
    // release that predates `targetRepos`, and a monotonic floor says exactly
    // that while surviving its own success.
    const [major, minor] = V1_CONTRACT_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(9);
  });

  it('maps the both-fields conflict to 422, not a 500', () => {
    expect(DOMAIN_ERROR_STATUS['CONFLICTING_TARGET_REPO_INPUT']).toBe(422);
  });

  it('still declares `targetRepo` on the read shape — §8 forbids removing it', () => {
    const shape = workItemDetailSchema.shape;
    expect(shape).toHaveProperty('targetRepo');
    expect(shape).toHaveProperty('targetRepos');
  });
});

const RESOLVERS = {
  user: () => null,
  status: (key: string) => key,
  label: (id: string) => id,
  component: (id: string) => id,
  sprint: (id: string) => id,
  workItem: (id: string) => id,
} as unknown as Parameters<typeof buildEntryParts>[2];

describe('the ACTIVITY feed renders a repository-set change', () => {
  it('names both states as a readable list rather than a JSON blob', () => {
    const parts = buildEntryParts(
      'updated',
      { targetRepos: { from: ['motir-core'], to: ['motir-ai', 'motir-core'] } },
      RESOLVERS,
    );
    expect(parts).toContainEqual({
      kind: 'field',
      field: 'targetRepos',
      from: { type: 'text', text: 'motir-core' },
      to: { type: 'text', text: 'motir-ai, motir-core' },
    });
  });

  it('renders an emptied set as `none` — the same "—" a cleared field uses', () => {
    // An empty set and an unpinned card are ONE state (ADR §1); the History must
    // not invent a second way to say it.
    const parts = buildEntryParts(
      'updated',
      { targetRepos: { from: ['motir-core'], to: [] } },
      RESOLVERS,
    );
    expect(parts).toContainEqual({
      kind: 'field',
      field: 'targetRepos',
      from: { type: 'text', text: 'motir-core' },
      to: { type: 'none' },
    });
  });

  it('is REGISTERED — an unregistered field renders as a generic key/value blob', () => {
    // The registry is the whole mechanism: a field with no entry falls to
    // `genericPart` and produces `["motir-core"]` in the History (mistake #29's
    // shape), which is a change nobody can read.
    expect(isRegisteredDiffKey('targetRepos')).toBe(true);
    const parts = buildEntryParts(
      'updated',
      { targetRepos: { from: [], to: ['motir-core'] } },
      RESOLVERS,
    );
    expect(parts.every((p) => p.kind !== 'generic')).toBe(true);
  });
});

describe('the repo-straddle advisory reads the SET — widened, not deleted', () => {
  const CANDIDATES = [
    { name: 'motir-core', repoRef: 'moooon/motir-core' },
    { name: 'motir-ai', repoRef: 'moooon/motir-ai' },
    { name: 'motir-gateway', repoRef: 'moooon/motir-gateway' },
  ];
  // A path is resolved by its FIRST segment (or `owner/name` prefix), so the
  // criteria name the repositories the way a real card does.
  const body = [
    '## Acceptance criteria',
    '',
    '- The service in `motir-core/lib/services/planner.ts` returns the plan.',
    '- The mirror in `motir-ai/src/llm/planningRulePacks.ts` carries the same rule.',
  ].join('\n');

  it('does NOT fire when a criterion names a path in a repository the card CARRIES', () => {
    // `lib/…` resolves to motir-core and `src/llm/…` to motir-ai; a card carrying
    // BOTH is the shape this story legitimises, and it is not a straddle.
    expect(firstRepoStraddleCriterion(body, ['motir-core', 'motir-ai'], CANDIDATES)).toBeNull();
  });

  it('STILL fires when a criterion names a repository the card does NOT carry', () => {
    // The defect this check was built to find, unchanged: a two-element set does
    // not excuse a path in a third repository.
    const found = firstRepoStraddleCriterion(body, ['motir-core'], CANDIDATES);
    expect(found).toMatchObject({ repo: 'motir-ai', reason: 'contradiction', criterionIndex: 2 });
  });

  it('keeps the UNPINNABLE arm for a card carrying nothing at all', () => {
    const found = firstRepoStraddleCriterion(body, [], CANDIDATES);
    expect(found).toMatchObject({ reason: 'unpinnable', repo: 'motir-ai' });
  });

  it('still says nothing about a card carrying nothing whose criteria name ONE repo', () => {
    const single =
      '## Acceptance criteria\n\n- `motir-core/lib/services/planner.ts` returns the plan.\n';
    expect(firstRepoStraddleCriterion(single, [], CANDIDATES)).toBeNull();
  });
});
