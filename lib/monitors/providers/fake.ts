import { MonitorProviderCallError } from '../errors';
import type { MonitorProvider } from '../provider';
import { registerMonitorProvider } from '../registry';
import type {
  MonitorCredential,
  NormalizedMonitorHealth,
  NormalizedMonitorIssue,
  NormalizedMonitorIssuePage,
  NormalizedMonitorProject,
} from '../types';

// The FAKE implementation of the `MonitorProvider` seam (Story MOTIR-4926 ·
// MOTIR-5259) — in-memory state, the same interface, registered in the SAME
// registry as the real adapter.
//
// ⚠️ IT IS A REGISTERED PROVIDER, NOT A `vi.mock`, AND THAT IS A REQUIREMENT
// RATHER THAN A PREFERENCE. The E2E card (MOTIR-5264) drives a browser against a
// separately-spawned Next server: an in-process module mock is unreachable from
// that process, so a fake wired that way would leave the E2E hitting the real
// sentry.io or failing at the network. Selection is therefore an explicit
// environment switch read at boot — `MOTIR_MONITOR_FAKE_PROVIDER=1`, applied in
// `lib/monitors/index.ts` — which both a vitest run and a spawned server can see.
//
// ⚠️ AND IT IS THE REASON THE SUITE NEVER OPENS A SOCKET TO SENTRY.IO. Nothing
// here calls `fetch`. A test that exercises the whole interface through this
// object is exercising the seam, not the host — which is the property the
// story's criteria ask for, and what keeps the suite green when sentry.io is
// down.

/** What the fake will answer, and what it recorded being asked. A test drives it
 *  through this object rather than through a module mock, so the same wiring
 *  works in-process and in a spawned server. */
export interface FakeMonitorState {
  /** Grant exchanges keyed by code — an unknown code is refused, exactly as a
   *  provider refuses a replayed one. */
  grants: Map<string, MonitorCredential>;
  projects: NormalizedMonitorProject[];
  issues: NormalizedMonitorIssue[];
  health: NormalizedMonitorHealth;
  /** Installation ids passed to `verifyInstall`, in order — what proves the
   *  CONNECT card verified rather than only exchanged. */
  verifiedInstallations: string[];
  /** Issue ids passed to `resolveIssue`, in order (MOTIR-4931's consumer). */
  resolvedIssues: string[];
  /** How many refreshes have been asked for, and what the next one returns. */
  refreshCount: number;
  /** Set to make the next call of that operation fail — how a test drives the
   *  `degraded` path and the typed-refusal path without a network. */
  failNext: Set<string>;
}

const freshState = (): FakeMonitorState => ({
  grants: new Map([
    [
      'valid-code',
      {
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    ],
  ]),
  projects: [
    { externalId: 'fake-web', slug: 'web', name: 'Web' },
    { externalId: 'fake-worker', slug: 'worker', name: 'Worker' },
  ],
  issues: [
    {
      externalId: 'fake-issue-1',
      title: 'TypeError: cannot read property of undefined',
      culprit: 'app/page.tsx in render',
      level: 'error',
      eventCount: 12,
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-10T00:00:00.000Z'),
      permalink: 'https://fake.invalid/issues/fake-issue-1',
    },
  ],
  health: { status: 'connected', reason: null, checkedAt: new Date() },
  verifiedInstallations: [],
  resolvedIssues: [],
  refreshCount: 0,
  failNext: new Set(),
});

let state: FakeMonitorState = freshState();

/** The fake's state, for a test to seed or assert against. */
export const fakeMonitorState = (): FakeMonitorState => state;

/** Put the fake back to its initial state — a test's `beforeEach`. */
export function resetFakeMonitorProvider(): void {
  state = freshState();
}

function guard(operation: string): void {
  if (state.failNext.has(operation)) {
    state.failNext.delete(operation);
    // The provider's OWN words, which is what the settings surface renders.
    throw new MonitorProviderCallError(operation, 401, 'The authorization has been revoked.');
  }
}

export const fakeMonitorProvider: MonitorProvider = {
  id: 'fake',

  async exchangeGrant({ code }): Promise<MonitorCredential> {
    guard('exchangeGrant');
    const credential = state.grants.get(code);
    if (!credential) {
      throw new MonitorProviderCallError('exchangeGrant', 400, `Unknown grant code "${code}".`);
    }
    return credential;
  },

  async verifyInstall({ installationId }): Promise<void> {
    guard('verifyInstall');
    state.verifiedInstallations.push(installationId);
  },

  async refreshCredential(): Promise<MonitorCredential> {
    guard('refreshCredential');
    state.refreshCount += 1;
    // A ROTATING refresh token, like the real provider's: a fake that returns
    // the same pair forever cannot exhibit the double-refresh hazard the
    // credential-lifecycle card serializes against.
    return {
      accessToken: `fake-access-token-${state.refreshCount}`,
      refreshToken: `fake-refresh-token-${state.refreshCount}`,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    };
  },

  async describeHealth(): Promise<NormalizedMonitorHealth> {
    // Deliberately NOT guarded: the real adapter turns a failed probe into a
    // `degraded` VERDICT rather than a throw, so the fake's unhealthy path is a
    // seeded verdict. `state.health` is what a test sets to drive the degraded
    // row.
    return { ...state.health, checkedAt: new Date() };
  },

  async listProjects(): Promise<NormalizedMonitorProject[]> {
    guard('listProjects');
    return [...state.projects];
  },

  async listIssuesSince({ cursor }): Promise<NormalizedMonitorIssuePage> {
    guard('listIssuesSince');
    // One page, then the end — enough to exercise a poll's cursor handling
    // without pretending to be a pagination engine.
    if (cursor) return { issues: [], nextCursor: null };
    return { issues: [...state.issues], nextCursor: null };
  },

  async resolveIssue({ externalIssueId }): Promise<void> {
    guard('resolveIssue');
    state.resolvedIssues.push(externalIssueId);
  },
};

registerMonitorProvider(fakeMonitorProvider);
