import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLI_VERSION } from './version.js';
import { stateDir } from './config/userConfig.js';

// IS THIS `motir` OUT OF DATE, AND CAN IT SAY SO? (MOTIR-4973 · MOTIR-4970)
//
// The reported failure was `Unknown command "login"` on a 0.1.0 install — an
// error that is TRUE and tells the reader nothing about the actual problem. It
// sends them to the docs, to their typing, to whether the feature exists; the
// one thing it does not say is "your CLI is six weeks old". Every command we add
// widens the gap between what a stale install can do and what the docs describe,
// so without a staleness signal the same confusion returns wearing a different
// command name each time.
//
// ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
// It is the LOCAL half: this CLI reading its own version against the registry,
// on this machine. It ships INSIDE the image, so by construction it cannot reach
// a container that is already stale — which is precisely the reader who filed
// the bug. MOTIR-4974 is the half that does, by reporting the version to the
// server and having the server hold a floor.
//
// ── EVERY FAILURE MODE HERE IS "SAY NOTHING" ────────────────────────────────
// A version check is a courtesy, never a gate. A registry that is down, slow,
// rate-limiting, or answering something unparseable must leave the command the
// user actually typed completely unaffected — so every path below collapses to
// `null`, and `null` prints nothing. There is no arm that throws.

/** The published package this CLI is a copy of. */
export const CLI_PACKAGE = '@motir/cli';

/** The registry endpoint that answers with the newest published version. */
export const REGISTRY_URL = `https://registry.npmjs.org/${CLI_PACKAGE}/latest`;

/**
 * How long the lookup may take before it is abandoned.
 *
 * Deliberately short: this runs BEFORE the command the user typed, so its worst
 * case is added to every single invocation. A second and a half is long enough
 * for a healthy registry and short enough that a sick one is not felt as "the
 * CLI hangs".
 */
export const REGISTRY_TIMEOUT_MS = 1_500;

/**
 * How long an answer is reused before the registry is asked again.
 *
 * ⚠️ THE POINT IS THAT THIS DOES NOT RUN ON EVERY INVOCATION. `motir` is used in
 * loops — `auto` and `batch` drive it repeatedly — and a per-command network
 * round-trip to publish a notice that cannot change between two commands a
 * second apart is pure cost. Six hours means a person who starts work stale is
 * told within one session, and a loop pays for it once.
 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

/** Where the answer is remembered — the STATE home, never the config dir. */
export function versionCachePath(): string {
  // `stateDir()` exists precisely because the config dir is mounted READ-ONLY in
  // the sandbox (MOTIR-1836): state written beside the credential had no
  // writable home and crashed unattended runs. A cache is state.
  return join(stateDir(), 'version-check.json');
}

interface VersionCache {
  latest: string;
  checkedAt: number;
}

/**
 * Compare two dotted numeric versions.
 *
 * Prerelease and build metadata are TRUNCATED rather than ordered: this decides
 * whether to print a sentence, and getting `1.2.3-rc.1 < 1.2.3` right is not
 * worth a semver dependency in a module whose every failure mode is silence.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    value
      .split(/[-+]/)[0]!
      .split('.')
      .map((piece) => Number.parseInt(piece, 10))
      .map((piece) => (Number.isFinite(piece) ? piece : 0));
  const left = parts(a);
  const right = parts(b);
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Is `current` behind `latest`? Unparseable input answers `false` — say nothing. */
export function isOutdated(current: string, latest: string): boolean {
  if (!current || !latest) return false;
  return compareVersions(current, latest) < 0;
}

export interface FetchLike {
  (
    url: string,
    init?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>;
}

/**
 * Ask the registry for the newest published version.
 *
 * Answers `null` for EVERY failure — a network error, a timeout, a non-200, a
 * body that is not JSON, and a body whose `version` is missing or not a string.
 * Each of those is a real thing a registry does, and none of them is a reason to
 * interrupt the command somebody typed.
 */
export async function fetchLatestVersion(
  fetchImpl: FetchLike,
  timeoutMs: number = REGISTRY_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    const version = body?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the remembered answer, or `null` when there is none or it has expired. */
export function readVersionCache(now: number, path = versionCachePath()): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VersionCache>;
    if (typeof parsed.latest !== 'string' || typeof parsed.checkedAt !== 'number') return null;
    if (now - parsed.checkedAt >= CACHE_TTL_MS) return null;
    return parsed.latest;
  } catch {
    return null;
  }
}

