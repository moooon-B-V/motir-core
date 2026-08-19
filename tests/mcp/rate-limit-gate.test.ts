import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_SERVER_INFO } from '@/lib/mcp/registry';
import { MCP_BILLABLE_TOOLS, rateLimitedServer } from '@/lib/mcp/rateLimitGate';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import type { McpRequestExtra } from '@/lib/mcp/context';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../helpers/db';
import { ALIGNED_WINDOW_MS, sleep, waitForWindowBoundary } from '../helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';

// The BILLABLE-TOOL gate at the MCP dispatch seam (MOTIR-2610), wired.
//
// `tests/rateLimit/surfaceGuards.test.ts` owns the DECISION (which tools draw
// `ai:generate`, which budget they share with the browser, and the filesystem
// derivation of the billable set). What only a wired server can prove is the
// three things the Proxy itself is responsible for:
//
//   1. a billable tool is actually SHORT-CIRCUITED at dispatch — the refusal
//      arrives as an MCP-legal `isError` tool result, so an SDK client parses it
//      rather than seeing a transport error;
//   2. the SCOPE gate still runs FIRST, so a token that may not call the tool
//      cannot drain its owner's generation budget by calling it anyway;
//   3. every other tool passes through the Proxy untouched.
//
// Refusals here happen BEFORE the tool's runner, so no service and no provider is
// reached — which is why these cases need no AI fixture and no motir-ai.
//
// ⚠️ EVERY CASE PINS THE WINDOW AS WELL AS THE BUDGET (MOTIR-2647). A budget of
// `1` says how much may be spent; it says nothing about WHEN the counter resets,
// and `consumeSharedRateLimit` buckets on a grid aligned to the EPOCH — so two
// calls that land on opposite sides of a `windowMs` multiple get a fresh counter
// between them and the one expected to be refused is served instead. That is a
// property of the wall clock's PHASE, not of the runner's speed: it is invisible
// locally, it clears on every re-run, and it presents as `PROJECT_NOT_FOUND`
// where `RATE_LIMITED` was expected — which reads like a product bug in whatever
// the branch touched. `tests/helpers/rateLimitWindow.ts` is the one definition of
// the cure; `budgetOf` below applies it, and the second case — "the ALIGNMENT is
// what refuses" — makes the failure summonable, so the fix is not the kind
// nobody can watch fail first.

const LIMIT_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT';
const WINDOW_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS';
const ENVS = [LIMIT_ENV, WINDOW_ENV];

/** The refusal the runner returns for the fixture's absent project — i.e. what a
 *  call that PASSED the gate comes back with. */
const PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND';

/**
 * How far short of a boundary the reproduction case below starts — the phase an
 * unaligned pair is handed by bad luck, here handed to it on purpose.
 *
 * Both this and {@link CALL_GAP_MS} are margins, not delays: the first call must
 * finish on the NEAR side of the boundary and the second on the FAR side, so
 * each is ~20× the 19 ms worst-of-20 the heaviest counted section in these
 * suites measures at (`rateLimitWindow.ts`). Shrinking them makes the
 * reproduction itself phase-dependent, which is the defect it demonstrates.
 */
const PRE_BOUNDARY_MS = 400;

/** The gap between the reproduction's two calls — longer than the window
 *  remainder they start with, so the pair provably straddles unless something
 *  crosses the boundary for them first. */
const CALL_GAP_MS = 800;

/** The reproduction case sleeps ~9 s BY CONSTRUCTION — two constructed phases
 *  plus two inter-call gaps — which the 15 s default leaves too little room
 *  above. Named rather than written inline because a comment in `it`'s argument
 *  position is one of the few things Prettier reformats non-idempotently. */
const REPRODUCTION_TIMEOUT_MS = 30_000;

const ctx: ServiceContext = { userId: 'gate_user', workspaceId: 'gate_ws' };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  // AFTER the reset — the reset drops exactly the override this installs.
  // ⚠️ The SECOND unstated precondition of every refusal here (MOTIR-3067). The
  // block above pins the WINDOW; this pins the store DEADLINE. Without it the
  // reset above rebuilds the production store, whose 250 ms budget
  // `consumeSharedRateLimit` fails OPEN on — and a served call arrives at
  // `toContain(RATE_LIMITED_CODE)` as the fixture's `PROJECT_NOT_FOUND`, i.e. as
  // the same "reads like a product bug" failure this file's header already
  // describes for the window. See `tests/helpers/rateLimitStore.ts`.
  pinSharedRateLimitStoreDeadline();
  for (const key of ENVS) delete process.env[key];
  // The gate must never read as "off" here — a suite that inherited the E2E
  // switch would assert nothing at all.
  delete process.env[RATE_LIMIT_DISABLE_ENV];
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Connect an in-memory MCP client to a metered server. `grant` mirrors what a
 *  token was granted; omitting it applies no permission narrowing. */
