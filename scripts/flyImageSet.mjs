/**
 * The LOGIC half of `scripts/repair-fly-image-set.mjs` (MOTIR-9354) — the deploy
 * job's PRE-release guard.
 *
 * WHAT GOES WRONG. `fly.toml` deploys `motir-core` blue-green: new (green)
 * machines start BESIDE the old (blue) ones, pass their checks, take traffic, and
 * only then are the blues destroyed. A deploy that stops anywhere in that window
 * — on 2026-10-23 flyctl hung after `Marking green machines as ready` until the
 * job's 30-minute backstop killed it — leaves BOTH colours standing: 20 machines
 * on the new image, 20 on the old one. flyctl's bluegreen pre-check then refuses
 * every later deploy:
 *
 *   Found 2 different images in your app (for bluegreen to work, all machines
 *   need to run a single image)
 *   Error: found multiple image versions
 *
 * and nothing merged reaches production until a person with a Fly token destroys
 * the stale machines by ID (`flyctl machines destroy --image=…` refuses with
 * `prompt: non interactive` in CI). It happened twice that day, the second time
 * from a `flyctl secrets set` racing a CI deploy.
 *
 * WHAT THIS DOES. The same thing that person did, decided by code that can be
 * tested: list the machines, and when they run more than one image, keep the
 * NEWEST image that has proven itself healthy and destroy every machine on any
 * other image. Then the deploy runs against a single-image app.
 *
 * ⚠️ IT REFUSES RATHER THAN GUESSES. Destroying production machines is the one
 * irreversible act in the deploy job, so every condition under which the keeper
 * cannot be trusted is a refusal, not a best effort:
 *
 *   * no image is healthy — keeping any of them could keep a broken one;
 *   * the keeper does not cover every process group the app runs — destroying
 *     the rest would empty a group, the web tier included;
 *   * a machine is mid-transition — the platform has not settled, and a sibling
 *     operation (a `flyctl secrets set`, a person at a terminal) may own it.
 *
 * And by construction it never destroys a machine on the keeper's image, so the
 * app is never left with no image at all.
 *
 * Same split as `scripts/machinePool.mjs`: everything here takes Fly's machine
 * list and returns a decision, and the one function that acts
 * (`repairImageSet`) takes its `fetch`, its clock and its log as arguments, so
 * the tests drive it without a network.
 */

/** Exit codes. `1` means the guard refused; `3` means the instrument could not see. */
export const EXIT_CLEAN = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLIND_READ = 3;

/**
 * Machine states that hold nothing to keep or destroy. A release command runs in
 * a temporary machine that Fly destroys as the deploy finishes.
 */
const GONE_STATES = new Set(['destroyed', 'destroying']);

/**
 * States in which a machine is being changed by SOMEBODY. The guard does not act
 * on an app that has not settled: a half-finished `flyctl secrets set` is exactly
 * one of these, and destroying under it races whoever started it.
 */
const TRANSITIONAL_STATES = new Set(['created', 'starting', 'stopping', 'replacing', 'updating']);

/** The release command's temporary machine is not part of the app's pool. */
const RELEASE_COMMAND_GROUP = 'fly_app_release_command';

/**
 * Which image a machine runs. The DIGEST is the identity — two tags can name one
 * image and one tag can be re-pushed — and `config.image` is the fallback for a
 * row that carries no `image_ref`.
 *
 * @param {Record<string, any>} machine
 * @returns {{ id: string, label: string }}
 */
export function imageOf(machine) {
  const ref = machine?.image_ref ?? {};
  const name = [ref.registry, ref.repository].filter(Boolean).join('/');
  const label =
    name && ref.tag ? `${name}:${ref.tag}` : (machine?.config?.image ?? '(unknown image)');
  return { id: ref.digest ? `${name}@${ref.digest}` : label, label };
}

/** The process group a machine belongs to. */
function groupOf(machine) {
  return machine?.config?.metadata?.fly_process_group ?? '(ungrouped)';
}

/** A standby names the machines it watches; nothing else carries the key. */
function isStandby(machine) {
  return Array.isArray(machine?.config?.standbys) && machine.config.standbys.length > 0;
}