/**
 * Remember an answer. A cache that cannot be written is not an error.
 *
 * ⚠️ THIS MAY NOT CREATE THE CLI'S STATE HOME, ONLY THE LEAF INSIDE ONE THAT
 * ALREADY EXISTS — and that is a hard invariant, not a tidiness preference.
 * `motir` running on `MOTIR_TOKEN` alone, with no config file, must persist
 * NOTHING: it is the CI / container / fresh-box shape, and the read-only
 * sandbox mount depends on it (`tests/cli/cli-story.test.ts` asserts it by
 * ABSENCE, so it holds regardless of uid). `stateDir()` falls back through
 * `MOTIR_CONFIG_HOME`, so a `recursive: true` here conjures the very directory
 * that run is required not to have — a version-check courtesy would have
 * quietly become the thing that broke the property.
 *
 * So the `mkdir` is NON-recursive: it creates `<state home>/motir` when the
 * state home is there, and throws `ENOENT` when it is not, which the catch
 * turns into "no cache this time". The cost is that a machine with no state
 * home re-asks the registry — bounded, silent on failure, and far cheaper than
 * the property this protects.
 */
export function writeVersionCache(latest: string, now: number, path = versionCachePath()): void {
  try {
    mkdirSync(dirname(path));
  } catch (err) {
    // EEXIST is the ordinary case — the directory is already there, carry on.
    // ENOENT means the state home does not exist and we may not create it.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return;
  }
  try {
    writeFileSync(path, JSON.stringify({ latest, checkedAt: now } satisfies VersionCache));
  } catch {
    // A read-only state home is a reason to check again next time, not to fail.
  }
}

/**
 * Can this install upgrade ITSELF?
 *
 * ⚠️ THE ANSWER IS NO IN THE SANDBOX, AND THAT IS THE TRAP THIS FUNCTION EXISTS
 * FOR. The image installs the CLI globally as ROOT and then drops to `USER
 * node`, and the chown covers `/workspace` and `/home/node` — not the global npm
 * prefix. So `npm i -g @motir/cli@latest` fails `EACCES` there, and a card that
 * assumed a writable prefix would ship a prompt that is broken in exactly the
 * environment this bug came from.
 *
 * ⚠️ AND IT IS A WRITABILITY TEST, NEVER A "am I in a container" SNIFF. The
 * question is whether the upgrade would work; container-detection answers a
 * correlated question and is wrong for a rootful container, a host install under
 * a root-owned prefix, and a user-owned prefix inside a container alike.
 */
export function globalPrefixDir(execPath = process.execPath): string {
  // `<prefix>/bin/node` → `<prefix>/lib/node_modules`, npm's global root.
  return join(dirname(dirname(execPath)), 'lib', 'node_modules');
}

export function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * What to tell a reader whose prefix is not writable.
 *
 * ⚠️ TRANSCRIBED from the recipe MOTIR-4972 settled in `lib/apiDocs/sandbox.ts`,
 * not re-worded here. `packages/cli` cannot import the app's `lib/`, so the
 * literal is copied and cited — the same transcribe-don't-derive rule the
 * published docs page follows. Two wordings of one recipe is how the guide and
 * the product drift apart while each is individually correct.
 */
export function pullAndRerunRecipe(): string[] {
  return [
    'This install cannot upgrade itself — its global npm prefix is not writable',
    '(the sandbox image installs the CLI as root). Start a fresh container instead;',
    'the documented command already fetches the current image:',
    '',
    '  docker run -it --rm --pull=always \\',
    '    -v "$PWD:/workspace" \\',
    '    -v motir-auth:/home/node/.config/motir \\',
    '    <your profile’s credential mount> \\',
    '    ghcr.io/moooon-b-v/motir-sandbox:<profile>',
    '',
    'Your sign-in lives in the motir-auth volume, so it survives the swap.',
  ];
}

/** The one-line notice. It names BOTH versions — that is its whole job. */
export function stalenessNotice(current: string, latest: string): string {
  return `${CLI_PACKAGE} ${current} is out of date — ${latest} is published.`;
}

export interface StalenessCheck {
  /** `null` when nothing should be said. */
  notice: string | null;
  latest: string | null;
  /** Only ever true when a notice is owed AND the upgrade could actually work. */
  canUpgrade: boolean;
}

/**
 * The real writability probe, named rather than inlined as a parameter default
 * so it is a seam a test can drive directly — the same reason every other IO
 * touch in this module is one.
 */
export function defaultPrefixWritable(): boolean {
  return isWritable(globalPrefixDir());
}

/**
 * Where a notice goes: stderr, never stdout. `output.ts` keeps stdout a clean
 * payload channel, and a courtesy notice that corrupted a piped `--json` read
 * would be a worse bug than the staleness it reports.
 */
export function defaultNotify(line: string): void {
  process.stderr.write(`${line}\n`);
}

export interface StalenessDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  current?: string;
  readCache?: (now: number) => string | null;
  writeCache?: (latest: string, now: number) => void;
  prefixWritable?: () => boolean;
}

/**
 * Decide what, if anything, to say. Pure of output and of prompting, so every
 * arm below is drivable in a test without a TTY, a network or a home directory.
 */
