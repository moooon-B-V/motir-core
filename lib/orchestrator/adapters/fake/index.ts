import { buildContainerUsage } from '../../usage';
import { OrchestratorApiError } from '../../errors';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerStatus,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
  UsageAttributionResolver,
} from '../../types';

// The FAKE adapter (Story MOTIR-1916 · MOTIR-1921) — `docs/decisions/
// ci-runner-fleet.md` §4, rule 2:
//
//   > A `fake` adapter ships alongside the Fly one, IN THE SAME PR as
//   > MOTIR-1921. It is what MOTIR-1927's Vitest gate drives — the boot /
//   > teardown / no-reuse / label-scoping guards are assertions about the PORT's
//   > contract, not about Fly.
//
// ⚠️ IT IS NOT A TEST FIXTURE, and shipping it here rather than in `tests/` is
// the point the card makes twice. A port with one implementation has never been
// shown to be a port: the second implementation is the evidence, and the moment
// it lives under `tests/` it stops constraining production code and starts
// tracking it. It is also what lets MOTIR-1927 assert the guarantees that are
// invisible to coverage — "a handle that reached `job_completed` is never
// provisioned again" is a statement about the PORT, and there is no way to make
// it against Fly without booting real machines.
//
// It is a MODULE SINGLETON with a control surface, mirroring how this repo
// already fakes GitHub (`tests/helpers/runnerGroupFake.ts` is stateful for the
// same reason): the interesting assertions are about END STATE after a sequence
// of operations — "exactly one usage row per handle", "the container is gone on
// every failure path" — and a per-call spy cannot see those. `reset()` between
// tests is the price.

/** One container as the fake holds it. */
interface FakeMachine {
  handle: ContainerHandle;
  spec: ContainerSpec;
  state: string;
  createdAt: Date;
  startedAt: Date | null;
  stoppedAt: Date | null;
  /** True once the container self-destroyed (the `auto_destroy` happy path). */
  gone: boolean;
}

/** What a newly provisioned container does next, so a test can drive the failure
 *  paths the card requires one test each for. */
export type FakeBootBehaviour =
  /** Boots and reaches `started` immediately — the happy path. */
  | 'start'
  /** Created, but never starts: the "boot succeeded, the runner never
   *  registered" path. */
  | 'never_start'
  /** Starts and then runs forever: the "hung past the timeout" path. */
  | 'hang';

export interface FakeOrchestratorControls {
  /** Forget every container and every arranged failure. Call in `beforeEach`. */
  reset(): void;
  /** What the NEXT provisioned container does. Persists until changed. */
  setBootBehaviour(behaviour: FakeBootBehaviour): void;
  /** Make the next `provision` throw — the "the provider refused" path. */
  failNextProvision(detail?: string): void;
  /** Make the next `teardown` throw — used to prove the caller still records the
   *  failure rather than losing the container silently. */
  failNextTeardown(detail?: string): void;
  /** Simulate the job finishing: the runner exits and `auto_destroy` deletes the
   *  machine, so a later `describe` reports it GONE — the happy path, and the
   *  one that proves teardown works without a machine to read. */
  completeJob(handleId: string): void;
  /** Pretend this container was created earlier, so `reap(olderThan)` sees it. */
  backdate(handleId: string, createdAt: Date): void;
  /** Every container the fake has ever been asked to boot, in order. */
  readonly provisioned: ContainerHandle[];
  /** Every `provision` call's spec — how a test asserts what was ASKED for (the
   *  image, the size, the single label in the JIT env, the region). */
  readonly specs: ContainerSpec[];
  /** Containers that still exist on the "provider" — the leak assertion. A test
   *  that ends with this non-empty has found a container the code did not
   *  destroy, which is the failure this whole card is about. */
  liveContainerIds(): string[];
  /** Every teardown, with the reason — how a test asserts the failure PATH taken,
   *  not merely that something was destroyed. */
  readonly teardowns: Array<{ handleId: string; reason: TeardownReason }>;
}

const machines = new Map<string, FakeMachine>();
/** Usage rows already produced, so a second teardown returns the SAME row rather
 *  than a second one — the port's idempotency clause, honoured literally. */
const usageByHandle = new Map<string, ContainerUsage>();
const provisioned: ContainerHandle[] = [];
const specs: ContainerSpec[] = [];
const teardowns: Array<{ handleId: string; reason: TeardownReason }> = [];

let behaviour: FakeBootBehaviour = 'start';
let nextProvisionFailure: string | null = null;
let nextTeardownFailure: string | null = null;
let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `fake-machine-${sequence}`;
}

