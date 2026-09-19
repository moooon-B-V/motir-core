import type { NormalizedMonitorAssignee, NormalizedMonitorIssue } from './types';
import { fakeMonitorState } from './providers/fake';

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
}

export interface SeedFakeMonitorInput {
  /** REPLACES the fake's issue set when given. */
  issues?: SeedMonitorIssue[];
  /** Arms ONE failure of the next listing, with a status (and the provider's words). */
  failNextListing?: { status: number; reason?: string };
}

export function seedFakeMonitor(input: SeedFakeMonitorInput): void {
  const state = fakeMonitorState();
  if (input.issues) {
    state.issues = input.issues.map(
      (issue): NormalizedMonitorIssue => ({
        externalId: issue.externalId,
        title: issue.title,
        culprit: issue.culprit ?? null,
        level: issue.level ?? null,
        eventCount: issue.eventCount ?? 1,
        firstSeenAt: new Date(issue.firstSeenAt),
        lastSeenAt: new Date(issue.lastSeenAt),
        permalink: issue.permalink ?? null,
        assignee: issue.assignee ?? null,
      }),
    );
  }
  if (input.failNextListing) {
    state.failNextStatus.set('listIssuesSince', input.failNextListing);
  }
}
