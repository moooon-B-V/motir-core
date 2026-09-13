import { UnknownMonitorProviderError } from './errors';
import type { MonitorProvider } from './provider';
import type { MonitorProviderId } from './types';

// The monitor-provider registry (Story MOTIR-4926 · MOTIR-5259) — a map of
// provider id → `MonitorProvider` impl, mirroring `lib/git/registry.ts`.
// Consumers resolve the impl from a stored row's `provider` discriminator and
// dispatch through the interface; registration is the ONE place a new provider is
// wired. Built-in providers register themselves at import — see
// `lib/monitors/index.ts`, which imports them for that side-effect and
// re-exports the resolver, so always import `@/lib/monitors` and never this
// module directly.

const registry = new Map<MonitorProviderId, MonitorProvider>();

/** Register a provider impl under an id. Idempotent, and LAST REGISTRATION WINS
 *  — which is what lets the fake be selected at runtime (see `index.ts`). */
export function registerMonitorProvider(provider: MonitorProvider, id?: MonitorProviderId): void {
  registry.set(id ?? provider.id, provider);
}

/**
 * Resolve a registered provider by the stored discriminator.
 *
 * ⚠️ AN UNKNOWN DISCRIMINATOR THROWS. It does NOT fall back to the only
 * registered member, however obviously that member is "the one we have": an open
 * discriminant resolved to a plausible default is silent for ever, and the one
 * thing a row written by a future version must not do is get quietly read as a
 * row from this one. The refusal names the value it could not resolve.
 */
export function getMonitorProvider(id: string): MonitorProvider {
  const provider = registry.get(id as MonitorProviderId);
  if (!provider) throw new UnknownMonitorProviderError(id);
  return provider;
}

/** The currently-registered provider ids — diagnostics and tests. */
export function registeredMonitorProviderIds(): MonitorProviderId[] {
  return [...registry.keys()];
}
