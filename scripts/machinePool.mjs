/**
 * The LOGIC half of `scripts/assert-machine-pool.mjs` (MOTIR-3570).
 *
 * WHY IT IS SPLIT OUT. Same reason `scripts/detectStrayDesignResults.mjs` is
 * split from its runner: the runner reads a file, calls Fly's API, prints to
 * stdout and `process.exit`s, and a module that does any of those on import
 * cannot be called by a test. Everything here is pure — it takes the text of
 * `fly.toml` and the machine list Fly's API returned, and returns findings.
 *
 * WHAT THIS REPLACES, AND WHY THE OLD SHAPE COULD NOT BE FIXED BY EDITING ITS
 * NUMBER. The deploy job used to assert `machine_count == vars.FLY_EXPECTED_
 * MACHINE_COUNT`, a repo variable set to `2` by MOTIR-2408 when the pool WAS two
 * app machines. MOTIR-3425 introduced the `worker` process group, the pool became
 * four, and nothing updated the variable — so every deploy ended RED on a deploy
 * that had SUCCEEDED (the image released, the release answered, Inngest synced,
 * the migrations applied). A red `CI complete` that says nothing about whether
 * the trunk is deployed is worse than no check: the reader concludes it did not
 * ship and goes looking for why.
 *
 * A SUM IS THE WRONG ASSERTION. The pool is now a sum over process groups, each
 * scaled independently for its own reasons, so a single total is drift-prone in
 * both directions: it goes stale the moment a group is added, and it cannot tell
 * `app=2, worker=2` from `app=1, worker=3` — the second of which halves the web
 * tier while the total stays 4. What the configuration actually declares is a
 * SHAPE:
 *
 *   * `[processes]` names the groups that must exist. Declaring one is not
 *     enough to make a machine (`fly.toml` cannot provision — MOTIR-2102), but
 *     `flyctl deploy` reconciles the declaration and creates the missing machine
 *     itself, which is why this guard can run in the same job, straight after
 *     the release, and expect the answer to be true by then.
 *   * `http_service.processes` names the groups that serve traffic, and
 *     `min_machines_running` is a FLOOR on how many of those stay RUNNING. It is
 *     an availability decision (MOTIR-2785): two machines running is the only
 *     configuration that survives losing one.
 *
 * So the expectation is DERIVED from those keys rather than stored beside them,
 * and adding or scaling a group updates it by construction. There is no repo
 * variable left to go stale.
 *
 * ⚠️ THE OBSERVATION IS STILL READ FROM THE PLATFORM, NEVER FROM `fly.toml` —
 * MOTIR-2102 is untouched and this module is built around it. The config supplies
 * only the EXPECTATION; every count compared against it comes from
 * `GET /v1/apps/<app>/machines`. Confusing the two is what let motir-ai run one
 * machine for weeks behind a file that described N.
 *
 * ⚠️ A STANDBY IS NOT A MEMBER OF THE POOL. Fly adds a standby machine to a
 * single-machine group — `fly status` marks it with a dagger, it sits `stopped`,
 * and it takes over only on host hardware failure. Nothing in `fly.toml` asks for
 * it, so counting it would put an undeclarable number back into the expectation.
 * A machine is a standby exactly when its config carries a non-empty `standbys`
 * list (it names the machines it watches), and this module counts only the rest.
 */

/** Exit codes. `1` means DRIFT; `3` means the instrument could not see. */
export const EXIT_CLEAN = 0;
export const EXIT_DRIFT = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLIND_READ = 3;

/**
 * Machine states that hold no capacity and must not be counted. A release
 * command runs in a temporary machine that Fly destroys as the deploy finishes,
 * and `replacing` is the middle of a rolling update — neither is drift.
 */
const GONE_STATES = new Set(['destroyed', 'destroying', 'replacing']);

/**
 * Read the subset of `fly.toml` this guard derives its expectation from.
 *
 * Hand-parsed rather than parsed: this repo has no TOML dependency (nor a YAML
 * one — see `tests/ci-fly-deploy.test.ts` on the same constraint), and pulling
 * one in for four keys would be the larger change. The parse is deliberately
 * NARROW and LOUD: it understands table headers, `key = value` lines and arrays
 * of quoted strings, and it THROWS on anything it needed and did not find.
 *
 * The failure mode being designed against is a parser that returns `{}` on a
 * file it did not understand — the guard would then expect nothing, pass, and
 * read exactly like a guard that checked something.
 *
 * @param {string} toml the text of `fly.toml`
 * @returns {{ groups: string[], httpGroups: string[], minMachinesRunning: number }}
 */
