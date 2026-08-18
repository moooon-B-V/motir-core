// Agent-authored plan E2E seed (Story MOTIR-2982 · Subtask MOTIR-2993).
//
// The flow this spec proves starts OUTSIDE the browser: an agent authoring a
// plan is an HTTP call to `/api/mcp` carrying a bearer, not a click. So the
// fixture mints a REAL project-scoped API token with the two permissions the
// contract decision names, and the spec drives the tools through the real MCP
// SDK against the lane's own server — the same shape `cli-connect-seed.ts`
// already proves reachable (`mcpBearerWorks`).
//
// ⚠️ NO STUB, deliberately. A `page.route` interception would make the spec
// assert its own harness rather than the product: the whole claim is that an
// arbitrary token-holding agent can author a plan a person then approves, and a
// stubbed transport proves nothing about the gate, the permission map, or the
// provenance the tools stamp.
//
// Everything else rides the SHIPPED services, exactly as `plans-review-seed.ts`
// does — the one sanctioned cross-layer reach for E2E setup.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/** Satisfies the credential-strength rule (same shape as plans-review-seed's). */
export const AGENT_PLAN_SEED_PASSWORD = 'agent-authored-plan-e2e-pass-7';

const BASE_URL = process.env.MOTIR_BASE_URL ?? 'http://localhost:3000';

/** The harness/model the seeded "agent" self-reports — asserted on screen. */
export const AGENT_HARNESS = 'Claude Code';
export const AGENT_MODEL = 'claude-opus-5';
/** Deliberately longer than the row's 12rem harness bound (design Part III §5). */
export const LONG_HARNESS = 'acme-internal-planning-harness v4 (nightly build, us-east)';

export interface AgentPlanSeed {
  email: string;
  password: string;
  /** The person who reviews — and, being the token's owner, the REQUESTER the
   *  surface names on every plan the agent authors with it. */
  reviewerName: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** The bearer an agent authors with. Bound to the project, carrying exactly
   *  `work_item:edit` + `ai:view_plan`. */
  token: string;
  /** A plan with NO recorded author — every plan predating the columns is in
   *  this state, and the list must render it without a placeholder. */
  unattributedPlanId: string;
}

export async function seedAgentAuthoredPlan(email: string): Promise<AgentPlanSeed> {
  const reviewerName = 'Mara Okafor';
  const owner = await usersService.createUser({
    email,
    password: AGENT_PLAN_SEED_PASSWORD,
    name: reviewerName,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Agent Plans E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Marketplace payouts',
    identifier: 'AGP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // `/plans` is ACTIVE-PROJECT scoped, so pin it for the owner — the same pin
  // plans-review-seed makes, for the same reason.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  // The token the agent authors with. The two keys are the ones
  // `docs/decisions/agent-authored-plans.md` Q2 pins — `work_item:edit` for
  // `create_plan` and `ai:view_plan` for `add_plan_items` — so a token holding
  // only one of them cannot complete the flow, and this fixture is what proves
  // the pair is sufficient rather than merely declared.
  const minted = await apiTokensService.create(owner.id, workspace.id, {
    label: 'agent-authored-plan-e2e',
    projectId: project.id,
    permissions: ['work_item:edit', 'ai:view_plan'],
  });

  // A plan from before the authorship columns existed: no requester, no author,
  // no job. The list must show it with the entry ABSENT, not with a placeholder.
  const unattributed = await plansService.createPlan(
    project.id,
    { title: 'Crypto wallet checkout', summary: 'Crypto wallet checkout' },
    ctx,
  );
  await plansService.addProposals(
    unattributed.id,
    [{ op: 'add', proposedFields: { title: 'Legacy proposal', kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(unattributed.id, ctx);

  return {
    email,
    password: AGENT_PLAN_SEED_PASSWORD,
    reviewerName,
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: 'AGP',
    token: minted.token,
    unattributedPlanId: unattributed.id,
  };
}

/** An MCP session over the REAL streamable-HTTP transport, as an agent opens one. */
export async function agentSession(token: string): Promise<Client> {
  const client = new Client({ name: 'agent-authored-plan-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', BASE_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const struct = (r: CallToolResult) => r.structuredContent as unknown as PlanWithItemsDto;
const itemIds = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

/**
 * Author a two-layer tree the way the story's verification recipe describes it:
 * `create_plan`, then `add_plan_items` TWICE — the second batch naming the
 * first's returned ids as `parentRef`, with `final: true` on the last.
 *
 * Returns the plan id and the proposed titles, so the spec can assert both that
 * they render as PROPOSALS and, later, that they became work items.
 */
export async function authorPlanOverMcp(
  client: Client,
  projectKey: string,
  opts: { title: string; harness: string; model?: string },
): Promise<{ planId: string; storyTitle: string; leafTitles: string[] }> {
  const created = await client.callTool({
    name: CREATE_PLAN_TOOL_NAME,
    arguments: {
      projectKey,
      title: opts.title,
      summary: opts.title,
      plannedWithHarness: opts.harness,
      ...(opts.model ? { plannedWithModel: opts.model } : {}),
    },
  });
  const planId = struct(created as CallToolResult).id;

  const storyTitle = 'Seller payouts';
  const first = (await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      proposals: [{ op: 'add', proposedFields: { title: storyTitle, kind: 'story' } }],
    },
  })) as CallToolResult;

  const leafTitles = ['Payout schedule', 'Payout failure retries'];
  await client.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: {
      planId,
      final: true,
      proposals: leafTitles.map((title) => ({
        op: 'add',
        proposedFields: { title, kind: 'subtask', storyPoints: 3, estimateMinutes: 45 },
        // The temp-ref contract: the id the FIRST call returned, naming a
        // proposal that is not a work item and never will be until approve.
        parentRef: `planItem:${itemIds(first)[0]}`,
      })),
    },
  });

  return { planId, storyTitle, leafTitles };
}