export const fakeOrchestrator: ContainerOrchestrator & FakeOrchestratorControls = {
  provider: 'fake',

  // ── controls ──────────────────────────────────────────────────────────────

  provisioned,
  specs,
  teardowns,

  reset() {
    machines.clear();
    usageByHandle.clear();
    provisioned.length = 0;
    specs.length = 0;
    teardowns.length = 0;
    behaviour = 'start';
    nextProvisionFailure = null;
    nextTeardownFailure = null;
    sequence = 0;
  },

  setBootBehaviour(next) {
    behaviour = next;
  },

  failNextProvision(detail = 'the fake refused to provision') {
    nextProvisionFailure = detail;
  },

  failNextTeardown(detail = 'the fake refused to tear down') {
    nextTeardownFailure = detail;
  },

  completeJob(handleId) {
    const machine = machines.get(handleId);
    if (!machine) throw new Error(`fake orchestrator has no container ${handleId}`);
    machine.state = 'destroyed';
    machine.stoppedAt = new Date();
    // `auto_destroy: true` — the machine deletes ITSELF, so the provider no
    // longer has it. This is what makes the happy path the hardest case for
    // metering, and the reason `UsageAttribution.observedStartedAt` exists.
    machine.gone = true;
  },

  backdate(handleId, createdAt) {
    const machine = machines.get(handleId);
    if (!machine) throw new Error(`fake orchestrator has no container ${handleId}`);
    machine.createdAt = createdAt;
    machine.handle = { ...machine.handle, createdAt };
  },

  liveContainerIds() {
    return [...machines.values()].filter((m) => !m.gone).map((m) => m.handle.id);
  },

  // ── the port ──────────────────────────────────────────────────────────────

  async provision(spec: ContainerSpec): Promise<ContainerHandle> {
    specs.push(spec);
    if (nextProvisionFailure !== null) {
      const detail = nextProvisionFailure;
      nextProvisionFailure = null;
      // Nothing is recorded: a provision that throws must leave NO container, so
      // there is nothing for `liveContainerIds()` to report and nothing to reap.
      throw new OrchestratorApiError('fake', 500, detail);
    }

    const createdAt = new Date();
    const handle: ContainerHandle = {
      provider: 'fake',
      id: nextId(),
      region: spec.region,
      createdAt,
    };
    machines.set(handle.id, {
      handle,
      spec,
      state: behaviour === 'never_start' ? 'created' : 'started',
      createdAt,
      startedAt: behaviour === 'never_start' ? null : createdAt,
      stoppedAt: null,
      gone: false,
    });
    provisioned.push(handle);
    return handle;
  },

  async describe(handle: ContainerHandle): Promise<ContainerStatus> {
    const machine = machines.get(handle.id);
    if (!machine || machine.gone) {
      return {
        handleId: handle.id,
        exists: false,
        state: 'destroyed',
        terminal: true,
        createdAt: machine?.createdAt ?? handle.createdAt,
        startedAt: machine?.startedAt ?? null,
        stoppedAt: machine?.stoppedAt ?? null,
      };
    }
    return {
      handleId: handle.id,
      exists: true,
      state: machine.state,
      // A `hang` never becomes terminal — that is the whole point of the
      // behaviour: only the caller's timeout ends it.
      terminal: false,
      createdAt: machine.createdAt,
      startedAt: machine.startedAt,
      stoppedAt: machine.stoppedAt,
    };
  },

  async teardown(
    handle: ContainerHandle,
    reason: TeardownReason,
    context: UsageAttribution,
  ): Promise<ContainerUsage> {
    if (nextTeardownFailure !== null) {
      const detail = nextTeardownFailure;
      nextTeardownFailure = null;
      throw new OrchestratorApiError('fake', 500, detail);
    }

    teardowns.push({ handleId: handle.id, reason });

    // IDEMPOTENT, literally: the second call returns the row the first produced.
    // Both the `finally` path and the reaper can reach the same container, and a
    // second row would break §5's "exactly one usage row per provisioned handle"
    // just as surely as none would.
    const existing = usageByHandle.get(handle.id);
    if (existing) return existing;

    const machine = machines.get(handle.id);
    const stoppedAt = machine?.stoppedAt ?? new Date();
    const usage = buildContainerUsage({
      handle,
      attribution: context,
      reason,
      lifecycle: {
        createdAt: machine?.createdAt ?? handle.createdAt,
        startedAt: machine?.startedAt ?? context.observedStartedAt,
        stoppedAt,
        terminalState: machine ? 'destroyed' : 'destroyed',
      },
    });
    if (machine) {
      machine.gone = true;
      machine.state = 'destroyed';
      machine.stoppedAt = stoppedAt;
    }
    usageByHandle.set(handle.id, usage);
    return usage;
  },

  async reap(olderThan: Date, resolve: UsageAttributionResolver): Promise<ContainerUsage[]> {
    const usages: ContainerUsage[] = [];
    for (const machine of [...machines.values()]) {
      if (machine.gone) continue;
      if (machine.createdAt.getTime() >= olderThan.getTime()) continue;
      const attribution = await resolve(machine.handle);
      if (!attribution) {
        // Destroyed anyway — an orphan Motir cannot attribute is still an orphan
        // that bills. It yields no usage row; see the Fly adapter for why that is
        // the honest answer rather than a row attributed to nobody.
        machine.gone = true;
        machine.state = 'destroyed';
        continue;
      }
      usages.push(await this.teardown(machine.handle, 'reaped', attribution));
    }
    return usages;
  },
};