async function connect(grant?: readonly PermissionKey[]): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    grant ? () => [...grant] : undefined,
    true, // meterBillableTools — the production wiring
  );
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  return JSON.stringify(result);
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/** Call the billable tool every case in this file meters on. */
function expandItem(client: Client): Promise<ToolResult> {
  return client.callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } });
}

/**
 * Assert the call PASSED the gate and reached the runner, which then failed on
 * the fixture's absent project.
 *
 * Stated positively on purpose. "It was not rate-limited" is true of a call that
 * never happened, of a transport error swallowed by a `.catch`, and of a runner
 * that refused for some third reason — so inferring "the gate let it through"
 * from the ABSENCE of `RATE_LIMITED` infers it from almost nothing. The
 * `PROJECT_NOT_FOUND` these calls come back with is the positive evidence, and it
 * is load-bearing in every case below.
 */
function expectReachedTheTool(result: ToolResult): void {
  expect(result.isError).toBe(true);
  expect(textOf(result.content)).toContain(PROJECT_NOT_FOUND);
  expect(textOf(result.content)).not.toContain(RATE_LIMITED_CODE);
}

/**
 * Pin the generation budget to `limit` over an ALIGNED window, then hand the
 * caller a whole one — so a case's accumulated count owns its window instead of
 * whatever was left of a randomly-phased 60 s one.
 *
 * Applied by every case that sets the budget at all, including the two that
 * spend nothing from it (the non-billable tools, and the unmetered server). They
 * are not window-sensitive TODAY, and pinning them costs up to one window each;
 * what it buys is that neither depends on `MCP_BILLABLE_TOOLS` staying as it is —
 * a tool added to that list would otherwise make them silently phase-dependent,
 * which is exactly how this file acquired the defect in the first place.
 */
async function budgetOf(limit: number): Promise<void> {
  process.env[LIMIT_ENV] = String(limit);
  process.env[WINDOW_ENV] = String(ALIGNED_WINDOW_MS);
  await waitForWindowBoundary(ALIGNED_WINDOW_MS);
}

/** Land `PRE_BOUNDARY_MS` short of the next aligned-window boundary — i.e. with
 *  only that much of a window left to spend. Composed from the shared helper
 *  rather than from a phase computed here; the arithmetic has exactly one home
 *  (`tests/api/v1/rate-limit-window-alignment.test.ts` enforces that). */
async function waitUntilJustBeforeBoundary(): Promise<void> {
  await waitForWindowBoundary(ALIGNED_WINDOW_MS);
  await sleep(ALIGNED_WINDOW_MS - PRE_BOUNDARY_MS);
}

