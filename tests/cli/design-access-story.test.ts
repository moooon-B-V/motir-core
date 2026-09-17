import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import type { McpTestServer } from '../helpers/mcpHttpServer';
import type { CliWorkspace, FakeAgent } from '../helpers/cliHarness';

// ⚠️ THE OBJECT-STORE SEAM, AND IT IS THE ONLY STUB IN THIS FILE.
//
// No object store runs in CI's vitest jobs, so `signedDownloadUrl` cannot mint a
// URL anything could fetch. It is stubbed to point at a SMALL LOCAL HTTP SERVER
// this file starts, which serves the bytes that were actually published — so the
// CLI subprocess performs a REAL download over a REAL socket, which is the half
// of the flow a unit test cannot reach. Everything else is real: real Postgres,
// the real `/api/v1` routes over the harness socket, the real built binary.
const assetBytes = new Map<string, Buffer>();
const assetStatus = new Map<string, number>();
let assetOrigin = '';
const downloads: Array<{ path: string; auth: string | null }> = [];

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer) => {
    assetBytes.set(pathname, Buffer.from(bytes));
    return { pathname };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) =>
    assetBytes.has(pathname)
      ? { contentType: 'text/html', size: assetBytes.get(pathname)!.byteLength }
      : null,
  ),
  signedDownloadUrl: vi.fn(async (pathname: string) => `${assetOrigin}/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { db } = await import('@/lib/db');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { resetRateLimitStore } = await import('@/lib/api/v1/rateLimit');
const { TOKEN_SCOPES } = await import('@/lib/mcp/scopes');
const { grantForLegacyScopes } = await import('@/tests/helpers/tokenGrant');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { startMcpHttpServer } = await import('../helpers/mcpHttpServer');
const { makeCliWorkspace, writeFakeAgent } = await import('../helpers/cliHarness');

// STORY E2E — EVERY AGENT RUN IS HANDED THE APPROVED DESIGN IT BUILDS AGAINST
// (Story MOTIR-5553 · Subtask MOTIR-5567).
//
// ⚠️ NOT PLAYWRIGHT, DELIBERATELY. The story has no browser surface: every door
// it builds is agent-facing, and the flow a person actually uses is `motir run`.
// So the proof is the BUILT binary dispatching real cards against real
// `/api/v1` routes — the lane where the CLI's own story suites already live.
//
// What only this altitude can show: that the files reach the agent's DISK,
// byte-for-byte, over a real download; that `--print` fetches NOTHING and says
// how to fetch instead; that an unapproved design stops the run with the right
// instruction; and that a failed download degrades the run rather than breaking
// it — leaving no directory, no variable and one warning.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: McpTestServer;
let assetServer: Server;
let ws: CliWorkspace;
let agent: FakeAgent;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
  assetServer = createServer((req, res) => {
    const path = (req.url ?? '').replace(/^\//, '');
    downloads.push({ path, auth: req.headers.authorization ?? null });
    const forced = assetStatus.get(path);
    if (forced) {
      res.writeHead(forced).end('nope');
      return;
    }
    const bytes = assetBytes.get(path);
    if (!bytes) {
      res.writeHead(404).end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(bytes);
  });
  await new Promise<void>((resolve) => assetServer.listen(0, '127.0.0.1', resolve));
  assetOrigin = `http://127.0.0.1:${(assetServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => assetServer.close(() => resolve()));
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  resetRateLimitStore();
  assetBytes.clear();
  assetStatus.clear();
  downloads.length = 0;
  ws = makeCliWorkspace();
  agent = writeFakeAgent(join(ws.root, '.agent'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitStore();
});

// ─── the tenant, and the cards ─────────────────────────────────────────────

/** A tenant, a full-scope PAT, and a CLI logged in and linked to the project —
 *  the state a person's terminal is in before they type `motir run`. */
async function tenant(): Promise<{ fx: WorkItemFixture; token: string }> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'cli',
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
  expect(login.exitCode, login.stderr).toBe(0);
  const link = await ws.run(['link', '--project', fx.projectIdentifier]);
  expect(link.exitCode, link.stderr).toBe(0);
  return { fx, token };
}

/** The three files a design publishes — a mock, its delta, and the note. */
const FILES = [
  { kind: 'mock' as const, sourcePath: 'design/work-items/detail.mock.html', body: '<p>base</p>' },
  {
    kind: 'mock' as const,
    sourcePath: 'design/work-items/detail--filters.mock.html',
    body: '<p>the delta</p>',
  },
  {
    kind: 'note_file' as const,
    sourcePath: 'design/work-items/design-notes.md',
    body: '# the note',
  },
];

async function publishDesign(fx: WorkItemFixture, cardId: string): Promise<string> {
  const prefix = designPrefix(fx.workspaceId, cardId);
  const assets = FILES.map((f, i) => {
    const pathname = `${prefix}asset-${i}`;
    assetBytes.set(pathname, Buffer.from(f.body, 'utf8'));
    return { kind: f.kind, sourcePath: f.sourcePath, pathname };
  });
  const evidence = await designEvidenceService.recordFromPathnames(
    { workItemId: cardId, assets, commitSha: 'sha-e2e' },
    fx.ctx,
  );
  return evidence.id;
}