/**
 * A machine has proven itself when it is started and every check it carries
 * passes. A machine with no checks (the `worker` group) proves only that it
 * started — the same rule flyctl's bluegreen applies to it.
 */
function isProven(machine) {
  if (machine.state !== 'started') return false;
  const checks = Array.isArray(machine.checks) ? machine.checks : [];
  return checks.every((check) => check?.status === 'passing');
}

/** The release a machine was deployed by, as a number, or -1 when unknown. */
function releaseOf(machine) {
  const raw = machine?.config?.metadata?.fly_release_version;
  const version = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(version) ? version : -1;
}

/** Milliseconds since epoch of a machine's creation, or 0 when unknown. */
function createdOf(machine) {
  const at = Date.parse(machine?.created_at ?? '');
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Group the pool by image, with what each image has shown.
 *
 * @param {Array<Record<string, any>>} machines
 */
export function imageSets(machines) {
  const pool = machines.filter(
    (m) => !GONE_STATES.has(m.state) && groupOf(m) !== RELEASE_COMMAND_GROUP,
  );
  const sets = new Map();
  for (const machine of pool) {
    const image = imageOf(machine);
    const set = sets.get(image.id) ?? {
      image: image.id,
      label: image.label,
      ids: [],
      groups: new Set(),
      proven: 0,
      provenWithChecks: 0,
      release: -1,
      created: 0,
    };
    set.ids.push(machine.id);
    if (!isStandby(machine)) set.groups.add(groupOf(machine));
    if (isProven(machine)) {
      set.proven += 1;
      if (Array.isArray(machine.checks) && machine.checks.length > 0) set.provenWithChecks += 1;
    }
    set.release = Math.max(set.release, releaseOf(machine));
    set.created = Math.max(set.created, createdOf(machine));
    sets.set(image.id, set);
  }
  return { pool, sets: [...sets.values()] };
}

/**
 * Decide what to do with the pool. Returns the images, which one to keep and
 * which machines to destroy — or a refusal with its reason.
 *
 * @param {Array<Record<string, any>>} machines the `GET /v1/apps/<app>/machines` body
 * @returns {{
 *   code: number,
 *   action: 'none' | 'destroy' | 'refuse',
 *   keep: string | null,
 *   destroy: string[],
 *   findings: string[],
 *   report: string[],
 * }}
 */
export function planRepair(machines) {
  if (!Array.isArray(machines) || machines.length === 0) {
    return refuse(
      EXIT_BLIND_READ,
      "Fly's API returned no machine list for this app — a blind read, not an empty app.",
      [],
    );
  }

  const { pool, sets } = imageSets(machines);
  const report = sets.map(describe);

  if (sets.length <= 1) {
    return {
      code: EXIT_CLEAN,
      action: 'none',
      keep: sets[0]?.image ?? null,
      destroy: [],
      findings: [],
      report,
    };
  }

  const busy = pool.filter((m) => TRANSITIONAL_STATES.has(m.state));
  if (busy.length > 0) {
    return refuse(
      EXIT_REFUSED,
      `${busy.length} machine(s) are mid-transition (${busy.map((m) => `${m.id} ${m.state}`).join(', ')}). ` +
        'Something else is changing this app; the guard does not destroy under it.',
      report,
    );
  }

  const appGroups = new Set(pool.filter((m) => !isStandby(m)).map(groupOf));
  const anyChecks = pool.some((m) => Array.isArray(m.checks) && m.checks.length > 0);
  const candidates = sets
    .filter((set) => set.proven > 0 && (!anyChecks || set.provenWithChecks > 0))
    .filter((set) => [...appGroups].every((group) => set.groups.has(group)))
    .sort((a, b) => b.release - a.release || b.created - a.created);

  const keeper = candidates[0];
  if (!keeper) {
    return refuse(
      EXIT_REFUSED,
      'No image is both healthy (a started machine with every check passing) and present in every ' +
        `process group (${[...appGroups].join(', ')}), so there is no image it is safe to keep. ` +
        'Destroy machines by hand, or redeploy a known-good image.',
      report,
    );
  }

  const destroy = pool.filter((m) => imageOf(m).id !== keeper.image).map((m) => m.id);
  return { code: EXIT_CLEAN, action: 'destroy', keep: keeper.image, destroy, findings: [], report };
}

function refuse(code, finding, report) {
  return { code, action: 'refuse', keep: null, destroy: [], findings: [finding], report };
}

function describe(set) {
  const release = set.release >= 0 ? `release v${set.release}, ` : '';
  return (
    `${set.label}: ${set.ids.length} machine(s) in ${[...set.groups].join(', ') || '(standbys only)'} ` +
    `— ${release}${set.proven} healthy`
  );
}

/**
 * Render a plan for the workflow log. Every image is named, so a red step — or
 * the post-failure report — says which two images were left behind.
 *
 * @param {string} app
 * @param {ReturnType<typeof planRepair>} plan
 */
export function formatPlan(app, plan) {
  const lines = plan.report.map((line) => `  ${line}`);
  if (plan.action === 'none') {
    lines.push(`${app} runs a single image. ✓`);
  } else if (plan.action === 'destroy') {
    lines.push(
      `${app} runs ${plan.report.length} images. Keeping ${plan.keep}; ` +
        `destroying ${plan.destroy.length} machine(s) on the others: ${plan.destroy.join(', ')}`,
    );
  } else {
    for (const finding of plan.findings) lines.push(`::error::${finding}`);
  }
  return lines.join('\n');
}

/**
 * Read the pool, wait for it to settle, and destroy every machine off the
 * keeper's image. With `reportOnly`, read and print and change nothing — the
 * deploy job's post-failure step, which names the images a failed release left.
 *
 * @param {{
 *   app: string,
 *   token: string,
 *   reportOnly?: boolean,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   settleAttempts?: number,
 *   settleDelayMs?: number,
 * }} options
 * @returns {Promise<number>} the exit code
 */
export async function repairImageSet({
  app,
  token,
  reportOnly = false,
  fetch: request = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // eslint-disable-next-line no-console -- a CLI guard; stdout is its interface.
  log = console.log,
  settleAttempts = 6,
  settleDelayMs = 20_000,
}) {
  const base = `https://api.machines.dev/v1/apps/${app}/machines`;
  const headers = { Authorization: `Bearer ${token}` };

  const read = async () => {
    try {
      const res = await request(base, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        log(
          `::error::Fly's API answered ${res.status} for ${app} — the app is unreachable, ` +
            'or the token cannot see it (Fly answers not-found, never forbidden).',
        );
        return null;
      }
      return await res.json();
    } catch (error) {
      log(`::error::Could not read Fly's machine list for ${app}: ${error}`);
      return null;
    }
  };

  let plan;
  for (let attempt = 1; ; attempt++) {
    const machines = await read();
    if (machines === null) return EXIT_BLIND_READ;
    plan = planRepair(machines);
    const unsettled = plan.action === 'refuse' && /mid-transition/.test(plan.findings[0] ?? '');
    if (reportOnly || !unsettled || attempt >= settleAttempts) break;
    log(
      `  ${plan.findings[0]} Waiting ${settleDelayMs / 1000}s (attempt ${attempt}/${settleAttempts}).`,
    );
    await sleep(settleDelayMs);
  }

  log(formatPlan(app, plan));
  if (reportOnly) return plan.code === EXIT_BLIND_READ ? EXIT_BLIND_READ : EXIT_CLEAN;
  if (plan.action !== 'destroy') return plan.code;

  for (const id of plan.destroy) {
    const res = await request(`${base}/${id}?force=true`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => ({ ok: false, status: String(error) }));
    if (!res.ok) {
      log(
        `::error::Destroying machine ${id} failed (${res.status}); the app still runs two images.`,
      );
      return EXIT_REFUSED;
    }
    log(`  destroyed ${id}`);
  }

  // Read it back: the deploy's pre-check is what has to pass, so prove it will.
  const after = await read();
  if (after === null) return EXIT_BLIND_READ;
  const check = planRepair(after);
  if (check.action !== 'none') {
    log(formatPlan(app, check));
    log(`::error::${app} still runs more than one image after the repair.`);
    return EXIT_REFUSED;
  }
  log(`${app} is back on a single image (${plan.keep}). ✓`);
  return EXIT_CLEAN;
}
