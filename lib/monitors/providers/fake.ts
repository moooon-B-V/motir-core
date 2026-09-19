import { MonitorIssueGoneError, MonitorProviderCallError } from '../errors';
import type { MonitorProvider } from '../provider';
import { registerMonitorProvider } from '../registry';
import type {
  MonitorCredential,
  NormalizedMonitorHealth,
  NormalizedMonitorIssue,
  NormalizedMonitorIssueContext,
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

/**
 * A seeded issue: the normalized issue plus what only the fake needs to know
 * about it (MOTIR-5728). `shortId` is what a person pastes into the link search;
 * `environment` / `release` are what `getIssueContext` answers;
 * `externalProjectId` scopes a SEARCH to one monitored project (an issue with
 * none matches every project, which is what every pre-existing seed means).
 * None of the four leaks out: every method returns the normalized shape.
 */
export interface FakeMonitorIssue extends NormalizedMonitorIssue {
  shortId?: string | null;
  environment?: string | null;
  release?: string | null;
  externalProjectId?: string | null;
}

/** One recorded `searchIssues` call — what a test counts to assert "no provider
 *  call", and reads to assert the query and limit that reached the seam. */
export interface FakeSearchCall {
  externalProjectId: string;
  query: string;
  limit: number;
}

/** What the fake will answer, and what it recorded being asked. A test drives it
 *  through this object rather than through a module mock, so the same wiring
 *  works in-process and in a spawned server. */
export interface FakeMonitorState {
  /** Grant exchanges keyed by code — an unknown code is refused, exactly as a
   *  provider refuses a replayed one. */
  grants: Map<string, MonitorCredential>;
  projects: NormalizedMonitorProject[];
  issues: FakeMonitorIssue[];
  health: NormalizedMonitorHealth;
  /** The organisation the fake's installation belongs to. */
  orgSlug: string | null;
  /** Installation ids passed to `verifyInstall`, in order — what proves the
   *  CONNECT card verified rather than only exchanged. */
  verifiedInstallations: string[];
  /** Issue ids passed to `resolveIssue`, in order — EVERY call, a gone one
   *  included, so a test can count calls (MOTIR-4931's consumer). */
  resolvedIssues: string[];
  /** Issue ids passed to `getIssue`, in order — how a test asserts a switched-off
   *  connection made ZERO reads (MOTIR-5705). */
  readIssues: string[];
  /** Issue ids the provider NO LONGER HAS: `getIssue` answers `null` and
   *  `resolveIssue` throws `MonitorIssueGoneError` (MOTIR-5702). */
  deletedIssues: Set<string>;
  /** Every `searchIssues` call, in order (MOTIR-5728). */
  searches: FakeSearchCall[];
  /** Issue ids passed to `getIssueContext`, in order — a gone one included
   *  (MOTIR-5728). */
  contextReads: string[];
  /**
   * Monitored projects whose `searchIssues` fails, with the status and the
   * provider's words — NOT consumed, so a search that fans out to several
   * connections in parallel can fail ONE of them deterministically, which a
   * per-operation {@link failNext} cannot (MOTIR-5731's criterion).
   */
  failSearchForProject: Map<string, { status: number; reason?: string }>;
  /** How many refreshes have been asked for, and what the next one returns. */
  refreshCount: number;
  /** Set to make the next call of that operation fail — how a test drives the
   *  `degraded` path and the typed-refusal path without a network. Fails with
   *  a 401 unless {@link failNextStatus} names another status for it. */
  failNext: Set<string>;
  /**
   * The STATUS (and optionally the provider's words) the next failure of an
   * operation carries — so a test, and the E2E, can force a NON-credential
   * failure (a 500) and see that it is NOT read as a revoked grant (MOTIR-5577).
   * Setting an entry arms the failure on its own; it is consumed with it. An
   * operation armed only through {@link failNext} keeps the 401 default.
   */
  failNextStatus: Map<string, { status: number; reason?: string }>;
  /** How many issues one `listIssuesSince` page holds — small in a test that
   *  drives the poll across several pages. */
  pageSize: number;
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
      assignee: null,
    },
  ],
  health: { status: 'connected', reason: null, checkedAt: new Date() },
  orgSlug: 'fake-org',
  verifiedInstallations: [],
  resolvedIssues: [],
  readIssues: [],
  deletedIssues: new Set(),
  searches: [],
  contextReads: [],
  failSearchForProject: new Map(),
  refreshCount: 0,
  failNext: new Set(),
  failNextStatus: new Map(),
  pageSize: 100,
});

let state: FakeMonitorState = freshState();

/** The fake's state, for a test to seed or assert against. */
export const fakeMonitorState = (): FakeMonitorState => state;

/** Put the fake back to its initial state — a test's `beforeEach`. */
export function resetFakeMonitorProvider(): void {
  state = freshState();
}

/** A seeded issue as the SEAM returns it — the fake-only fields stripped, so a
 *  consumer can never come to depend on one. */