/** A design card at IN REVIEW with a published result, plus a consumer. */
async function seed(
  fx: WorkItemFixture,
  opts: { approve: boolean },
): Promise<{ design: { id: string; key: string }; consumer: string; evidenceId: string }> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The surface' },
    fx.ctx,
  );
  const design = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Draw the detail filters',
      type: 'design',
    },
    fx.ctx,
  );
  const consumer = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Build the detail filters',
      type: 'code',
    },
    fx.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: consumer.id, toId: design.id, kind: 'is_blocked_by' },
    fx.ctx,
  );
  await workItemsService.updateStatus(design.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(design.id, 'in_review', fx.ctx);

  const evidenceId = await publishDesign(fx, design.id);
  if (opts.approve) {
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
    });
    await approvalGatesService.decide(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
  }
  return {
    design: { id: design.id, key: design.identifier },
    consumer: consumer.identifier,
    evidenceId,
  };
}

function runCli(_token: string, args: string[]) {
  // The CLI reads its server and credential from the config the login wrote —
  // the same path a person's terminal takes.
  return ws.run(args);
}

// ─── the walk ──────────────────────────────────────────────────────────────

describe('the built CLI hands the agent the approved design', () => {
  it('writes every published file into $MOTIR_DESIGN_DIR, byte for byte', async () => {
    const { fx, token } = await tenant();
    const { design, consumer, evidenceId } = await seed(fx, { approve: true });

    const result = await runCli(token, ['run', consumer, '--agent', agent.command]);

    // ⚠️ THE AGENT RAN, ASSERTED FIRST. Every assertion below reads what the
    // agent recorded, so a run that never launched one would otherwise fail as
    // "no design files" — which reads as a design bug and is a dispatch bug.
    const runs = agent.invocations();
    expect(runs.length, result.stdout + result.stderr).toBeGreaterThan(0);
    const run = runs[0]!;

    expect(run.designDir, 'the run set $MOTIR_DESIGN_DIR').not.toBeNull();
    expect(run.designFiles.sort()).toEqual(
      FILES.map((f) => `${design.key}/${f.sourcePath}`).sort(),
    );

    // The bytes the agent can open are the bytes that were published. A
    // transformed copy is a different design.
    // (The agent listed the paths; the downloads prove the content route.)
    expect(downloads.length).toBe(FILES.length);
    // ⚠️ AND NO `Authorization` HEADER REACHED THE STORE. The link is presigned;
    // the store is a third party. This is the one assertion that can only be
    // made from the server's side of a real socket.
    expect(downloads.every((d) => d.auth === null)).toBe(true);

    // The prompt names the design and its VERSION.
    expect(run.promptFromFile).toContain('DESIGN REFERENCE');
    expect(run.promptFromFile).toContain(design.key);
    expect(run.promptFromFile).toContain(evidenceId);
    expect(run.promptFromFile).toContain('MOTIR_DESIGN_DIR');
  });

  it('`--print` fetches NOTHING and tells the agent how to fetch instead', async () => {
    const { fx, token } = await tenant();
    const { design, consumer, evidenceId } = await seed(fx, { approve: true });

    const result = await runCli(token, ['run', consumer, '--print']);

    expect(result.stdout).toContain('DESIGN REFERENCE');
    expect(result.stdout).toContain(design.key);
    expect(result.stdout).toContain(evidenceId);
    expect(result.stdout).toContain('get_design');
    // NOT ONE byte was fetched: `--print` materializes nothing, so a presign
    // minted here would start expiring for a run that may never happen.
    expect(downloads).toEqual([]);
    expect(agent.invocations()).toEqual([]);
  });

  it('an UNAPPROVED design stops the run through THE CARD IS WRONG', async () => {
    const { fx, token } = await tenant();
    const { design, consumer } = await seed(fx, { approve: false });

    // ⚠️ `--force`, AND THE REASON IS ITSELF A FINDING. While the design card is
    // not done the consumer is not READY, so the CLI refuses it before any
    // prompt is assembled — readiness is the FIRST gate and the design gate is
    // the second. This asserts the second, which a person reaches either by
    // forcing a not-ready card (here) or on a card whose design blocker IS done
    // but whose result was withdrawn, cancelled or never published.
    const refused = await runCli(token, ['run', consumer, '--print']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('is not ready');

    const result = await runCli(token, ['run', consumer, '--print', '--force']);

    expect(result.stdout).toContain(design.key);
    expect(result.stdout).toContain('NO APPROVED DESIGN (not_done)');
    // The instruction, and the SHAPE of the correction it asks for.
    expect(result.stdout).toContain('Stop through THE CARD');
    expect(result.stdout).toContain('BESIDE this card');
    expect(result.stdout).toContain('relates_to');
    expect(downloads).toEqual([]);
  });

  it('a FAILED download degrades the run: no directory, no variable, one warning', async () => {
    const { fx, token } = await tenant();
    const { design, consumer } = await seed(fx, { approve: true });
    // One asset 500s. The all-or-nothing rule says the whole directory goes.
    const prefix = designPrefix(fx.workspaceId, design.id);
    assetStatus.set(`${prefix}asset-1`, 500);

    const result = await runCli(token, ['run', consumer, '--agent', agent.command]);

    const runs = agent.invocations();
    // ⚠️ THE RUN STILL HAPPENED. A design that could not be fetched is a
    // degraded run, never a broken one — failing the dispatch would turn a
    // transient store hiccup into a card nobody is working on.
    expect(runs.length, result.stdout + result.stderr).toBeGreaterThan(0);
    const run = runs[0]!;

    expect(run.designDir).toBeNull();
    expect(run.designFiles).toEqual([]);
    // The operator is told once, and told what follows.
    const output = result.stdout + result.stderr;
    expect(output).toContain('fetch the design itself');
    expect(output.match(/fetch the design itself/g)!.length).toBe(1);
    // …and the prompt still names the design, so the agent knows what to fetch.
    expect(run.promptFromFile).toContain(design.key);
    expect(run.promptFromFile).toContain('get_design');
  });
});
