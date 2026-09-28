import { readFileSync, writeFileSync } from 'node:fs';
import type { HostedRunFixture, HostedRunJournalEntry } from '@/lib/test-hosted-run-mock';

// THE SPEC'S OWN HALF of `lib/test-hosted-run-mock.ts`'s two-file seam (Story
// MOTIR-683 · MOTIR-6452): write the fixture the mock answers from, read the
// journal it wrote, and read the fake orchestrator's shared container-state
// file to learn what a hosted run's own credential is — the same file
// `packages/orchestrator/src/adapters/fake` persists a provisioned container's
// full launcher spec (its `env`) to, under `MOTIR_FAKE_CONTAINER_STATE_PATH`,
// so a process that never provisioned the container can still read what it was
// booted with. This is a TEST file, never reachable from `instrumentation.ts`,
// so it reads `node:fs` directly — the NFT-tracing rule
// `lib/test-fixture-file.ts` documents is about production bundle tracing and
// does not reach here.

function fixturePath(): string {
  const path = process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH'];
  if (!path)
    throw new Error('MOTIR_HOSTED_RUN_FIXTURE_PATH is not set — is this the acceptance lane?');
  return path;
}

/** Overwrite the fixture the gateway/motir-ai/GitHub mock reads (re-read on
 *  every request, so a later write changes the answer mid-test — the
 *  model-withdrawn case's whole mechanism). */
export function writeHostedRunFixture(fixture: HostedRunFixture): void {
  writeFileSync(fixturePath(), JSON.stringify(fixture));
}

function journalPath(): string {
  const path = process.env['MOTIR_HOSTED_RUN_JOURNAL_PATH'];
  if (!path)
    throw new Error('MOTIR_HOSTED_RUN_JOURNAL_PATH is not set — is this the acceptance lane?');
  return path;
}

/** Truncate the journal — call once per test, before anything the test wants
 *  to see the journal of. */
export function resetHostedRunJournal(): void {
  writeFileSync(journalPath(), '');
}

/** Every call the mock has answered so far, oldest first. */
export function readHostedRunJournal(): HostedRunJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(journalPath(), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HostedRunJournalEntry);
}

// ── The fake orchestrator's shared container state ──────────────────────────
//
// `packages/orchestrator/src/adapters/fake/index.ts`'s `PersistedMachine` shape,
// narrowed to the fields this file reads. `provision()` calls `saveShared()`
// synchronously before it returns the handle, so by the time the "Run hosted"
// press's own POST response has resolved, a machine it booted is already in
// this file — an authoritative read, never a race.

interface FakeContainerHandle {
  id: string;
  provider: string;
  region: string;
  createdAt: string;
}

interface FakeContainerSpec {
  env?: Record<string, string>;
}

export interface FakeContainerRecord {
  handle: FakeContainerHandle;
  spec: FakeContainerSpec;
  state: string;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  gone: boolean;
}

function containerStatePath(): string {
  const path = process.env['MOTIR_FAKE_CONTAINER_STATE_PATH'];
  if (!path) {
    throw new Error('MOTIR_FAKE_CONTAINER_STATE_PATH is not set — is this the acceptance lane?');
  }
  return path;
}

/** Every container the fake orchestrator has ever provisioned, across every
 *  process this lane runs (the webServer boots one, the worker polls/settles
 *  it). Absent the file (nothing has provisioned yet), the empty map. */
export function readFakeContainers(): Record<string, FakeContainerRecord> {
  let raw: string;
  try {
    raw = readFileSync(containerStatePath(), 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, FakeContainerRecord>;
  } catch {
    // A half-written file mid-save — the same torn-read tolerance the fake
    // orchestrator's own `loadShared()` gives itself.
    return {};
  }
}

/** How many containers exist right now — the "zero provisions" assertion's
 *  BEFORE reading, so a refusal case can assert no NEW one appeared rather
 *  than assuming it is the first hosted run of the whole spec file. */
export function fakeContainerCount(): number {
  return Object.keys(readFakeContainers()).length;
}

/** The one container a dispatch run's own boot provisioned, by the
 *  `MOTIR_DISPATCH_RUN_ID` every hosted run's launcher env carries
 *  (`hostedRunService.start`'s step 7). `undefined` before it has booted. */
export function fakeContainerForRun(dispatchRunId: string): FakeContainerRecord | undefined {
  return Object.values(readFakeContainers()).find(
    (m) => m.spec.env?.['MOTIR_DISPATCH_RUN_ID'] === dispatchRunId,
  );
}

/**
 * The run's OWN credential (`MOTIR_RUN_TOKEN`) — exactly what a real container
 * would receive in its environment, read back from the launcher spec the fake
 * orchestrator recorded. This is "the entrypoint's events, posted through the
 * shared ingest with the run's own credential" the card describes: the spec
 * plays the container's side using the very credential the real one would
 * have been booted with.
 */
export function runTokenFor(dispatchRunId: string): string {
  const machine = fakeContainerForRun(dispatchRunId);
  const token = machine?.spec.env?.['MOTIR_RUN_TOKEN'];
  if (!token) {
    throw new Error(
      `no fake container has booted for dispatch run ${dispatchRunId} yet (or it carries no ` +
        `MOTIR_RUN_TOKEN) — read this only after the "Run hosted" press's own 2xx response`,
    );
  }
  return token;
}

/** Whether the run's own container has settled (torn down, one way or another)
 *  — the CANCEL case's "the fake orchestrator shows the machine settled". */
export function fakeContainerSettled(dispatchRunId: string): boolean {
  const machine = fakeContainerForRun(dispatchRunId);
  return machine !== undefined && (machine.gone || machine.state === 'destroyed');
}