function normalized(issue: FakeMonitorIssue): NormalizedMonitorIssue {
  return {
    externalId: issue.externalId,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    eventCount: issue.eventCount,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    permalink: issue.permalink,
    assignee: issue.assignee ? { ...issue.assignee } : null,
  };
}

function guard(operation: string): void {
  const withStatus = state.failNextStatus.get(operation);
  if (state.failNext.has(operation) || withStatus) {
    state.failNext.delete(operation);
    state.failNextStatus.delete(operation);
    const status = withStatus?.status ?? 401;
    // The provider's OWN words, which is what the settings surface renders.
    const reason =
      withStatus?.reason ??
      (status === 401 ? 'The authorization has been revoked.' : `The provider answered ${status}.`);
    throw new MonitorProviderCallError(operation, status, reason);
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

  async describeInstallation(): Promise<{ orgSlug: string | null }> {
    guard('describeInstallation');
    return { orgSlug: state.orgSlug };
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

  /**
   * The SAME contract as the real adapter (MOTIR-5577): only issues last seen
   * strictly after `lastSeenAfter`, newest-last-seen first, in pages of
   * `state.pageSize`, with `null` as the last page's cursor. The cursor is the
   * offset into that ordered list — opaque to the caller, as Sentry's is.
   */
  async listIssuesSince({ lastSeenAfter, cursor }): Promise<NormalizedMonitorIssuePage> {
    guard('listIssuesSince');
    const since = lastSeenAfter?.getTime() ?? Number.NEGATIVE_INFINITY;
    const ordered = state.issues
      .filter((issue) => issue.lastSeenAt.getTime() > since)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
    const offset = cursor ? Number(cursor) || 0 : 0;
    const end = offset + Math.max(1, state.pageSize);
    return {
      issues: ordered.slice(offset, end).map(normalized),
      nextCursor: end < ordered.length ? String(end) : null,
    };
  },

  async resolveIssue({ externalIssueId }): Promise<void> {
    guard('resolveIssue');
    state.resolvedIssues.push(externalIssueId);
    if (state.deletedIssues.has(externalIssueId)) {
      throw new MonitorIssueGoneError(
        'resolveIssue',
        externalIssueId,
        'The requested resource does not exist',
      );
    }
  },

  /** The seeded issue by id — its CURRENT assignee, so a test that changes it
   *  between two reads sees the change — or `null` for a deleted or unknown id. */
  async getIssue({ externalIssueId }): Promise<NormalizedMonitorIssue | null> {
    guard('getIssue');
    state.readIssues.push(externalIssueId);
    if (state.deletedIssues.has(externalIssueId)) return null;
    const issue = state.issues.find((candidate) => candidate.externalId === externalIssueId);
    return issue ? normalized(issue) : null;
  },

  /**
   * The SAME contract as the real adapter (MOTIR-5728): a case-insensitive
   * title substring, OR an exact short id (the `shortIdLookup=1` half), within
   * the one monitored project, most recently seen first, at most `limit` — and
   * an empty query answers the most recent issues. Resolved issues are NOT
   * filtered, as the real search does not filter them; DELETED ones are, since
   * the provider no longer has them to return.
   */
  async searchIssues({ externalProjectId, query, limit }): Promise<NormalizedMonitorIssue[]> {
    state.searches.push({ externalProjectId, query, limit });
    guard('searchIssues');
    const failure = state.failSearchForProject.get(externalProjectId);
    if (failure) {
      throw new MonitorProviderCallError(
        'searchIssues',
        failure.status,
        failure.reason ?? `The provider answered ${failure.status}.`,
      );
    }
    const needle = query.trim().toLowerCase();
    return state.issues
      .filter((issue) => !state.deletedIssues.has(issue.externalId))
      .filter((issue) => !issue.externalProjectId || issue.externalProjectId === externalProjectId)
      .filter(
        (issue) =>
          needle === '' ||
          issue.title.toLowerCase().includes(needle) ||
          (issue.shortId != null && issue.shortId.toLowerCase() === needle),
      )
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .slice(0, Math.max(1, limit))
      .map(normalized);
  },

  /** The seeded issue's `environment` / `release` (`null` when unseeded); a
   *  deleted or unknown id is the typed GONE answer, as the real 404 is. */
  async getIssueContext({ externalIssueId }): Promise<NormalizedMonitorIssueContext> {
    state.contextReads.push(externalIssueId);
    guard('getIssueContext');
    const issue = state.issues.find((candidate) => candidate.externalId === externalIssueId);
    if (!issue || state.deletedIssues.has(externalIssueId)) {
      throw new MonitorIssueGoneError(
        'getIssueContext',
        externalIssueId,
        'The requested resource does not exist',
      );
    }
    return { environment: issue.environment ?? null, release: issue.release ?? null };
  },
};

registerMonitorProvider(fakeMonitorProvider);
