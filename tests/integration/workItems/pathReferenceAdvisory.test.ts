import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildMcpServer } from '@/lib/mcp/registry';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  buildPathReferenceAdvisories,
  MAX_PATH_REFERENCE_HOST_READS,
  type PathResolver,
} from '@/lib/services/pathReferenceAdvisoryService';
import { isPathReferenceAdvisory } from '@/lib/dto/workItems';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { WorkItemValidityAdvisoryDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { IssueType } from '@/lib/issues/parentRules';
import { makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import { linkProjectRepo } from '../../helpers/projectRepoLink';

// THE PATH-REFERENCE advisory (MOTIR-5424) over real Postgres, through
// `validate_work_item`'s engine: a criterion naming a sibling's not-yet-existing
// FILE is the missing `blocked_by` the key-based reference check cannot see.
//
// The repository host is faked at the NETWORK boundary — `fetch` answers the App's
// token exchange and the contents endpoint — the same seam
// `tests/integration/ai/repoFileRoute.test.ts` uses, so the shipped resolver
// (connected-repo lookup → installation token → contents read) runs for real.
// The fixture is MOTIR-4856 / MOTIR-5231: a design card creating a mock and a code
// card citing it by path, with no edge between them.

type Fx = Awaited<ReturnType<typeof makeWorkItemFixture>>;

const MOCK = 'design/work-items/approval-cta.mock.html';
const THIRD_PARTY = 'src/install-pnpm/run.ts';
const EXISTING = 'lib/services/workItemsService.ts';

/** What the fake host holds on `main` of `moooon/motir-core`. */
const ON_MAIN = new Set(['design', 'lib', 'tests', EXISTING]);

let contentsReads: string[] = [];
let hostDown = false;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  contentsReads = [];
  hostDown = false;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_path_reference',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const m = /\/repos\/moooon\/motir-core\/contents\/([^?]+)\?ref=main$/.exec(u);
      if (m) {
        const path = decodeURIComponent(m[1] as string);
        contentsReads.push(path);
        if (hostDown) return new Response('boom', { status: 502 });
        return ON_MAIN.has(path)
          ? new Response('[]', { status: 200 })
          : new Response('{"message":"Not Found"}', { status: 404 });
      }
      return new Response('nf', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect `moooon/<name>` to the organisation and link it into the project's set. */
async function connectRepo(fx: Fx, name: string): Promise<void> {
  const installationId = `inst-${fx.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
}

async function setup(): Promise<Fx> {
  const fx = await makeWorkItemFixture();
  await connectRepo(fx, 'motir-core');
  await connectRepo(fx, 'motir-ai');
  return fx;
}

const card = (
  fx: Fx,
  title: string,
  descriptionMd: string,
  opts: { kind?: IssueType; parentId?: string; targetRepo?: string | null } = {},
) =>
  workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title,
      descriptionMd,
      parentId: opts.parentId,
      targetRepo: opts.targetRepo === undefined ? 'motir-core' : opts.targetRepo,
    },
    fx.ctx,
  );

const blockedBy = (fx: Fx, fromId: string, toId: string) =>
  workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);

/** A card whose CRITERION cites `path` — the consumer. */
const cites = (path: string) =>
  ['Wires the band.', '', '## Acceptance criteria', '', `1. Matches \`${path}\` exactly.`].join(
    '\n',
  );

/** A card that CREATES `path` — named in its body, anywhere. */
const creates = (path: string) => `Draws the band into \`${path}\`.`;

const pathAdvisories = (advisories: WorkItemValidityAdvisoryDto[]) =>
  advisories.filter(isPathReferenceAdvisory);

async function validate(fx: Fx, identifier: string) {
  return workItemsService.validateWorkItem(fx.projectId, identifier, fx.ctx);
}

describe('validate_work_item — the PATH-REFERENCE advisory', () => {
  it('MOTIR-5231 REGRESSION: a criterion citing a sibling’s unbuilt mock names BOTH cards and the path', async () => {
    const fx = await setup();
    const design = await card(fx, 'Design the band', creates(MOCK));
    const code = await card(fx, 'Build the band', cites(MOCK));

    const result = await validate(fx, code.identifier);
    expect(pathAdvisories(result.advisories)).toEqual([
      {
        kind: 'path-reference',
        item: code.identifier,
        severity: 'likely-missing-path-edge',
        path: MOCK,
        criterionIndex: 1,
        repo: 'motir-core',
        referenced: design.identifier,
        referencedStatus: 'todo',
      },
    ]);
    // Never a gate — the verdict is the one a card without it gets.
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
    // Asked about the file AND its top-level directory, nothing else.
    expect(contentsReads.sort()).toEqual(['design', MOCK]);
  });

  it('the SINGLETON — a card naming only the file it alone will create — never fires, and never asks the host', async () => {
    const fx = await setup();
    const alone = await card(fx, 'Build the band', cites(MOCK));
    await card(fx, 'Unrelated', creates('design/other/elsewhere.mock.html'));

    const result = await validate(fx, alone.identifier);
    expect(pathAdvisories(result.advisories)).toEqual([]);
    expect(contentsReads).toEqual([]);
  });

  it('a THIRD PARTY’s file — top-level directory absent too — is not a forward reference', async () => {
    const fx = await setup();
    const a = await card(fx, 'Pin pnpm', cites(THIRD_PARTY));
    await card(fx, 'Also cites the action', creates(THIRD_PARTY));

    expect(pathAdvisories((await validate(fx, a.identifier)).advisories)).toEqual([]);
    expect(contentsReads.sort()).toEqual(['src', THIRD_PARTY]);
  });

  it('a path that already EXISTS is two cards editing one file, not a missing edge', async () => {
    const fx = await setup();
    const a = await card(fx, 'Edit the service', cites(EXISTING));
    await card(fx, 'Also edits it', creates(EXISTING));

    expect(pathAdvisories((await validate(fx, a.identifier)).advisories)).toEqual([]);
  });

  it('an EDGE in either direction orders the pair', async () => {
    const fx = await setup();
    const design = await card(fx, 'Design', creates(MOCK));
    const code = await card(fx, 'Code', cites(MOCK));
    await blockedBy(fx, code.id, design.id);
    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);

    const fx2 = await setup();
    const design2 = await card(fx2, 'Design', creates(MOCK));
    const code2 = await card(fx2, 'Code', cites(MOCK));
    await blockedBy(fx2, design2.id, code2.id);
    expect(pathAdvisories((await validate(fx2, code2.identifier)).advisories)).toEqual([]);
  });

  it('an edge BETWEEN THE STORIES orders their children — gate 7’s placement is not a miss', async () => {
    const fx = await setup();
    const storyA = await card(fx, 'Design story', 'The design.', { kind: 'story' });
    const storyB = await card(fx, 'Build story', 'The build.', { kind: 'story' });
    await card(fx, 'Design', creates(MOCK), { kind: 'subtask', parentId: storyA.id });
    const code = await card(fx, 'Code', cites(MOCK), { kind: 'subtask', parentId: storyB.id });
    await blockedBy(fx, storyB.id, storyA.id);

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
  });

  it('a card and its own ANCESTOR naming one file are one piece of work, never a pair', async () => {
    const fx = await setup();
    const story = await card(fx, 'Story', creates(MOCK), { kind: 'story' });
    const child = await card(fx, 'Child', cites(MOCK), { kind: 'subtask', parentId: story.id });

    const result = await validate(fx, story.identifier);
    expect(pathAdvisories(result.advisories)).toEqual([]);
    expect(child.identifier).toBeTruthy();
  });

  it('a DONE or ARCHIVED second namer is no finding', async () => {
    const fx = await setup();
    const done = await card(fx, 'Design', creates(MOCK));
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
    const archived = await card(fx, 'Old design', creates(MOCK));
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    const code = await card(fx, 'Code', cites(MOCK));

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
  });

  it('a second namer shipping in ANOTHER repository names a different file', async () => {
    const fx = await setup();
    await card(fx, 'The AI half', creates(MOCK), { targetRepo: 'motir-ai' });
    const code = await card(fx, 'Code', cites(MOCK));

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
  });

  it('a second namer pinning NO repository may ship anywhere, so it still counts', async () => {
    const fx = await setup();
    const unpinned = await card(fx, 'Design', creates(MOCK), { targetRepo: null });
    const code = await card(fx, 'Code', cites(MOCK));

    expect(
      pathAdvisories((await validate(fx, code.identifier)).advisories).map((a) => a.referenced),
    ).toEqual([unpinned.identifier]);
  });

  it('a card pinning NO repository has nothing to resolve against — skipped', async () => {
    const fx = await setup();
    await card(fx, 'Design', creates(MOCK));
    const code = await card(fx, 'Code', cites(MOCK), { targetRepo: null });

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
    expect(contentsReads).toEqual([]);
  });

  it('a host that does not ANSWER is silence, not a finding', async () => {
    const fx = await setup();
    await card(fx, 'Design', creates(MOCK));
    const code = await card(fx, 'Code', cites(MOCK));
    hostDown = true;

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
  });

  it('a repository the organisation has NOT connected is silence too', async () => {
    const fx = await makeWorkItemFixture();
    await connectRepo(fx, 'motir-core');
    await card(fx, 'Design', creates(MOCK));
    const code = await card(fx, 'Code', cites(MOCK));
    // The pin stays on the cards; the connection they named goes away.
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { name: 'renamed-away' },
    });

    expect(pathAdvisories((await validate(fx, code.identifier)).advisories)).toEqual([]);
    expect(contentsReads).toEqual([]);
  });

  it('validating the STORY reports its child, one entry per other namer, in a stable order', async () => {
    const fx = await setup();
    const story = await card(fx, 'Build story', 'The build.', { kind: 'story' });
    const code = await card(fx, 'Code', cites(MOCK), { kind: 'subtask', parentId: story.id });
    const d2 = await card(fx, 'Design B', creates(MOCK));
    const d1 = await card(fx, 'Design A', creates(MOCK));

    const found = pathAdvisories((await validate(fx, story.identifier)).advisories);
    expect(found.map((a) => [a.item, a.referenced])).toEqual(
      [d1.identifier, d2.identifier]
        .sort((a, b) => a.localeCompare(b))
        .map((r) => [code.identifier, r]),
    );
  });

  it('renders both cards, the path and the remedy on the MCP text — still VALID', async () => {
    const fx = await setup();
    const design = await card(fx, 'Design the band', creates(MOCK));
    const code = await card(fx, 'Build the band', cites(MOCK));

    const client = await connectClient(fx.ctx);
    const res = (await client.callTool({
      name: 'validate_work_item',
      arguments: { key: code.identifier },
    })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain(`${code.identifier} is VALID`);
    expect(text).toContain(
      `${code.identifier} criterion 1 names ${MOCK} (not yet in motir-core), also named by ` +
        `${design.identifier} (todo) (likely-missing-path-edge)`,
    );
    expect(text).toContain('Wire blocked_by from the card that CITES the file');
  });
});

describe('workItemRepository.findLiveBodiesContainingAny', () => {
  it('an EMPTY needle list asks nothing and answers nothing', async () => {
    const fx = await setup();
    await card(fx, 'Design', creates(MOCK));
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.findLiveBodiesContainingAny(fx.projectId, fx.workspaceId, [], tx),
      ),
    ).toEqual([]);
  });
});

