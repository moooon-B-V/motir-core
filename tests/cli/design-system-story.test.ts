import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import type { McpTestServer } from '../helpers/mcpHttpServer';
import type { CliWorkspace } from '../helpers/cliHarness';

const { db } = await import('@/lib/db');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { resetRateLimitStore } = await import('@/lib/api/v1/rateLimit');
const { TOKEN_SCOPES } = await import('@/lib/mcp/scopes');
const { grantForLegacyScopes } = await import('@/tests/helpers/tokenGrant');
const { makeWorkItemFixture } = await import('../fixtures/workItemFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { startMcpHttpServer } = await import('../helpers/mcpHttpServer');
const { makeCliWorkspace } = await import('../helpers/cliHarness');

// STORY E2E — the BUILT CLI prints a design card's prompt that tells the two
// kinds of project apart (Story MOTIR-6960 · MOTIR-6967, Verification step 1).
//
// Not Playwright: `motir run --print` is the surface, and the prompt it prints is
// what every design run reads. The same harness as `design-access-story.test.ts`
// (MOTIR-5567): the real built binary, real `/api/v1` routes over a real socket,
// real Postgres. Nothing is stubbed.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: McpTestServer;
let ws: CliWorkspace;

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
  resetRateLimitStore();
  ws = makeCliWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimitStore();
});

/** A tenant, a full-scope PAT, and a CLI logged in and linked to the project. */
async function tenant(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'cli',
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
  expect(login.exitCode, login.stderr).toBe(0);
  const link = await ws.run(['link', '--project', fx.projectIdentifier]);
  expect(link.exitCode, link.stderr).toBe(0);
  return fx;
}

/** A `type: design` card under a story, with (or without) a card waiting on it. */
async function designCard(fx: WorkItemFixture, opts: { waitedOn: boolean }): Promise<string> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The save bar' },
    fx.ctx,
  );
  const design = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      title: 'Draw the save bar',
      type: 'design',
    },
    fx.ctx,
  );
  if (opts.waitedOn) {
    const consumer = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'subtask',
        parentId: story.id,
        title: 'Build the save bar',
        type: 'code',
      },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: consumer.id, toId: design.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
  }
  return design.identifier;
}

/** The WHAT TO DO section of a printed prompt, so no assertion is met elsewhere. */
function whatToDo(stdout: string): string {
  const start = stdout.indexOf('WHAT TO DO');
  expect(start, 'the printed prompt has a WHAT TO DO section').toBeGreaterThan(-1);
  const end = stdout.indexOf('ACCEPTANCE CRITERIA', start);
  return stdout.slice(start, end === -1 ? undefined : end);
}

describe('`motir run <design card> --print` through the built CLI', () => {
  it.each([
    ['a card waits on it', true, '8. PUBLISH the design result'],
    ['nothing waits on it', false, '8. Do NOT publish a design result'],
  ])(
    'prints the identify step, both branches, the fallback, never-migrate and the publish step (%s)',
    async (_label, waitedOn, publishStep) => {
      const fx = await tenant();
      const key = await designCard(fx, { waitedOn });

      const result = await ws.run(['run', key, '--print']);
      expect(result.exitCode, result.stderr).toBe(0);
      const steps = whatToDo(result.stdout);

      // The identify step OPENS the section, naming both checks.
      const first = steps.slice(steps.indexOf('\n1. '), steps.indexOf('\n2. '));
      expect(first).toContain('1. IDENTIFY THE DESIGN SYSTEM before anything else.');
      expect(first).toContain('depends on @motir/design-system, AND its global CSS imports');
      expect(first).toContain('@motir/design-system/theme.css');

      // Then the three branches, in order, and the never-migrate rule.
      const motir = steps.indexOf('(a) ON MOTIR DESIGN');
      const own = steps.indexOf('(b) ON ITS OWN SYSTEM');
      const none = steps.indexOf('(c) NO COHERENT SYSTEM');
      const never = steps.indexOf('NEVER MIGRATE');
      expect(
        [motir, own, none, never].every((i) => i > -1),
        steps,
      ).toBe(true);
      expect(motir < own && own < none && none < never).toBe(true);
      expect(steps.slice(motir, own)).toContain('@motir/design-system/mock');
      expect(steps.slice(motir, own)).toContain('renderMock');
      expect(steps.slice(own, none)).toContain('Use no --el-* token');
      expect(steps.slice(none, never)).toContain('"## Working palette"');

      // Steps 1..7 then the publish step as 8, numbered next.
      const numbers = [...steps.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(steps).toContain(`\n${publishStep}`);
      expect(steps.indexOf('7. Stop at the asset')).toBeLessThan(steps.indexOf(publishStep));
    },
  );
});
