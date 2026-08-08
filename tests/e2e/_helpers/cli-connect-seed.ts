import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { CLI_CLIENT_ID } from '@/lib/cliDevice/constants';

// Seed + terminal-side helpers for the CLI-connect acceptance E2E (Story
// MOTIR-1863 · Subtask MOTIR-1871).
//
// TWO SIDES, TWO TRANSPORTS, and keeping them apart is the point of this module.
// The BROWSER half (`page`) is the human at `/device`; the TERMINAL half is a
// plain `APIRequestContext` with NO session cookie, because that is what a
// terminal actually is — a process holding a `device_code` and nothing else. A
// spec that polled through the page's context would prove the browser can
// finish its own grant, which is not the claim under test.
//
// The routes are `/api/cli/device/*`, NOT `/api/auth/device/*`. Motir owns the
// CLI-facing routes and keeps Better-Auth's plugin a private implementation
// detail (`docs/decisions/cli-login.md`; `lib/services/cliDeviceService.ts`
// states why). The one plugin endpoint the flow does call directly is
// `POST /api/auth/device/deny`, which `DeviceApproval` calls for the same
// reason — deny mints nothing, so there is no Motir-side wrapper.

export const CLI_CONNECT_PASSWORD = 'cli-connect-e2e-pass-123';

/** Mirror the acceptance lane's BASE_URL derivation (playwright.acceptance.config.ts)
 *  so a worktree run on a custom port targets the same origin the server bound to. */
export const BASE_URL =
  process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3200'}`;

export interface CliConnectSeed {
  email: string;
  password: string;
  userId: string;
  /** The workspace the user lands in — NOT the one the recording approves into. */
  homeWorkspaceId: string;
  homeWorkspaceLabel: string;
  /** The SECOND workspace, under the same org: what makes the approval screen
   *  render its picker, and the binding the granted token must carry. */
  targetWorkspaceId: string;
  targetWorkspaceLabel: string;
}

/**
 * A sign-in-able user who belongs to TWO workspaces.
 *
 * Two, because the card's happy path approves "choosing the workspace on a
 * multi-workspace account" — and the confirm screen renders the picker only at
 * `workspaces.length > 1` (`DeviceApproval`, design Panels 3 + 4). One workspace
 * would silently exercise the picker-absent variant instead.
 *
 * ⚠️ THE ORG MUST BE PAID, and that is a property of the LANE, not a shortcut.
 * This lane runs cloud-on (`MOTIR_CLOUD=true`, playwright.acceptance.config.ts),
 * so §4's entitlement gates are LIVE — and they close both routes to a second
 * workspace on a free account: `assertWithinWorkspaceCap` caps a free org at ONE
 * workspace, and `assertCanCreateOrganization` refuses a second ORG unless the
 * user already owns a paid one. (Both were hit, in that order, writing this
 * spec.) A multi-workspace Motir account on cloud IS a paid account, so the seed
 * models one rather than working around the gate.
 *
 * `aiIncludedSeat` is the shipped lever for exactly this: `pmTierForOrg` reads it
 * as "a PAID Motir AI plan bundles a Motir seat → caps lifted" (ADR §4, amended
 * 8.1.22), the same `scaled` outcome a purchased scaled-tracker subscription
 * gives. Set on the ROW, because that is where the shipped code reads it from —
 * the AI-billing fixture is the motir-ai boundary mock and does not feed this.
 */
export async function seedCliConnect(email: string): Promise<CliConnectSeed> {
  const user = await usersService.createUser({
    email,
    password: CLI_CONNECT_PASSWORD,
    name: 'Connect Owner',
  });

  // The FIRST workspace mints the default org, which reuses its name — so this
  // name is also the `org` half of both picker labels below.
  const home = await workspacesService.createWorkspace({
    name: 'Moon Labs',
    ownerUserId: user.id,
  });
  const { organizationId } = await db.workspace.findUniqueOrThrow({
    where: { id: home.workspace.id },
    select: { organizationId: true },
  });
  await db.organization.update({
    where: { id: organizationId },
    data: { aiIncludedSeat: true },
  });

  // Now a second workspace fits — under the SAME org, so the two picker options
  // differ only in the workspace half and the assertion is about the choice the
  // approver actually makes.
  const target = await workspacesService.createWorkspace({
    name: 'Ship It',
    ownerUserId: user.id,
    organizationId,
  });

  // A project in the home workspace so the signed-in shell has somewhere to be;
  // the grant itself needs none.
  const project = await projectsService.createProject({
    name: 'Connect Delivery',
    identifier: 'CON',
    workspaceId: home.workspace.id,
    actorUserId: user.id,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: home.workspace.id } },
    data: { activeProjectId: project.id },
  });

  return {
    email,
    password: CLI_CONNECT_PASSWORD,
    userId: user.id,
    homeWorkspaceId: home.workspace.id,
    homeWorkspaceLabel: await workspaceLabel(home.workspace.id),
    targetWorkspaceId: target.workspace.id,
    targetWorkspaceLabel: await workspaceLabel(target.workspace.id),
  };
}

