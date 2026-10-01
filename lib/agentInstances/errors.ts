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
 * be read — asked before every other rule (MOTIR-6918). `org_running_cap` is the
 * organisation's own running cap (AMENDMENT 3, MOTIR-6926), carrying the `limit`
 * the words name; `fleet_busy` is left for the operator's kill switch alone.
 */
export type AgentInstanceRefusalReason =
  | 'ai_plan_required'
  | 'ai_plan_unknown'
  | 'credits'
  | 'credits_unknown'
  | 'user_cap'
  | 'org_running_cap'
  | 'fleet_busy';

/** A create or wake refused BEFORE anything was booted (§5, §6). */
export class AgentInstanceStartRefusedError extends Error {
  readonly code = 'agent_instance_start_refused' as const;
  constructor(
    readonly reason: AgentInstanceRefusalReason,
    message: string,
    /** The number a cap refusal names (`org_running_cap`), so the page renders it. */
    readonly limit?: number,
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

// ── Starting a card's run in an agent (MOTIR-7026 · `agent-instance-run.md` §4) ──
//
// The start's own refusals, each raised BEFORE anything is opened, claimed or
// woken. The rest of the §4 refusal set is shared: `agent_instance_not_found`,
// `agent_instance_state_conflict`, the wake's `agent_instance_start_refused`
// (passed through unchanged), `agent_instance_run_active`
// (`DispatchRunAgentBusyError`) and `hosted_repository_not_writable`.

/** The agent is on another project than the card (409). */
export class AgentInstanceWrongProjectError extends Error {
  readonly code = 'agent_instance_wrong_project' as const;
  constructor(readonly instanceId: string) {
    super('This agent works on another project, so it can’t run this card.');
    this.name = 'AgentInstanceWrongProjectError';
  }
}

/** The card cannot be run now — its status, or an open blocker, named in `detail` (409). */
export class AgentRunCardNotReadyError extends Error {
  readonly code = 'agent_run_card_not_ready' as const;
  constructor(
    readonly workItemKey: string,
    readonly detail: string,
  ) {
    super(`${workItemKey} isn’t ready to run: ${detail}.`);
    this.name = 'AgentRunCardNotReadyError';
  }
}

/**
 * The agent's image predates the run launcher (409) — or was never probed for
 * its current digest, which §4 reads as the same thing.
 */
export class AgentInstanceImageTooOldError extends Error {
  readonly code = 'agent_instance_image_too_old' as const;
  constructor(readonly instanceId: string) {
    super('This agent was made before agents could run cards. Move it to a newer image first.');
    this.name = 'AgentInstanceImageTooOldError';
  }
}

/** The agent's coding agent has no unattended command (§3) (409). */
export class AgentProfileCannotRunError extends Error {
  readonly code = 'agent_profile_cannot_run' as const;
  constructor(
    readonly profileId: string,
    displayName: string,
  ) {
    super(`${displayName} can’t run a card on its own, so this agent can’t run cards.`);
    this.name = 'AgentProfileCannotRunError';
  }
}

/** The agent's coding agent is not signed in (409). */
export class AgentNotSignedInError extends Error {
  readonly code = 'agent_not_signed_in' as const;
  constructor(
    readonly instanceId: string,
    displayName: string,
  ) {
    super(
      `${displayName} isn’t signed in on this agent. Sign in from its terminal, then run again.`,
    );
    this.name = 'AgentNotSignedInError';
  }
}

// ── A live run and the lifecycle (MOTIR-7027 · `agent-instance-run.md` §6) ──

/**
 * Hibernate or Delete refused while the agent is running a card (409). It names
 * the run — and its card, when known — so the page can link it and the person
 * can cancel it first. Nothing was changed.
 */
export class AgentInstanceRunActiveError extends Error {
  readonly code = 'agent_instance_run_active' as const;
  constructor(
    readonly instanceId: string,
    readonly runId: string,
    readonly workItemKey: string | null,
    readonly action: 'hibernated' | 'deleted' | 'updated',
  ) {
    super(
      `This agent is running ${workItemKey ?? `run ${runId}`}, so it can’t be ${action}. Cancel the run first.`,
    );
    this.name = 'AgentInstanceRunActiveError';
  }
}

/** No run in an agent by that id that the caller can see (404) — Cancel's no-leak answer. */
export class AgentRunNotFoundError extends Error {
  readonly code = 'agent_run_not_found' as const;
  constructor(readonly dispatchRunId: string) {
    super(`No run ${dispatchRunId}.`);
    this.name = 'AgentRunNotFoundError';
  }
}

/** Only the agent's owner may cancel a run in it — `agent-instances.md` §8 (403). */
export class AgentRunCancelForbiddenError extends Error {
  readonly code = 'agent_run_cancel_forbidden' as const;
  constructor(readonly dispatchRunId: string) {
    super('Only the owner of the agent can cancel a run in it.');
    this.name = 'AgentRunCancelForbiddenError';
  }
}

/** The run in the agent has already ended — there is nothing to cancel (409). */
export class AgentRunAlreadyEndedError extends Error {
  readonly code = 'agent_run_already_ended' as const;
  constructor(
    readonly dispatchRunId: string,
    readonly status: string,
  ) {
    super(`This run has already ended (${status}).`);
    this.name = 'AgentRunAlreadyEndedError';
  }
}

/**
 * Update refused: the agent already runs the newest published image
 * (`agent-image-update.md` Q8, MOTIR-6952) — a stale page pressed it (409).
 */
export class AgentInstanceUpToDateError extends Error {
  readonly code = 'agent_instance_up_to_date' as const;
  constructor(
    readonly instanceId: string,
    readonly version: string | null,
  ) {
    super(
      version
        ? `This agent already runs the newest version (${version}).`
        : 'This agent already runs the newest version.',
    );
    this.name = 'AgentInstanceUpToDateError';
  }
}

/**
 * Update refused: the registry could not be asked which image is newest (Q8,
 * MOTIR-6952) — a wait, never "up to date" (503).
 */
export class AgentImageCatalogUnavailableError extends Error {
  readonly code = 'agent_image_catalog_unavailable' as const;
  constructor() {
    super('Motir couldn’t check for a newer version just now. Try again in a few minutes.');
    this.name = 'AgentImageCatalogUnavailableError';
  }
}