export function parseFlyConfig(toml) {
  if (typeof toml !== 'string' || toml.trim() === '') {
    throw new Error('fly.toml is empty — nothing to derive an expectation from');
  }

  /** @type {Map<string, Map<string, string>>} table path → key → raw value */
  const tables = new Map();
  let path = '';

  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `[[vm]]` — an array of tables. Its keys are not read here, but its
    // `processes = [...]` must not be attributed to whatever table came before.
    const arrayHeader = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayHeader) {
      path = `[[${arrayHeader[1].trim()}]]`;
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      path = header[1].trim();
      if (!tables.has(path)) tables.set(path, new Map());
      continue;
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(stripComment(line));
    if (!pair) continue;
    if (!tables.has(path)) tables.set(path, new Map());
    tables.get(path).set(pair[1], pair[2].trim());
  }

  const processes = tables.get('processes');
  if (!processes || processes.size === 0) {
    throw new Error(
      'fly.toml declares no [processes] table — the group set cannot be derived, ' +
        'so this guard would assert nothing. Add the table, or change the guard on purpose.',
    );
  }
  const groups = [...processes.keys()];

  const http = tables.get('http_service');
  if (!http) {
    // No HTTP tier at all is a legitimate shape (a worker-only app), and then
    // there is no running floor to derive.
    return { groups, httpGroups: [], minMachinesRunning: 0 };
  }

  const declared = http.get('processes');
  if (declared === undefined) {
    throw new Error(
      'fly.toml has [processes] and [http_service] but no http_service.processes — ' +
        'Fly would route requests to every group, including ones that listen on no port.',
    );
  }
  const httpGroups = parseStringArray(declared);
  for (const group of httpGroups) {
    if (!groups.includes(group)) {
      throw new Error(
        `http_service.processes names "${group}", which is not a group in [processes]`,
      );
    }
  }

  const floor = http.get('min_machines_running');
  const minMachinesRunning = floor === undefined ? 0 : Number.parseInt(floor, 10);
  if (!Number.isInteger(minMachinesRunning) || minMachinesRunning < 0) {
    throw new Error(`http_service.min_machines_running is not a count: ${floor}`);
  }

  return { groups, httpGroups, minMachinesRunning };
}

/** Drop a `#` comment from a `key = value` line, ignoring one inside quotes. */
function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === '#' && !quoted) return line.slice(0, i).trim();
  }
  return line;
}