/** `org · workspace` — the exact label `/device`'s page builds its picker from,
 *  read back from the rows rather than reassembled from the names passed in. */
async function workspaceLabel(workspaceId: string): Promise<string> {
  const row = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, organization: { select: { name: true } } },
  });
  return `${row.organization.name} · ${row.name}`;
}

// ── The terminal side ────────────────────────────────────────────────────────

export interface DeviceGrant {
  deviceCode: string;
  /** Canonical (dash-free, upper-case) — the form the server stores and matches. */
  userCode: string;
  verificationUriComplete: string;
  /** The server's own minimum poll spacing, in seconds. */
  intervalSeconds: number;
}

/** A cookie-less request context — the terminal, which has no browser session. */
export async function terminalContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
  });
}

/** `motir login` step 1 — open a grant (`POST /api/cli/device/start`). */
export async function startGrant(
  terminal: APIRequestContext,
  hostname: string,
): Promise<DeviceGrant> {
  const res = await terminal.post('/api/cli/device/start', { data: { hostname } });
  expect(res.status(), 'the terminal can open a device grant unauthenticated').toBe(200);
  const body = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    interval: number;
  };
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUriComplete: body.verification_uri_complete,
    intervalSeconds: body.interval,
  };
}

export type PollResult =
  | { kind: 'granted'; accessToken: string; scope: string; workspace: { id: string; name: string } }
  | { kind: 'error'; error: string };

/** One poll of `POST /api/cli/device/token` — the RFC 8628 §3.4 request the CLI sends. */
export async function pollOnce(
  terminal: APIRequestContext,
  grant: DeviceGrant,
): Promise<PollResult> {
  const res = await terminal.post('/api/cli/device/token', {
    data: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.deviceCode,
      client_id: CLI_CLIENT_ID,
    },
  });
  if (res.status() === 200) {
    const body = (await res.json()) as {
      access_token: string;
      scope: string;
      workspace: { id: string; name: string };
    };
    return {
      kind: 'granted',
      accessToken: body.access_token,
      scope: body.scope,
      workspace: body.workspace,
    };
  }
  const body = (await res.json()) as { error?: string };
  return { kind: 'error', error: body.error ?? `http_${res.status()}` };
}

/**
 * The CLI's poll LOOP: re-poll until the grant resolves one way or the other.
 *
 * ⚠️ THE SPACING BETWEEN POLLS IS NOT A SLEEP-FOR-STATE. `interval` is a value
 * the SERVER returned at `start` and then ENFORCES — polling faster than it
 * answers `slow_down` (`cliDeviceService.poll` compares `lastPolledAt` against
 * the row's `pollingInterval`). So honouring it is obeying an authoritative
 * signal, not guessing at one: the loop's exit is always a RESPONSE
 * (`access_token`, `access_denied`, `expired_token`), never a timer, and the
 * deadline below exists only to fail loudly instead of hanging.
 */
export async function pollUntilResolved(
  terminal: APIRequestContext,
  grant: DeviceGrant,
  timeoutMs = 60_000,
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await pollOnce(terminal, grant);
    if (result.kind === 'granted') return result;
    if (result.error !== 'authorization_pending' && result.error !== 'slow_down') return result;
    if (Date.now() >= deadline) {
      throw new Error(`the device grant never resolved (last: ${result.error})`);
    }
    await new Promise((resolve) => setTimeout(resolve, grant.intervalSeconds * 1000));
  }
}

/**
 * Age a grant out, so the expired screen can be reached without waiting fifteen
 * real minutes. Writes the ROW the service reads (`expiresAt`), which is the
 * same fact a real expiry produces — not a stubbed clock and not a mocked route.
 */
export async function expireGrant(userCode: string): Promise<void> {
  await db.deviceCode.update({
    where: { userCode },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
}

// ── The credential, exercised for real ───────────────────────────────────────

/**
 * Does this bearer actually work against the shipped MCP endpoint?
 *
 * Driven through the SAME SDK client + streamable-HTTP transport `packages/cli`
 * uses (`client.ts`), against the real `/api/v1` — so a `true` here means
 * the token passed `withMcpAuth`'s gate and the server completed a real MCP
 * handshake, not that some hand-rolled JSON-RPC body happened to 200.
 *
 * Returns `false` on the 401 the gate answers for an absent / revoked / expired
 * token, and rethrows anything else: "revoked" and "the endpoint broke" must
 * never be the same assertion.
 */
export async function mcpBearerWorks(accessToken: string): Promise<boolean> {
  const client = new Client({ name: 'motir-cli-connect-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', BASE_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length, 'an authenticated MCP session exposes the tool surface').toBeGreaterThan(
      0,
    );
    return true;
  } catch (err) {
    if (isUnauthorized(err)) return false;
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

/** The transport surfaces the gate's 401 as an error carrying that code — the
 *  same test `packages/cli/src/client.ts` makes to detect a dead credential. */
function isUnauthorized(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 401) return true;
  return /\b401\b|unauthor/i.test(err instanceof Error ? err.message : String(err));
}
