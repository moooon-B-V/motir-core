import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT_BLIND_READ,
  EXIT_CLEAN,
  EXIT_DRIFT,
  assertPool,
  expectedShape,
  observedShape,
  parseFlyConfig,
} from '../../scripts/machinePool.mjs';

// MOTIR-3570 — the deploy guard that used to compare Fly's `machine_count`
// against `vars.FLY_EXPECTED_MACHINE_COUNT`.
//
// The variable said 2, set by MOTIR-2408 when the pool WAS two app machines.
// MOTIR-3425 added the `worker` process group, the pool became four, and nothing
// updated it — so every deploy ended RED on a deploy that had SUCCEEDED. The
// number was not the defect; a SUM over independently-scaled process groups is
// the wrong assertion, and re-arming it only buys the interval until the next
// group is added.
//
// So the expectation is DERIVED from `fly.toml` and these specs are what makes
// that claim checkable. Two properties matter and both are asserted here:
//
//   1. Adding or scaling a group changes the expectation BY CONSTRUCTION —
//      'a THIRD process group needs no edit anywhere else' below is the whole
//      acceptance criterion, executed.
//   2. The guard still FAILS on real drift. A derivation that cannot go red is
//      a log line, so every failure mode has a DELIBERATE NEGATIVE here rather
//      than being trusted because no green run has contradicted it. That
//      inversion is what MOTIR-3570 is about: the previous guard's only proof of
//      life was that it went red, and it went red for the wrong reason.

const root = process.cwd();
const REAL_FLY_TOML = readFileSync(join(root, 'fly.toml'), 'utf8');

/** A `GET /v1/apps/<app>/machines` row, cut down to what the guard reads. */
function machine(
  id: string,
  group: string,
  state: string,
  options: { standbyFor?: string[] } = {},
): Record<string, unknown> {
  return {
    id,
    state,
    config: {
      metadata: { fly_process_group: group },
      ...(options.standbyFor ? { standbys: options.standbyFor } : {}),
    },
  };
}

/**
 * The pool as it actually stood on 2026-08-26, read from
 * `GET https://api.machines.dev/v1/apps/motir-core/machines`: two app machines
 * started, one worker started, and the `†` standby Fly adds to a single-machine
 * group sitting stopped. Four machines, which is the number the old guard called
 * a failure.
 */
const PRODUCTION_POOL = [
  machine('891e16eb021e28', 'worker', 'stopped', { standbyFor: ['8576143c4ee538'] }),
  machine('7817663f103648', 'app', 'started'),
  machine('8576143c4ee538', 'worker', 'started'),
  machine('83d1300b7460e8', 'app', 'started'),
];

