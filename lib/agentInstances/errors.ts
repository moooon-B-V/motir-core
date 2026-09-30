// Typed errors for the agent-instance lane (Story MOTIR-6860 · MOTIR-6872).
// Every refusal a person can meet is one of these, with the words the Instances
// page shows (the MOTIR-6868 design's panel 5) — never a 500. The
// route maps each `code` to a status in `lib/agentInstances/errorResponse.ts`.

/** An instance that does not exist, is deleted, or is not the caller's (§8) — one answer for all three. */
export class AgentInstanceNotFoundError extends Error {
  readonly code = 'agent_instance_not_found' as const;
  constructor(readonly instanceId: string) {
    super('That agent does not exist.');
    this.name = 'AgentInstanceNotFoundError';
  }
}

/** The name is malformed. */
export class AgentInstanceNameInvalidError extends Error {
  readonly code = 'agent_instance_name_invalid' as const;
  constructor() {
    super('Use lower-case letters, numbers and dashes, up to 40 characters.');
    this.name = 'AgentInstanceNameInvalidError';
  }
}

/** A live instance of the caller's on this project already has the name. */
export class AgentInstanceNameTakenError extends Error {
  readonly code = 'agent_instance_name_taken' as const;
  constructor(readonly instanceName: string) {
    super(`You already have an agent called ${instanceName} on this project.`);
    this.name = 'AgentInstanceNameTakenError';
  }
}

/** §9: the profile is not offered. */
export class AgentProfileNotOfferedError extends Error {
  readonly code = 'agent_profile_not_offered' as const;
  constructor(
    readonly profileId: string,
    displayName: string,
  ) {
    super(
      `${displayName} isn't offered: its terms don't yet allow a platform to host it. Choose another coding agent.`,
    );
    this.name = 'AgentProfileNotOfferedError';
  }
}

/**
 * Which rule refused a start (§5, §6). `ai_plan_required` / `ai_plan_unknown` are
 * `agent-instance-storage.md` §1 and §4's: no paid AI plan, or one that could not
 * be read — asked before every other rule (MOTIR-6918).
 */
export type AgentInstanceRefusalReason =
  | 'ai_plan_required'
  | 'ai_plan_unknown'
  | 'credits'
  | 'credits_unknown'
  | 'user_cap'
  | 'fleet_busy';

/** A create or wake refused BEFORE anything was booted (§5, §6). */
export class AgentInstanceStartRefusedError extends Error {
  readonly code = 'agent_instance_start_refused' as const;
  constructor(
    readonly reason: AgentInstanceRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'AgentInstanceStartRefusedError';
  }
}

/** The move is not legal from the instance's current state (§4). */
export class AgentInstanceStateConflictError extends Error {
  readonly code = 'agent_instance_state_conflict' as const;
  constructor(
    readonly instanceId: string,
    readonly state: string,
    action: string,
  ) {
    super(`This agent is ${state}, so it can't be ${action} right now.`);
    this.name = 'AgentInstanceStateConflictError';
  }
}

/** The lane is not configured on this deployment. */
export class AgentInstancesUnavailableError extends Error {
  readonly code = 'agent_instances_unavailable' as const;
  constructor(detail: string) {
    super(`Personal agents are not available on this deployment: ${detail}`);
    this.name = 'AgentInstancesUnavailableError';
  }
}

/**
 * The agent's image has no terminal server (`agent-terminal.md` Q3, Q8): it was
 * made before the terminal existed. Recorded on the instance by the boot probe
 * (`terminalServer: 'absent'` on its DTO); the terminal ticket refuses with it.
 * The agent stays usable otherwise — moving it to a newer image is MOTIR-6862's.
 */
export class AgentInstanceNoTerminalServerError extends Error {
  readonly code = 'no_terminal_server' as const;
  constructor(readonly instanceId: string) {
    super('This agent was made before the terminal existed, so its image has no terminal to open.');
    this.name = 'AgentInstanceNoTerminalServerError';
  }
}

/**
 * The terminal ticket's ownership refusal (`agent-terminal.md` Q3, MOTIR-6940):
 * the caller does not own this agent — whatever their role, a manager's
 * included (`agent-instances.md` §8). ALSO the answer for an agent that does not
 * exist or is deleted, so the refusal leaks nothing about someone else's agent:
 * the same `not_owner` for all three, as the other instance routes answer
 * `agent_instance_not_found` for all three.
 */
export class AgentTerminalNotOwnerError extends Error {
  readonly code = 'not_owner' as const;
  constructor(readonly instanceId: string) {
    super('Only the person who made this agent can open its terminal.');
    this.name = 'AgentTerminalNotOwnerError';
  }
}

/**
 * The terminal ticket's state refusal (`agent-terminal.md` Q3, Q6): the agent is
 * not `running`. The panel wakes it through the existing Wake route and asks
 * again — the relay never wakes anything, so waking stays in one place.
 */
export class AgentInstanceNotRunningError extends Error {
  readonly code = 'not_running' as const;
  constructor(
    readonly instanceId: string,
    readonly state: string,
  ) {
    super(`This agent is ${state}. Wake it to open its terminal.`);
    this.name = 'AgentInstanceNotRunningError';
  }
}