/** `["app", "worker"]` → `['app', 'worker']`. */
function parseStringArray(value) {
  const inner = /^\[(.*)\]$/.exec(value.trim());
  if (!inner) throw new Error(`expected an array, got: ${value}`);
  return [...inner[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * What the configuration DECLARES, per group.
 *
 * `exists` is 1 for every declared group — a group with no machine is the
 * MOTIR-2102 shape, a declaration standing in for a command nobody ran.
 * `running` is the `min_machines_running` floor, and it applies only to the
 * groups that serve HTTP, because that key lives under `[http_service]` and is
 * scoped by `http_service.processes`. A non-serving group has no declared floor,
 * so this guard requires only that it exists — asserting a `started` count for a
 * worker would be inventing a number the file does not carry.
 *
 * @param {{ groups: string[], httpGroups: string[], minMachinesRunning: number }} config
 * @returns {Map<string, { exists: number, running: number }>}
 */
export function expectedShape(config) {
  const expected = new Map();
  for (const group of config.groups) {
    expected.set(group, {
      exists: 1,
      running: config.httpGroups.includes(group) ? config.minMachinesRunning : 0,
    });
  }
  return expected;
}

/**
 * What the PLATFORM reports, per group — the observation half.
 *
 * @param {Array<Record<string, any>>} machines the `GET /v1/apps/<app>/machines` body
 * @returns {Map<string, { total: number, started: number, standby: number, ids: string[] }>}
 */
export function observedShape(machines) {
  const observed = new Map();
  for (const machine of machines) {
    if (GONE_STATES.has(machine.state)) continue;
    const group = machine?.config?.metadata?.fly_process_group ?? '(ungrouped)';
    const entry = observed.get(group) ?? { total: 0, started: 0, standby: 0, ids: [] };
    entry.ids.push(machine.id);
    if (isStandby(machine)) {
      entry.standby += 1;
    } else {
      entry.total += 1;
      if (machine.state === 'started') entry.started += 1;
    }
    observed.set(group, entry);
  }
  return observed;
}

/** A standby names the machines it watches; nothing else carries the key. */
export function isStandby(machine) {
  return Array.isArray(machine?.config?.standbys) && machine.config.standbys.length > 0;
}

/**
 * Compare the two and return every disagreement, in the order a reader wants
 * them: a missing group first (the deploy did not do what the file asked), then
 * a tier below its availability floor, then a group the file never declared.
 *
 * @param {string} flyToml
 * @param {Array<Record<string, any>>} machines
 * @returns {{ code: number, findings: string[], report: string[] }}
 */
export function assertPool(flyToml, machines) {
  if (!Array.isArray(machines)) {
    return {
      code: EXIT_BLIND_READ,
      findings: [
        "Fly's API did not return a machine list — the app is unreachable or the token cannot see it (Fly answers not-found, never forbidden).",
      ],
      report: [],
    };
  }
  if (machines.length === 0) {
    // A zero-machine answer is never a legitimate pass: the app it is about has
    // just been deployed to. Reading it as "no drift" is the vacuous-guard shape
    // this module exists to avoid.
    return {
      code: EXIT_BLIND_READ,
      findings: [
        "Fly's API returned NO machines for this app — that is a blind read, not an empty pool.",
      ],
      report: [],
    };
  }

  const config = parseFlyConfig(flyToml);
  const expected = expectedShape(config);
  const observed = observedShape(machines);

  const findings = [];
  const report = [];

  for (const [group, want] of expected) {
    const have = observed.get(group) ?? { total: 0, started: 0, standby: 0, ids: [] };
    const floor = want.running > 0 ? `, ≥${want.running} started` : '';
    report.push(
      `${group}: ${have.total} machine(s), ${have.started} started, ${have.standby} standby ` +
        `— declared: ≥${want.exists} machine(s)${floor}`,
    );
    if (have.total < want.exists) {
      findings.push(
        `[processes] declares "${group}" and the platform runs ${have.total} machine(s) in it. ` +
          'A declared group with no machine is a configuration that describes a deployment ' +
          'nobody made (MOTIR-2102).',
      );
      continue;
    }
    if (have.started < want.running) {
      findings.push(
        `"${group}" serves HTTP and http_service.min_machines_running is ${want.running}, ` +
          `but only ${have.started} of its ${have.total} machine(s) are started. ` +
          'That floor is an availability decision (MOTIR-2785), not a capacity one.',
      );
    }
  }

  for (const [group, have] of observed) {
    if (expected.has(group)) continue;
    report.push(`${group}: ${have.total} machine(s), ${have.standby} standby — NOT DECLARED`);
    findings.push(
      `The platform runs ${have.total + have.standby} machine(s) in "${group}" ` +
        `(${have.ids.join(', ')}), which fly.toml's [processes] does not declare. ` +
        'Either the group was removed from the file without being scaled to zero, or it was ' +
        'created outside this repository.',
    );
  }

  return { code: findings.length > 0 ? EXIT_DRIFT : EXIT_CLEAN, findings, report };
}

/**
 * Render the result for a workflow log. Every line the check produces is here,
 * so a red step reads as a sentence rather than as `machine_count=4, expected=2`.
 */
export function formatResult(app, { code, findings, report }) {
  const lines = [];
  for (const line of report) lines.push(`  ${line}`);
  if (code === EXIT_CLEAN) {
    lines.push(`${app}'s machine pool matches what fly.toml declares. ✓`);
    return lines.join('\n');
  }
  for (const finding of findings) lines.push(`::error::${finding}`);
  if (code === EXIT_DRIFT) {
    lines.push(
      '::error::' +
        `${app}'s pool differs from what fly.toml declares. Read the platform ` +
        '(`fly status -a ' +
        app +
        '`) and change the CONFIGURATION or the pool — there is no stored count to edit any more.',
    );
  }
  return lines.join('\n');
}
