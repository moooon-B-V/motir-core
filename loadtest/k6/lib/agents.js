// WHICH AGENT A VU IS, AND WHAT IT SENDS (Story MOTIR-8538 · MOTIR-8675).
//
// Each k6 VU is ONE agent: one `agents[]` entry of the seed manifest
// (loadtest/seed/manifest.ts), held for the whole run, so many VUs share a user and
// a workspace exactly as the seed laid them out. Every argument a VU sends comes
// from that agent's OWN project (or its own burst slot), so every call runs under
// its own workspace RLS and never reaches into another tenant.
//
// PURE: no k6 import, so vitest runs it.

/**
 * Each tool's input keys, read from `tools/list` against the working SHA (an
 * in-process call through app/api/mcp/route.ts with a project-bound token,
 * 2026-10-15), never from memory. Every tool in the mix is strict about unknown
 * keys (`additionalProperties: false`), so a drifted name would answer a JSON-RPC
 * -32602 on every call; the unit test checks every argument set `pickArgs` builds
 * against these.
 */
export const TOOL_SCHEMAS = Object.freeze({
  get_work_item: { required: ['key'], properties: ['key', 'planId'] },
  search_work_items: {
    required: ['projectKey'],
    properties: ['projectKey', 'filter', 'cursor', 'limit', 'planId'],
  },
  skeleton: { required: ['projectKey'], properties: ['projectKey', 'limit'] },
  get_plan: { required: ['planId'], properties: ['planId'] },
  update_work_item: {
    required: ['key'],
    // The fields this mix sends; the tool takes more (title, descriptionMd, …).
    properties: ['key', 'title', 'priority', 'assigneeId'],
  },
  transition_status: { required: ['key', 'status'], properties: ['key', 'status'] },
  add_comment: { required: ['key', 'body'], properties: ['key', 'body'] },
  add_plan_items: {
    required: ['planId', 'proposals'],
    properties: ['planId', 'proposals', 'final', 'revision'],
  },
  claim_work_item: { required: ['key'], properties: ['key'] },
  move_to_parent: { required: ['key'], properties: ['key', 'parentKey', 'folderId'] },
});

/**
 * The pair the write scenario cycles a write-pool card along. Both directions are
 * declared edges of the default workflow (lib/workflows/defaultWorkflow.ts
 * `DEFAULT_TRANSITIONS`: `['todo', 'in_progress']` and `['in_progress', 'todo']`),
 * so a `restricted` transition policy cannot turn the cycle into an error.
 */
export const TRANSITION_PAIR = Object.freeze(['in_progress', 'todo']);

const PRIORITIES = ['low', 'medium', 'high'];

const mod = (n, m) => ((n % m) + m) % m;

/** The agents of `role` in manifest order. `burst` = the write agents that own a burst slot. */
export function agentsOfRole(manifest, role) {
  if (role === 'burst') return manifest.agents.filter((a) => a.role === 'write' && a.burst);
  return manifest.agents.filter((a) => a.role === role);
}

/**
 * A stable agent for VU `vuId`: the same id always gets the same agent, and
 * consecutive ids walk every agent of the role. For `burst` the answer is a
 * `write` agent together with its own burst slot (`agent.burst`), so two burst VUs
 * below the slot count never share a pool or a parent pair.
 */
export function pickAgent(manifest, role, vuId) {
  const list = agentsOfRole(manifest, role);
  if (list.length === 0) throw new Error(`the manifest has no ${role} agents`);
  const agent = list[mod(vuId, list.length)];
  return role === 'burst' ? { agent, slot: agent.burst } : { agent, slot: null };
}

/** The agent's own project in the manifest. */
export function projectOf(manifest, agent) {
  const project = manifest.projects.find((p) => p.id === agent.projectId);
  if (!project) throw new Error(`agent's project ${agent.projectKey} is not in the manifest`);
  return project;
}

/**
 * This agent's share of a project pool: the pool is dealt round-robin over the
 * project's agents of the same role, so two agents rarely race one card. An agent
 * left with no card (more agents than cards) falls back to the whole pool.
 */
export function shareOf(manifest, agent, pool) {
  const peers = manifest.agents.filter(
    (a) => a.projectId === agent.projectId && a.role === agent.role,
  );
  const pos = peers.findIndex((a) => a.tokenId === agent.tokenId);
  const mine = pool.filter((_, i) => i % peers.length === pos);
  return mine.length > 0 ? mine : pool;
}

/** Read plans of the agent's WORKSPACE (the seed lays them in its first project). */
export function readPlansOf(manifest, agent) {
  return manifest.projects
    .filter((p) => p.workspaceId === agent.workspaceId)
    .flatMap((p) => p.readPlanIds);
}

/**
 * The arguments for `tool`, drawn only from what this agent owns. `n` is the
 * VU's iteration counter, so successive iterations walk the agent's cards in turn.
 */
export function pickArgs(manifest, agent, tool, n = 0) {
  const project = projectOf(manifest, agent);
  const pick = (list) => list[mod(n, list.length)];
  switch (tool) {
    case 'get_work_item': {
      const cards = [...project.content.stories, ...project.content.subtasks];
      return { key: pick(cards).key };
    }
    case 'search_work_items':
      return { projectKey: project.key, limit: 25 };
    case 'skeleton':
      return { projectKey: project.key, limit: 50 };
    case 'get_plan':
      // The seed's fixed-size READ plans, never a scratch plan: those grow with
      // every append, which would make read latency drift with the run.
      return { planId: pick(readPlansOf(manifest, agent)) };
    case 'update_work_item': {
      const key = pick(shareOf(manifest, agent, project.pools.write)).key;
      return n % 2 === 0
        ? { key, title: `[loadtest] write-pool card, revision ${n}` }
        : { key, priority: PRIORITIES[mod(n, PRIORITIES.length)] };
    }
    case 'transition_status':
      return {
        key: pick(shareOf(manifest, agent, project.pools.write)).key,
        status: TRANSITION_PAIR[0],
      };
    case 'add_comment':
      return {
        key: pick(shareOf(manifest, agent, project.pools.write)).key,
        body: `load-test comment ${n}`,
      };
    case 'add_plan_items':
      // One title-only `add`, no `parentRef` (so no committed card becomes a plan
      // target and none is parked at `planning`), never `final` (the plan stays
      // `generating`), on one of this agent's own SCRATCH plans.
      return {
        planId: pick(agent.scratchPlanIds),
        proposals: [{ op: 'add', proposedFields: { title: `load-test proposal ${n}` } }],
      };
    case 'claim_work_item':
      return { key: pick(shareOf(manifest, agent, project.pools.claim)).key };
    case 'move_to_parent': {
      // Round r of the burst moves card i to the parent it is NOT under: every
      // card starts under parents[0], so round 0 moves to parents[1], round 1 back.
      const slot = agent.burst;
      if (!slot) throw new Error(`agent ${agent.tokenId} has no burst slot`);
      const size = slot.cards.length;
      return {
        key: slot.cards[mod(n, size)].key,
        parentKey: slot.parents[mod(Math.floor(n / size) + 1, 2)].key,
      };
    }
    default:
      throw new Error(`no argument picker for ${tool}`);
  }
}

/**
 * Pick a tool by weight. `weights` is `{ tool: number }`; `r` is a number in
 * [0, 1) (k6's Math.random in a scenario, fixed in a test).
 */
export function weightedPick(weights, r) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) throw new Error('no tool has a positive weight');
  let x = r * total;
  for (const [tool, w] of entries) {
    if (x < w) return tool;
    x -= w;
  }
  return entries[entries.length - 1][0];
}
