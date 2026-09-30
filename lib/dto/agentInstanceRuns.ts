import type {
  AgentInstanceState,
  AgentRunLauncher,
  AgentSignInState,
} from '@/generated/prisma/client';

// The DTOs of STARTING A CARD'S RUN IN AN AGENT (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §4) — what `POST
// /api/work-items/[id]/agent-runs` answers and what `GET …/agent-runs/agents`
// lists for the card's agent picker (MOTIR-7028).
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — `lib/dto/agentInstances.ts`'s
// rule, for its reason.

export type { AgentRunLauncher, AgentSignInState };

/** A start that opened (or, on a repeated key, found) its run. */
export interface AgentRunStartedDto {
  dispatchRunId: string;
  /** False when `idempotencyKey` named a run already started: nothing new happened. */
  created: boolean;
  /**
   * True when this start woke the agent. The launch waits for it to come up; a
   * start refused after its wake leaves the machine to the idle rule.
   */
  woke: boolean;
}

/**
 * Why one agent cannot run a card right now — the §4 refusals that belong to the
 * AGENT rather than to the card. The words are the design's (MOTIR-7022); the
 * codes are the start's own, so the picker and a refused start agree.
 */
export type AgentRunAgentRefusal =
  | 'agent_instance_run_active'
  | 'agent_instance_image_too_old'
  | 'agent_profile_cannot_run'
  | 'agent_not_signed_in'
  | 'agent_instance_state_conflict';

/** The run an agent is already running, named so the words can link it. */
export interface AgentRunningRunDto {
  id: string;
  /** The card it works on — its scope target, else its first leg. */
  workItemKey: string | null;
  /**
   * That card's title (MOTIR-7028) — the picker's busy row names the work item
   * by key and title. Null when the key is unknown or its card was deleted.
   */
  workItemTitle: string | null;
}

/** One of the caller's agents on the card's project, as the picker offers it. */
export interface AgentForCardDto {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  state: AgentInstanceState;
  /** Whether the image can run a card — `unknown` when never probed for its current digest. */
  runLauncher: AgentRunLauncher;
  /** The last answered sign-in; `unknown` when it cannot be (or never was) told. */
  signInState: AgentSignInState;
  signInCheckedAt: string | null;
  runningRun: AgentRunningRunDto | null;
  /** Null when the agent can run a card now (waking it first if it sleeps). */
  refusal: AgentRunAgentRefusal | null;
}

export interface AgentsForCardDto {
  agents: AgentForCardDto[];
}