describe('the expectation is read out of the real fly.toml (MOTIR-3570)', () => {
  it('finds the keys it derives from — the negative control', () => {
    // Every assertion in this file rests on the parser locating four things in a
    // 200-line file of prose. A parser that quietly returned nothing would make
    // the whole guard pass vacuously, which is the shape it exists to replace,
    // so this reads the SHIPPED file rather than a fixture.
    const config = parseFlyConfig(REAL_FLY_TOML);
    expect(config.groups).toEqual(['app', 'worker']);
    expect(config.httpGroups).toEqual(['app']);
    expect(config.minMachinesRunning).toBe(2);
  });

  it('is not confused by the `processes` key on a [[vm]] block', () => {
    // `fly.toml` carries `processes = ["app"]` in THREE places — the group table,
    // `[http_service]`, and one per `[[vm]]` — so a parser that matched the key
    // without scoping it to its table would read a VM's audience as the group set.
    const config = parseFlyConfig(`
[processes]
  app    = "node server.js"
  worker = "node worker/worker.mjs"

[http_service]
  processes            = ["app"]
  min_machines_running = 2

[[vm]]
  processes = ["worker"]
`);
    expect(config.groups).toEqual(['app', 'worker']);
    expect(config.httpGroups).toEqual(['app']);
  });

  it('ignores a `#` comment after a value, but not one inside a string', () => {
    const config = parseFlyConfig(`
[processes]
  app = "node server.js"   # the web tier

[http_service]
  processes            = ["app"]  # only the web group serves traffic
  min_machines_running = 2        # an availability decision
`);
    expect(config.groups).toEqual(['app']);
    expect(config.minMachinesRunning).toBe(2);
  });

  it('THROWS rather than deriving nothing when [processes] is gone', () => {
    // The failure this guard must not have. An empty expectation compares
    // cleanly against every pool, so it reads exactly like a passing check.
    expect(() => parseFlyConfig('[http_service]\n  internal_port = 8080\n')).toThrow(
      /\[processes\] table/,
    );
    expect(() => parseFlyConfig('')).toThrow(/empty/);
  });

  it('THROWS when [http_service] does not say which groups serve traffic', () => {
    // Fly would route requests to every group, including one that listens on no
    // port — the hazard `fly.toml`'s own comment calls not optional.
    expect(() =>
      parseFlyConfig('[processes]\n  app = "x"\n\n[http_service]\n  internal_port = 8080\n'),
    ).toThrow(/http_service\.processes/);
  });

  it('THROWS when http_service.processes names a group that does not exist', () => {
    expect(() =>
      parseFlyConfig('[processes]\n  worker = "x"\n\n[http_service]\n  processes = ["app"]\n'),
    ).toThrow(/not a group in \[processes\]/);
  });

  it('THROWS when the running floor is not a count', () => {
    expect(() =>
      parseFlyConfig(
        '[processes]\n  app = "x"\n\n[http_service]\n  processes = ["app"]\n  min_machines_running = "two"\n',
      ),
    ).toThrow(/not a count/);
  });
});

describe('what the configuration declares, per group', () => {
  it('gives every declared group an existence floor and only the HTTP tier a running one', () => {
    // A worker group carries no `min_machines_running` — that key lives under
    // `[http_service]` and is scoped by `http_service.processes`. Asserting a
    // `started` count for it would be inventing a number the file does not have,
    // which is the stored-constant habit one level down.
    const expected = expectedShape(parseFlyConfig(REAL_FLY_TOML));
    expect(expected.get('app')).toEqual({ exists: 1, running: 2 });
    expect(expected.get('worker')).toEqual({ exists: 1, running: 0 });
  });
});

describe('what the platform reports, per group', () => {
  it('counts a standby separately — nothing in fly.toml asks for one', () => {
    // Fly adds a standby to a single-machine group; it sits stopped and takes
    // over only on host hardware failure. Counting it toward the pool would put
    // a number back into the expectation that no key in the file declares.
    const observed = observedShape(PRODUCTION_POOL);
    expect(observed.get('worker')).toMatchObject({ total: 1, started: 1, standby: 1 });
    expect(observed.get('app')).toMatchObject({ total: 2, started: 2, standby: 0 });
  });

  it('does not count a machine that is being destroyed or replaced', () => {
    // The release command runs in a temporary machine Fly destroys as the deploy
    // finishes, and `replacing` is the middle of a rolling update. Counting
    // either would make this guard red for the duration of a normal deploy —
    // the false-alarm class it is replacing.
    const observed = observedShape([
      machine('a', 'app', 'started'),
      machine('b', 'app', 'destroying'),
      machine('c', 'app', 'destroyed'),
      machine('d', 'app', 'replacing'),
    ]);
    expect(observed.get('app')).toMatchObject({ total: 1, started: 1 });
  });
});