describe('buildPathReferenceAdvisories — the host-read cap', () => {
  it('asks the host at most MAX_PATH_REFERENCE_HOST_READS questions, and answers only those', async () => {
    const fx = await setup();
    const paths = Array.from(
      { length: MAX_PATH_REFERENCE_HOST_READS },
      (_, i) => `design/x/m${i}.mock.html`,
    );
    const body = ['## Acceptance criteria', ...paths.map((p) => `- \`${p}\``)].join('\n');
    const subject = await card(fx, 'Cites many', body);
    await card(fx, 'Creates many', paths.map((p) => `\`${p}\``).join(' '));

    const asked: string[] = [];
    const resolver: PathResolver = async (_repo, path) => {
      asked.push(path);
      return path === 'design' ? 'present' : 'absent';
    };
    const found = await buildPathReferenceAdvisories(
      [
        {
          id: subject.id,
          identifier: subject.identifier,
          descriptionMd: body,
          targetRepos: ['motir-core'],
        },
      ],
      fx.projectId,
      new Set(['done', 'cancelled']),
      fx.ctx,
      resolver,
    );
    expect(asked).toHaveLength(MAX_PATH_REFERENCE_HOST_READS);
    // The directory is one question shared by every path, so the cap spends the
    // rest on files: one finding per path whose own answer came back.
    expect(found).toHaveLength(MAX_PATH_REFERENCE_HOST_READS - 1);
  });
});

async function connectClient(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'path-reference', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}
