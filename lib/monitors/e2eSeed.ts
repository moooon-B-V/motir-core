import type {
  NormalizedMonitorAssignee,
  NormalizedMonitorException,
  NormalizedMonitorStackFrame,
} from './types';
import { fakeMonitorState, type FakeMonitorIssue } from './providers/fake';

// THE E2E SEEDING SEAM for the fake monitor provider (Story MOTIR-4929 ·
// Subtask MOTIR-5584).
//
// ⚠️ THE FAKE'S STATE LIVES IN WHICHEVER PROCESS IMPORTED IT. A Playwright spec
// cannot reach into the spawned Next server to seed issues, and a `vi.mock` is
// unreachable from it — so the acceptance lane's `_test` route calls THIS, in
// the server process, where the fake that `MOTIR_MONITOR_FAKE_PROVIDER=1`
// registered under `sentry` actually lives.
//
// It lives INSIDE `lib/monitors/` because nothing outside it may name a provider
// implementation (`tests/monitors/monitorBoundaries.test.ts`); the route reaches
// the fake only through this function.

/** An issue as it arrives over JSON — dates as ISO strings. */
export interface SeedMonitorIssue {
  externalId: string;
  title: string;
  culprit?: string | null;
  level?: string | null;
  eventCount?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  permalink?: string | null;
  /** The monitor-side assignee the server-side poll reads (MOTIR-5709). */
  assignee?: NormalizedMonitorAssignee | null;
  /** What a person pastes into the link search (MOTIR-5728). */
  shortId?: string | null;
  /** The latest event's environment and release (MOTIR-5728). */
  environment?: string | null;
  release?: string | null;
  /** The latest event's stack frames, as the adapter would return them
   *  (MOTIR-5846) — what an enrichment E2E drives a realistic trace with. */
  frames?: NormalizedMonitorStackFrame[];
  /** The latest event's EVIDENCE (Story MOTIR-5975 · MOTIR-5985): the surfaced
   *  exception, its tags UNFILTERED (so a spec can seed `user.email` and watch
   *  the seam drop it), the request URL query string and all, and which event it
   *  was. The fake runs them through the SAME filters the Sentry adapter does. */
  exception?: NormalizedMonitorException | null;
  rawTags?: { key: string; value: string }[];
  requestMethod?: string | null;
  requestUrl?: string | null;
  eventId?: string | null;
  eventAt?: string | null;
  /** Scopes the issue to ONE monitored project for a search; absent = every. */
  externalProjectId?: string | null;
}

export interface SeedFakeMonitorInput {
  /** REPLACES the fake's issue set when given. */
  issues?: SeedMonitorIssue[];
  /** Arms ONE failure of the next listing, with a status (and the provider's words). */
  failNextListing?: { status: number; reason?: string };
  /** Arms ONE failure of the next latest-event CONTEXT read (MOTIR-5985) — how the
   *  acceptance lane shows a refused read leaving the stored evidence standing. */
  failNextContext?: { status: number; reason?: string };
  /** Makes every `searchIssues` for ONE monitored project fail (MOTIR-5734) — the
   *  picker's per-connection failure line. `null` clears it. */
  failSearchForProject?: { externalProjectId: string; status: number; reason?: string } | null;
  /** Forget the calls recorded so far — the start of a "no provider call" window. */
  clearCalls?: boolean;
}

/** Every provider operation the SERVER's fake has recorded since the last clear
 *  (MOTIR-5734). */
export function readFakeMonitorCalls(): string[] {
  return [...fakeMonitorState().calls];
}

export function seedFakeMonitor(input: SeedFakeMonitorInput): void {
  const state = fakeMonitorState();
  if (input.issues) {
    state.issues = input.issues.map(
      (issue): FakeMonitorIssue => ({
        externalId: issue.externalId,
        title: issue.title,
        culprit: issue.culprit ?? null,
        level: issue.level ?? null,
        eventCount: issue.eventCount ?? 1,
        firstSeenAt: new Date(issue.firstSeenAt),
        lastSeenAt: new Date(issue.lastSeenAt),
        permalink: issue.permalink ?? null,
        assignee: issue.assignee ?? null,
        shortId: issue.shortId ?? null,
        environment: issue.environment ?? null,
        release: issue.release ?? null,
        frames: issue.frames ?? [],
        exception: issue.exception ?? null,
        rawTags: issue.rawTags ?? [],
        requestMethod: issue.requestMethod ?? null,
        requestUrl: issue.requestUrl ?? null,
        eventId: issue.eventId ?? null,
        eventAt: issue.eventAt ? new Date(issue.eventAt) : null,
        externalProjectId: issue.externalProjectId ?? null,
      }),
    );
  }
  if (input.failNextListing) {
    state.failNextStatus.set('listIssuesSince', input.failNextListing);
  }
  if (input.failNextContext) {
    state.failNextStatus.set('getIssueContext', input.failNextContext);
  }
  if (input.failSearchForProject === null) {
    state.failSearchForProject.clear();
  } else if (input.failSearchForProject) {
    const { externalProjectId, status, reason } = input.failSearchForProject;
    state.failSearchForProject.set(externalProjectId, { status, reason });
  }
  if (input.clearCalls) state.calls = [];
}
