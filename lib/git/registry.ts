import type { GitProvider } from './provider';
import type { GitProviderId } from './types';

// The provider registry (Story 7.10 · MOTIR-891) — a map of provider id →
// `GitProvider` impl. Consumers resolve the impl by a stored row's `provider`
// discriminator and dispatch through the interface; registration is the ONE
// place a new provider is wired (implement the interface + register it). Built-in
// providers register themselves at import (see `lib/git/index.ts`, which imports
// them for their registration side-effect and re-exports `getGitProvider`).

const registry = new Map<GitProviderId, GitProvider>();

/** Register a provider impl under its `id`. Idempotent — last registration wins
 *  (which a test can exploit to swap in a fake). */
export function registerGitProvider(provider: GitProvider): void {
  registry.set(provider.id, provider);
}

/** No provider is registered for the requested id. */
export class UnknownGitProviderError extends Error {
  readonly code = 'UNKNOWN_GIT_PROVIDER' as const;
  constructor(id: string) {
    super(`No Git provider registered for "${id}".`);
    this.name = 'UnknownGitProviderError';
  }
}

/** Resolve a registered provider by id, or throw {@link UnknownGitProviderError}. */
export function getGitProvider(id: GitProviderId): GitProvider {
  const provider = registry.get(id);
  if (!provider) throw new UnknownGitProviderError(id);
  return provider;
}

/** The currently-registered provider ids — diagnostics / tests. */
export function registeredGitProviderIds(): GitProviderId[] {
  return [...registry.keys()];
}
