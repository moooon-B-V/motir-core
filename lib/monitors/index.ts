// Public entry for the error-monitor provider seam (Story MOTIR-4926 ·
// MOTIR-5259). Importing this module registers every built-in provider (via each
// provider module's import side-effect) and re-exports the resolver, so a
// consumer does `import { getMonitorProvider } from '@/lib/monitors'` and is
// guaranteed the provider is registered before it resolves one. Import
// `@/lib/monitors`, never `@/lib/monitors/registry` directly, or the
// registration side-effects do not run.

import './providers/sentry'; // side-effect: registers "sentry"
import { fakeMonitorProvider } from './providers/fake'; // side-effect: registers "fake"
import { registerMonitorProvider } from './registry';

/**
 * The environment switch that makes the stored `sentry` discriminator resolve to
 * the FAKE.
 *
 * ⚠️ IT IS AN ENVIRONMENT SWITCH AND NOT A `vi.mock`, AND THAT CONSTRAINT COMES
 * FROM THE E2E CARD (MOTIR-5264). The browser test drives a SEPARATELY-SPAWNED
 * Next server: an in-process module mock is unreachable from that process, so a
 * fake wired that way would leave the E2E hitting the real sentry.io or failing
 * at the network. A switch the server reads at boot is reachable from both.
 *
 * Read ONCE, here, at module evaluation — the registry is a module-level map and
 * a per-call read would let the resolution change under a running request.
 */
export const MONITOR_FAKE_PROVIDER_ENV = 'MOTIR_MONITOR_FAKE_PROVIDER';

if (process.env[MONITOR_FAKE_PROVIDER_ENV] === '1') {
  // Last registration wins: the fake now answers for every row stored with
  // `provider: 'sentry'`, which is what an E2E fixture needs — it cannot reach
  // into the server to swap an implementation, and it should not have to write
  // rows carrying a provider value production never writes.
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
}

export {
  getMonitorProvider,
  registerMonitorProvider,
  registeredMonitorProviderIds,
} from './registry';
export {
  MONITOR_GRANT_EXCHANGE_TIMEOUT_MS,
  MONITOR_HEALTH_TIMEOUT_MS,
  MONITOR_LIST_ISSUES_TIMEOUT_MS,
  MONITOR_LIST_PROJECTS_TIMEOUT_MS,
  MONITOR_REFRESH_TIMEOUT_MS,
  MONITOR_RESOLVE_ISSUE_TIMEOUT_MS,
  MONITOR_VERIFY_INSTALL_TIMEOUT_MS,
} from './provider';
export type { MonitorProvider } from './provider';
export { fakeMonitorProvider } from './providers/fake';
export { sentryMonitorProvider } from './providers/sentry';
export {
  MonitorConnectionAlreadyExistsError,
  MonitorProviderCallError,
  UnknownMonitorProviderError,
} from './errors';
export type {
  MonitorCredential,
  MonitorProviderId,
  NormalizedMonitorHealth,
  NormalizedMonitorIssue,
  NormalizedMonitorIssuePage,
  NormalizedMonitorProject,
} from './types';