export async function checkStaleness(deps: StalenessDeps = {}): Promise<StalenessCheck> {
  const {
    fetchImpl = globalThis.fetch as unknown as FetchLike,
    now = Date.now,
    current = CLI_VERSION,
    readCache = readVersionCache,
    writeCache = writeVersionCache,
    prefixWritable = defaultPrefixWritable,
  } = deps;

  const at = now();
  let latest = readCache(at);
  if (latest === null) {
    latest = await fetchLatestVersion(fetchImpl);
    // Only a real answer is remembered: caching a failure would suppress the
    // notice for six hours because the registry blinked once.
    if (latest !== null) writeCache(latest, at);
  }

  if (latest === null || !isOutdated(current, latest)) {
    return { notice: null, latest, canUpgrade: false };
  }
  return { notice: stalenessNotice(current, latest), latest, canUpgrade: prefixWritable() };
}

/**
 * The argv shapes that must NOT trigger a version check.
 *
 * ⚠️ `--version` ABOVE ALL. The cheapest command in the CLI has to stay the
 * cheapest, and a version flag that waited on a registry round-trip to announce
 * that a newer version exists would be a self-parody. `--help` and a bare
 * `motir` are here for the same reason: they answer from what is already
 * installed and reach nothing.
 */
const CHEAP_FLAGS = new Set(['--version', '-v', '--help', '-h', 'help']);

/**
 * The unattended lanes, which are never PROMPTED (they are still NOTIFIED).
 *
 * A prompt in a loop nobody is watching hangs the run at a random later
 * iteration. Gating only on a TTY is not sufficient: `motir auto` started from a
 * terminal and then left alone has one, right up until the moment it matters.
 */
const UNATTENDED = new Set(['auto', 'batch']);

/** Should a version check run for this argv at all? */
export function shouldCheckStaleness(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  return !argv.some((token) => CHEAP_FLAGS.has(token));
}

/** Is this argv one of the loop lanes that must never be prompted? */
export function isUnattendedArgv(argv: readonly string[]): boolean {
  return UNATTENDED.has(argv[0] ?? '');
}

export interface AnnounceDeps extends StalenessDeps {
  /** Where the notice goes. Defaults to the CLI's stderr chrome channel. */
  notify?: (line: string) => void;
  interactive?: () => boolean;
  confirm?: (question: string) => Promise<string>;
  upgrade?: () => { ok: boolean; version?: string };
}

/**
 * Say it, and — only where that could work — offer to fix it.
 *
 * ⚠️ THE NOTICE IS UNCONDITIONAL; THE PROMPT IS NOT. `auto` and `batch` are
 * unattended loops (nobody is watching, and nobody can answer), so a prompt
 * there hangs a run indefinitely. But the NOTICE is exactly what makes a stale
 * CI agent diagnosable months later, so it is printed either way. Gating both on
 * a TTY would have removed the signal from the only place it is read by someone
 * who cannot see the terminal.
 *
 * ⚠️ AND IT IS A NOTICE, NOT A GATE. A stale CLI is DEGRADED, never blocked: the
 * command runs afterwards in every branch below, including the one where the
 * upgrade fails. Locking someone out would be worst precisely for the reader
 * this bug is about, whose only route to a newer CLI may be the stale sandbox
 * they are standing in.
 */
export async function announceStaleness(deps: AnnounceDeps = {}): Promise<void> {
  const {
    notify = defaultNotify,
    interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm,
    upgrade = runSelfUpgrade,
  } = deps;

  const check = await checkStaleness(deps);
  if (check.notice === null) return;

  notify(check.notice);

  if (!check.canUpgrade) {
    for (const line of pullAndRerunRecipe()) notify(line);
    return;
  }

  notify(`Upgrade with:  npm install -g ${CLI_PACKAGE}@latest`);
  if (!interactive() || !confirm) return;

  const answer = (await confirm(`Upgrade to ${check.latest} now? [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return;

  const result = upgrade();
  notify(
    result.ok
      ? `Upgraded to ${result.version ?? check.latest}. The new version takes effect on the next command.`
      : `Upgrade failed. Run \`npm install -g ${CLI_PACKAGE}@latest\` yourself; continuing on ${CLI_VERSION}.`,
  );
}

/**
 * Perform the upgrade. Separated so `announceStaleness` can be driven in a test
 * without a package manager, and so the failure path is a VALUE rather than an
 * exception — this runs inside a courtesy notice and may not take the command
 * down with it.
 */
export function runSelfUpgrade(run: (command: string, args: string[]) => string = defaultRun): {
  ok: boolean;
  version?: string;
} {
  try {
    run('npm', ['install', '-g', `${CLI_PACKAGE}@latest`]);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function defaultRun(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
}
