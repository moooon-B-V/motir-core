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

/** The published sandbox image repository (public; `fleet-image-pull.md` §0). */
export const SANDBOX_IMAGE_REPOSITORY = 'ghcr.io/moooon-b-v/motir-sandbox';

/** The moving tag a profile's image is published under — pinned to a DIGEST at create (§1). */
export function sandboxImageTag(profileId: string): string {
  return `${SANDBOX_IMAGE_REPOSITORY}:${profileId}`;
}
