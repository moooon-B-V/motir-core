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
      `${displayName} isn't offered: its terms don't yet allow a platform to host it. Choose another agent.`,
    );
    this.name = 'AgentProfileNotOfferedError';
  }
}

/** Which rule refused a start (§5, §6). */
export type AgentInstanceRefusalReason =
  | 'credits'
  | 'credits_unknown'
  | 'org_cap'
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