describe('the billable-tool gate, wired into a real server', () => {
  it('refuses an over-budget expand_item with an isError tool result, not a transport error', async () => {
    await budgetOf(1);
    const client = await connect();

    // The first call passes the gate and reaches the tool, which fails on the
    // missing project rather than on the limiter — proof the gate let it THROUGH.
    expectReachedTheTool(await expandItem(client));

    const second = await expandItem(client);
    expect(second.isError).toBe(true);
    expect(textOf(second.content)).toContain(RATE_LIMITED_CODE);
    expect(textOf(second.content)).toContain('expand_item');
    await client.close();
  });

  // ⚠️ The case above cannot be watched failing on demand — the phase it needs
  // arrives maybe one run in many — so on its own the pin is an unfalsifiable
  // fix: a green suite after the change proves exactly what a green suite before
  // it proved. This case makes both halves summonable, from the same budget and
  // the same two calls, and asserts the OPPOSITE outcomes.
  it(
    'the ALIGNMENT is what refuses — the same two calls straddle a boundary without it',
    async () => {
      process.env[LIMIT_ENV] = '1';
      process.env[WINDOW_ENV] = String(ALIGNED_WINDOW_MS);

      // Both halves start at the SAME phase — `PRE_BOUNDARY_MS` short of a
      // boundary — and leave the SAME gap between their two calls. The gap is
      // longer than the window remainder they start with, so the pair lands on
      // opposite sides of the boundary unless something crosses it for them
      // first. The alignment is the only thing that differs.

      // (a) UNALIGNED: the boundary falls between the calls, the counter starts
      //     fresh, and the second call reaches the runner. This is the reported
      //     failure summoned on demand — a `PROJECT_NOT_FOUND` where the case
      //     above asserts `RATE_LIMITED`, which is the whole bug.
      await waitUntilJustBeforeBoundary();
      const straddling = await connect();
      expectReachedTheTool(await expandItem(straddling));
      await sleep(CALL_GAP_MS);
      expectReachedTheTool(await expandItem(straddling));
      await straddling.close();

      // (b) ALIGNED, from that same phase: `waitForWindowBoundary` crosses the
      //     boundary BEFORE the first call, so the gap that straddled in (a)
      //     now falls inside one window and the second call is refused. Same
      //     budget, same two calls, same spacing, opposite verdict.
      await waitUntilJustBeforeBoundary();
      await waitForWindowBoundary(ALIGNED_WINDOW_MS);
      const aligned = await connect();
      expectReachedTheTool(await expandItem(aligned));
      await sleep(CALL_GAP_MS);
      const refused = await expandItem(aligned);
      expect(refused.isError).toBe(true);
      expect(textOf(refused.content)).toContain(RATE_LIMITED_CODE);
      await aligned.close();
    },
    REPRODUCTION_TIMEOUT_MS,
  );

  it('the PERMISSION gate runs FIRST — a denied call never spends the generation budget', async () => {
    // The ordering `registerMcpTools` composes for. `expand_item` needs
    // `ai:plan` (Story MOTIR-2572); a browse-only token is refused for
    // PERMISSION, and the budget it could not reach is still whole afterwards.
    // The two limits are independent and BOTH apply: `ai:plan` decides whether
    // this token may submit at all, `ai:generate` how much is left to spend.
    //
    // The window pin is what makes that last clause mean anything: an unpinned
    // window could reset between the denials and the final call, and then "the
    // budget is still whole" would hold for a reason that has nothing to do with
    // the permission gate — the case would pass while proving nothing.
    await budgetOf(1);
    const readOnly = await connect(['project:browse']);
    for (let i = 0; i < 3; i += 1) {
      const denied = await expandItem(readOnly);
      expect(denied.isError).toBe(true);
      expect(textOf(denied.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(textOf(denied.content)).not.toContain(RATE_LIMITED_CODE);
    }
    await readOnly.close();

    // One unspent unit left: a properly-granted caller still gets its first call.
    const full = await connect();
    expectReachedTheTool(await expandItem(full));
    await full.close();
  });

  it('leaves every NON-billable tool alone, however low the generation budget is', async () => {
    await budgetOf(1);
    const client = await connect();
    for (let i = 0; i < 4; i += 1) {
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(textOf(result)).not.toContain(RATE_LIMITED_CODE);
    }
    await client.close();
  });

  it('registers the SAME tool surface metered or not — the Proxy adds no tools and drops none', async () => {
    const metered = await connect();
    const plain = new Client({ name: 'test', version: '0' });
    const bare = buildMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bare.connect(st), plain.connect(ct)]);

    const names = (list: { tools: { name: string }[] }) => list.tools.map((t) => t.name).sort();
    expect(names(await metered.listTools())).toEqual(names(await plain.listTools()));
    await Promise.all([metered.close(), plain.close()]);
  });

  it('a server built WITHOUT the flag meters nothing (the in-process tool tests)', async () => {
    await budgetOf(1);
    const client = new Client({ name: 'test', version: '0' });
    const server = buildMcpServer(() => ctx); // meterBillableTools defaults to false
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    // All three reach the runner, on a budget that permits one — which is the
    // claim, and is stronger than "none of them said RATE_LIMITED".
    for (let i = 0; i < 3; i += 1) {
      expectReachedTheTool(await expandItem(client));
    }
    await client.close();
  });

  it('passes every non-registerTool member of the server through untouched', () => {
    // The Proxy intercepts exactly one method; anything else it swallowed would
    // break the SDK in ways a tool round-trip would not necessarily show.
    const server = buildMcpServer(() => ctx);
    const wrapped = rateLimitedServer(server, (extra: McpRequestExtra) => {
      void extra;
      return ctx;
    });
    expect(wrapped.server.getClientVersion).toBeTypeOf('function');
    expect(typeof wrapped.connect).toBe('function');
    expect(MCP_SERVER_INFO.name).toBe('motir');
    // And the billable set is non-empty, so none of the above is vacuous.
    expect(MCP_BILLABLE_TOOLS.length).toBeGreaterThan(0);
  });
});
