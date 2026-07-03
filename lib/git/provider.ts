import type {
  ChangeRequestLifecycle,
  GitProviderId,
  InstallationToken,
  NormalizedChangeRequest,
  NormalizedRepo,
  NormalizedStatusEvent,
} from './types';

// The GitProvider seam (Story 7.10 · MOTIR-891). ONE interface every Git host
// implements; consumers dispatch by the stored `provider` discriminator through
// the registry (`lib/git/registry.ts`) and hold NO host-specific types. GitHub
// is the FIRST registered implementation (`lib/git/providers/github.ts`); GitLab
// (7.23) proves additivity by implementing this SAME interface — a new provider
// is exactly "implement this + register it", nothing in the consumers changes.
//
// The interface is defined ALONGSIDE its first implementation (not in a vacuum —
// the MOTIR-1566 planning lesson), so every method here is one GitHub actually
// backs.

export interface GitProvider {
  /** The provider discriminator — matches the stored rows' `provider` column. */
  readonly id: GitProviderId;

  /**
   * Mint a short-lived installation access token, scoped by the host to the
   * installation's repos, from the App/OAuth-app credentials. Cached in-memory
   * until near expiry and re-minted; NEVER persisted. `installationId` is the
   * host's own installation id (GitHub's numeric id as a string).
   */
  mintInstallationToken(installationId: string): Promise<InstallationToken>;

  /**
   * Fetch the repositories reachable on an installation, normalized. Uses a
   * freshly-minted (or cached) installation token.
   */
  fetchInstallationRepos(installationId: string): Promise<NormalizedRepo[]>;

  /**
   * Normalize a raw change-request webhook payload into the provider-agnostic
   * shape, or `null` when the payload is not a change-request event we handle
   * (a different event, or a malformed body).
   */
  parseChangeRequestEvent(rawPayload: unknown): NormalizedChangeRequest | null;

  /**
   * Map a normalized change request to the canonical workflow-lifecycle signal
   * the status sync (MOTIR-892) applies to the linked work item. PURE.
   */
  changeRequestLifecycle(cr: NormalizedChangeRequest): ChangeRequestLifecycle;

  /**
   * Normalize a raw CI / pipeline webhook payload into the provider-agnostic
   * status-event shape, or `null` when it is not one we handle.
   */
  parseCiStatusEvent(rawPayload: unknown): NormalizedStatusEvent | null;
}
