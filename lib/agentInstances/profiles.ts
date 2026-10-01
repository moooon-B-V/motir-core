// THE SANDBOX PROFILES AN INSTANCE MAY BE CREATED FROM (Story MOTIR-6860 ·
// MOTIR-6872) — `docs/decisions/agent-instances.md` §9, as data.
//
// ⚠️ THE LIST IS THE DECISION'S, NOT THE IMAGE MATRIX'S. The sandbox publishes
// eight agent profiles (`packages/cli/sandbox/smoke/profiles.json`); a profile is
// OFFERED only where its vendor's terms allow a platform to host the unmodified
// CLI on the user's own credential. Antigravity (forbidden) and Cursor (terms
// silent) are not offered, and a create naming either is refused by name.

/** One offered profile. */
export interface OfferedAgentProfile {
  /** The sandbox profile id — the image tag suffix. */
  readonly id: string;
  /** The agent's display name. */
  readonly name: string;
}

/** §9's six offered profiles, in the order the create dialog lists them. */
export const OFFERED_AGENT_PROFILES: readonly OfferedAgentProfile[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kimi', name: 'Kimi Code' },
  { id: 'aider', name: 'Aider' },
  { id: 'goose', name: 'Goose' },
];

/** The two published profiles §9 does NOT offer, with the display name a refusal uses. */
export const NOT_OFFERED_AGENT_PROFILES: readonly OfferedAgentProfile[] = [
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'cursor', name: 'Cursor' },
];

/** Whether §9 offers this profile. */
export function isOfferedProfile(profileId: string): boolean {
  return OFFERED_AGENT_PROFILES.some((p) => p.id === profileId);
}

/** A profile's display name, offered or not; the raw id for an unknown one. */
export function profileDisplayName(profileId: string): string {
  return (
    [...OFFERED_AGENT_PROFILES, ...NOT_OFFERED_AGENT_PROFILES].find((p) => p.id === profileId)
      ?.name ?? profileId
  );
}

/**
 * The profiles whose coding agent has an UNATTENDED command, so an agent made
 * from one can run a card (`agent-instance-run.md` §3, MOTIR-7026). The command
 * itself is the CLI's (`packages/cli/src/agentProfiles.ts` `agentCommand`), and
 * this list is its non-null set — data on the `lib` side, never imported from
 * `packages/cli` (see {@link AGENT_SIGN_IN_HINTS}); a test holds the two equal.
 */
export const RUNNABLE_AGENT_PROFILE_IDS: readonly string[] = [
  'claude',
  'codex',
  'opencode',
  'kimi',
  'aider',
  'goose',
];

/** Whether an agent made from this profile can run a card (§3). */
export function profileCanRunCards(profileId: string): boolean {
  return RUNNABLE_AGENT_PROFILE_IDS.includes(profileId);
}

/**
 * Each offered profile's LIVENESS command (`agent-image-update.md` Q3,
 * MOTIR-6952): what an image update runs inside the new image before it keeps
 * it — exit 0 within the bound means the coding agent runs. A copy of
 * `packages/cli/sandbox/smoke/profiles.json`'s `liveness`, which the image's own
 * release smoke runs; `tests/agentInstances/agentInstanceUpdate.test.ts` fails
 * the moment the two disagree. Data on the `lib` side, never imported from
 * `packages/cli` (the note below).
 */
export const AGENT_LIVENESS_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude', '--version'],
  codex: ['codex', '--version'],
  opencode: ['opencode', '--version'],
  kimi: ['kimi', '--version'],
  aider: ['aider', '--version'],
  goose: ['goose', '--version'],
};

/** The liveness command for a profile; an unknown profile is checked with `motir --version`. */
export function livenessCommandFor(profileId: string): readonly string[] {
  return AGENT_LIVENESS_COMMANDS[profileId] ?? ['motir', '--version'];
}

/** The published sandbox image repository (public; `fleet-image-pull.md` §0). */
export const SANDBOX_IMAGE_REPOSITORY = 'ghcr.io/moooon-b-v/motir-sandbox';

/** The moving tag a profile's image is published under — pinned to a DIGEST at create (§1). */
export function sandboxImageTag(profileId: string): string {
  return `${SANDBOX_IMAGE_REPOSITORY}:${profileId}`;
}

/**
 * How a person signs each offered coding agent in, from inside the agent's
 * terminal (Story MOTIR-6861 · MOTIR-6941; `design/my-agents/design-notes.md` §
 * the agent panel, panel 3). The panel's sign-in line names these as inline
 * code; the sentence around them is `messages/*.json`'s `myAgents.panel.signin.*`.
 *
 * `checkable` is whether the terminal server can tell (`agent-terminal.md` Q7:
 * the profile has a credential file to stat). For the three it cannot, the
 * values are what the "can't be checked" line names instead: the command to run,
 * or — for Aider, which reads a provider key — the line to add and where.
 *
 * ⚠️ DATA ON THE `lib` SIDE, NEVER IMPORTED FROM `packages/cli`: only
 * `lib/apiDocs/cli.ts` and `lib/apiDocs/sandbox.ts` may import from
 * `packages/cli/**` (`packages/cli/src/commandCatalog.ts`'s header).
 */
export interface AgentSignInHint {
  readonly checkable: boolean;
  /** The inline-code values the sentence names, in order. */
  readonly values: readonly string[];
}

export const AGENT_SIGN_IN_HINTS: Readonly<Record<string, AgentSignInHint>> = {
  claude: { checkable: true, values: ['claude', '/login'] },
  codex: { checkable: true, values: ['codex login --device-auth'] },
  opencode: { checkable: true, values: ['opencode auth login'] },
  kimi: { checkable: false, values: ['kimi'] },
  aider: { checkable: false, values: ['ANTHROPIC_API_KEY=…', '~/.env'] },
  goose: { checkable: false, values: ['goose configure'] },
};

/** A profile's sign-in hint, or null for a profile the table does not know. */
export function agentSignInHint(profileId: string): AgentSignInHint | null {
  return AGENT_SIGN_IN_HINTS[profileId] ?? null;
}
