// THE SEED SHAPE (Story MOTIR-8538 · MOTIR-8673).
//
// How many synthetic tenants a seed writes, and how its agents and pools are cut.
// The checked-in load profile (MOTIR-8678) carries a `seed` section of this shape
// and passes it in; with no shape file the seed runs `SMOKE_SHAPE`.
//
// Tenancy, deterministically (so a re-seed finds what an earlier one wrote):
//   · workspace w is OWNED by user w (so `users >= workspaces`);
//   · user u is a member of workspaces (u + j) mod workspaces, j < workspacesPerUser,
//     and reads in the first of them — its `readerWorkspaceId`;
//   · every member holds `agentsPerUser` tokens in every workspace it belongs to,
//     split by `agentRoles`, each bound to one of that workspace's projects in turn.
//
// ⚠️ THE WORKSPACE MINIMUM IS A RATE-LIMIT FLOOR, NOT A TASTE. A workspace's agent
// traffic is capped at 12 000 a minute (`agent:workspace`, lib/rateLimit/budgets.ts),
// so the agents are spread over at least 6 workspaces in any non-smoke shape (2 in
// the smoke shape). The profile card computes the actual per-workspace rate; this
// validator only refuses a spread that could not carry a real run at all.

export const AGENT_ROLES = ['read', 'write', 'claim', 'run'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Workspaces a non-smoke shape must spread its agents over. */
export const MIN_AGENT_WORKSPACES = 6;
/** Workspaces the smoke shape must spread its agents over. */
export const MIN_SMOKE_AGENT_WORKSPACES = 2;

export interface SeedShape {
  /** True only for the smoke default — it takes the smoke workspace floor. */
  smoke: boolean;
  users: number;
  workspaces: number;
  /** Workspaces each user is a member of (≤ workspaces). */
  workspacesPerUser: number;
  projectsPerWorkspace: number;
  /** Tokens each user holds in EACH of its workspaces, by role. Their sum is `agentsPerUser`. */
  agentRoles: Record<AgentRole, number>;
  /** The stable backlog every project gets for readers and read tools. */
  content: { stories: number; subtasksPerStory: number };
  /** Cards per project in each consumable pool. */
  pools: { claim: number; run: number; write: number };
  /** Cards each burst agent owns (189 is the 2026-10-13 shape). */
  burstSize: number;
  /** How many `write` agents are burst agents, each with its own pool and parent pair. */
  burstAgents: number;
  /** `planned` plans in every reader workspace, never appended to. */
  readPlansPerWorkspace: number;
  /** `generating` scratch plans per appending (`write`) agent, which `add_plan_items` grows. */
  scratchPlans: number;
}

/** Tens of clients: what `pnpm loadtest:seed` writes when no shape is given. */
export const SMOKE_SHAPE: SeedShape = {
  smoke: true,
  users: 4,
  workspaces: 2,
  workspacesPerUser: 2,
  projectsPerWorkspace: 1,
  agentRoles: { read: 2, write: 1, claim: 1, run: 1 },
  content: { stories: 3, subtasksPerStory: 3 },
  pools: { claim: 6, run: 4, write: 6 },
  burstSize: 12,
  burstAgents: 2,
  readPlansPerWorkspace: 2,
  scratchPlans: 1,
};

/** The tokens one user holds in one workspace. */
export function agentsPerUser(shape: SeedShape): number {
  return AGENT_ROLES.reduce((sum, role) => sum + shape.agentRoles[role], 0);
}

/** Total tokens of `role` the shape mints (every user, every one of its workspaces). */
export function agentCount(shape: SeedShape, role: AgentRole): number {
  return shape.users * shape.workspacesPerUser * shape.agentRoles[role];
}

export class InvalidSeedShapeError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid seed shape:\n${problems.map((p) => `  · ${p}`).join('\n')}`);
    this.name = 'InvalidSeedShapeError';
  }
}

const isCount = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * Validate `input` as a {@link SeedShape}, naming every offending field at once.
 * Accepts a partial override of the smoke shape's nested objects only by being
 * whole: a shape file states every field, so a missing one is refused by name.
 */
export function validateSeedShape(input: unknown): SeedShape {
  const problems: string[] = [];
  if (typeof input !== 'object' || input === null) {
    throw new InvalidSeedShapeError(['the shape is not an object']);
  }
  const s = input as Record<string, unknown>;
  const count = (field: string, value: unknown, min: number) => {
    if (!isCount(value, min)) problems.push(`${field} must be an integer ≥ ${min}`);
  };
  if (typeof s['smoke'] !== 'boolean') problems.push('smoke must be true or false');
  count('users', s['users'], 1);
  count('workspaces', s['workspaces'], 1);
  count('workspacesPerUser', s['workspacesPerUser'], 1);
  count('projectsPerWorkspace', s['projectsPerWorkspace'], 1);
  const roles = (s['agentRoles'] ?? {}) as Record<string, unknown>;
  for (const role of AGENT_ROLES) count(`agentRoles.${role}`, roles[role], 0);
  const content = (s['content'] ?? {}) as Record<string, unknown>;
  count('content.stories', content['stories'], 0);
  count('content.subtasksPerStory', content['subtasksPerStory'], 0);
  const pools = (s['pools'] ?? {}) as Record<string, unknown>;
  for (const pool of ['claim', 'run', 'write']) count(`pools.${pool}`, pools[pool], 0);
  count('burstSize', s['burstSize'], 1);
  count('burstAgents', s['burstAgents'], 0);
  count('readPlansPerWorkspace', s['readPlansPerWorkspace'], 0);
  count('scratchPlans', s['scratchPlans'], 0);
  if (problems.length > 0) throw new InvalidSeedShapeError(problems);

  const shape = input as SeedShape;
  const floor = shape.smoke ? MIN_SMOKE_AGENT_WORKSPACES : MIN_AGENT_WORKSPACES;
  if (shape.workspaces < floor) {
    problems.push(
      `workspaces must be ≥ ${floor} for a ${shape.smoke ? 'smoke' : 'non-smoke'} shape ` +
        `(agent traffic per workspace is capped at 12 000 a minute), got ${shape.workspaces}`,
    );
  }
  if (shape.users < shape.workspaces) {
    problems.push(
      `users must be ≥ workspaces (workspace w is owned by user w), got ${shape.users}`,
    );
  }
  if (shape.workspacesPerUser > shape.workspaces) {
    problems.push(`workspacesPerUser must be ≤ workspaces, got ${shape.workspacesPerUser}`);
  }
  if (shape.burstAgents > agentCount(shape, 'write')) {
    problems.push(
      `burstAgents must be ≤ the write agents the shape mints (${agentCount(shape, 'write')}), got ${shape.burstAgents}`,
    );
  }
  if (problems.length > 0) throw new InvalidSeedShapeError(problems);
  return shape;
}