describe('the pool motir-core actually runs PASSES, with no stored count (MOTIR-3570)', () => {
  it('accepts four machines across two groups', () => {
    // The exact reading that made the old guard red — `machine_count=4,
    // expected=2` — against the config that was live at the same moment. Nothing
    // was edited to make this pass; the expectation is computed from the file.
    const result = assertPool(REAL_FLY_TOML, PRODUCTION_POOL);
    expect(result.findings).toEqual([]);
    expect(result.code).toBe(EXIT_CLEAN);
    expect(result.report.join('\n')).toContain('app: 2 machine(s), 2 started');
  });

  it('a THIRD process group needs no edit anywhere else', () => {
    // The acceptance criterion, executed: adding a group to `[processes]` and
    // deploying it is the whole change. Under the old guard this same pair of
    // edits went red until somebody remembered a repo variable — which is
    // precisely what happened when MOTIR-3425 added `worker`.
    const withScheduler = REAL_FLY_TOML.replace(
      /^\s*worker = .*$/m,
      (line) => `${line}\n  scheduler = "node scheduler/scheduler.mjs"`,
    );
    expect(parseFlyConfig(withScheduler).groups).toEqual(['app', 'worker', 'scheduler']);

    const deployed = [...PRODUCTION_POOL, machine('f00d', 'scheduler', 'started')];
    expect(assertPool(withScheduler, deployed).code).toBe(EXIT_CLEAN);
  });

  it('and SCALING one needs no edit either', () => {
    // The other half: `fly scale count app=3` raises the pool above the declared
    // floor, which is what a floor means. A stored total would have gone red.
    const scaled = [...PRODUCTION_POOL, machine('f00e', 'app', 'started')];
    expect(assertPool(REAL_FLY_TOML, scaled).code).toBe(EXIT_CLEAN);
  });
});

describe('the guard still FAILS on real drift — the deliberate negatives (MOTIR-3570)', () => {
  it('a declared group with no machine of its own', () => {
    // MOTIR-2102's shape exactly: a configuration describing a deployment nobody
    // made. Note the standby is STILL there, so the group is not empty on the
    // platform — counting rows rather than pool members would call this fine.
    const scaledToZero = PRODUCTION_POOL.filter((m) => m['id'] !== '8576143c4ee538');
    const result = assertPool(REAL_FLY_TOML, scaledToZero);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.findings.join('\n')).toMatch(/declares "worker" and the platform runs 0 machine/);
  });

  it('an HTTP tier below its min_machines_running floor, at an UNCHANGED total', () => {
    // The failure a sum cannot see. Four machines before, four after; the web
    // tier has halved. `min_machines_running = 2` is an availability decision
    // (MOTIR-2785) and this is the only assertion that reads it.
    const halved = PRODUCTION_POOL.map((m) =>
      m['id'] === '7817663f103648' ? { ...m, state: 'stopped' } : m,
    );
    const result = assertPool(REAL_FLY_TOML, halved);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.findings.join('\n')).toMatch(/only 1 of its 2 machine\(s\) are started/);
  });

  it('a group running on the platform that fly.toml never declared', () => {
    // The direction a per-group floor would otherwise miss: machines nobody
    // asked for, billed monthly, invisible to a check that only looks for what
    // the file names.
    const orphaned = [...PRODUCTION_POOL, machine('c0ffee', 'legacy-cron', 'started')];
    const result = assertPool(REAL_FLY_TOML, orphaned);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.findings.join('\n')).toMatch(/"legacy-cron"[\s\S]*does not declare/);
  });

  it('a declared group whose ONLY machine is a standby', () => {
    // A standby is stopped until host hardware fails. A group represented by one
    // is not a running group, however many rows the API returns for it.
    const standbyOnly = [
      machine('83d1300b7460e8', 'app', 'started'),
      machine('7817663f103648', 'app', 'started'),
      machine('891e16eb021e28', 'worker', 'stopped', { standbyFor: ['8576143c4ee538'] }),
    ];
    expect(assertPool(REAL_FLY_TOML, standbyOnly).code).toBe(EXIT_DRIFT);
  });
});

describe('a read that could not see is not a pass (MOTIR-3570)', () => {
  it('an EMPTY machine list is a blind read, never an empty pool', () => {
    // The app has just been deployed to, so zero machines is not an observation
    // this guard can act on. A guard whose only failure mode is a mismatch would
    // return clean here — the same vacuous-success shape that let a stray-design
    // scan report 0 findings over 42 rows (MOTIR-3227).
    const result = assertPool(REAL_FLY_TOML, []);
    expect(result.code).toBe(EXIT_BLIND_READ);
    expect(result.findings.join('\n')).toMatch(/blind read/);
  });

  it('a body that is not a machine list is a blind read too', () => {
    expect(assertPool(REAL_FLY_TOML, null as never).code).toBe(EXIT_BLIND_READ);
  });
});
