// THE CLIENT VERSION A CALLER REPORTS, AND THE FLOOR THIS SERVER HOLDS
// (Story MOTIR-4970 · Subtask MOTIR-4974).
//
// ── Why this exists at all ──────────────────────────────────────────────────
// A reader's sandbox container ran `@motir/cli` 0.1.0 for six weeks and found
// out only when `motir login` answered `Unknown command`. Its siblings in that
// bug — a disposable container recipe, and a local staleness check — both ship
// INSIDE the image, so neither can reach a container that already exists. The
// server is the one thing an already-running client still talks to, which makes
// this the only half of the fix with any reach into the installed base.
//
// ── ⚠️ A NEW FIELD, NOT THE OLD ONE ─────────────────────────────────────────
// The CLI used to send `motir-cli/<version>` as the dispatch HARNESS, and
// MOTIR-2447 removed that deliberately: it overwrote the agent name and model
// `mark_integrated` had recorded during the run, undoing MOTIR-2419's fix at the
// very next step of the lifecycle. The version is TELEMETRY ABOUT THE CLIENT;
// the harness and model are PROVENANCE ABOUT THE WORK. Re-using that field would
// fix this bug and silently re-break MOTIR-2419, in a diff that would look like
// one line — which is exactly why this is a transport header and why
// `packages/cli/test/staleness*.test.ts` asserts the close-out still carries
// `CLOSE_OUT_SOURCE = 'byok'`.
//
// ── ⚠️ WARN, NEVER REFUSE ───────────────────────────────────────────────────
// The verdict is a response HEADER on a request that otherwise succeeds. A hard
// floor would strand precisely the reader this bug is about, whose only route to
// a newer CLI may be the stale sandbox they are standing in: a correct diagnosis
// and no way to act on it is worse than the confusion it replaces. If a refusal
// is ever wanted, that is a second decision and a second card.

/** What a client reports its version on. Read off the REQUEST. */
export const CLIENT_VERSION_HEADER = 'x-motir-client-version';

/** Where the verdict is written. Stamped on the RESPONSE, and never fatal. */
export const CLIENT_WARNING_HEADER = 'x-motir-client-warning';

/**
 * The floor, owned by the SERVER.
 *
 * ⚠️ DELIBERATELY AN ENVIRONMENT VALUE RATHER THAN A COMPILED CONSTANT. The
 * whole point is that raising the floor must not require shipping a CLI — the
 * clients this is aimed at are the ones that do not update. A constant in this
 * repository would mean the only way to start warning a stale install is to
 * publish something that stale install will never fetch.
 *
 * Unset means NO floor, and no floor means silence: a deployment that has not
 * decided on one does not get to nag every caller by default.
 */
export const CLIENT_VERSION_FLOOR_ENV = 'MOTIR_CLI_VERSION_FLOOR';

export function clientVersionFloor(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[CLIENT_VERSION_FLOOR_ENV]?.trim();
  return raw ? raw : null;
}

/**
 * Compare two dotted numeric versions. Prerelease/build metadata is truncated
 * rather than ordered — this decides whether to attach a sentence, and the
 * ordering of `1.2.3-rc.1` against `1.2.3` is not worth a dependency here.
 */
export function compareClientVersions(a: string, b: string): number {
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

/** Header values must stay single-line ASCII, whatever a client sent us. */
const REPORTABLE = /^[A-Za-z0-9.+-]{1,64}$/;

/**
 * The verdict: a warning sentence, or `null` for silence.
 *
 * ⚠️ AN ABSENT VERSION WARNS, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 * Every client already in the wild reports nothing — including the 0.1.0 install
 * this bug was filed from — so treating absence as "probably fine" would make
 * this mechanism reach exactly the population it was built for and say nothing
 * to them. Absence is not ambiguous in the direction that matters: a caller that
 * does not report a version cannot be a CLI newer than the one that started
 * reporting.
 *
 * The cost is a header on responses to callers that are not the CLI at all — a
 * script, a `curl`, the documented examples. It is inert: nothing reads it,
 * nothing fails on it, and it is stamped only when the deployment has actually
 * declared a floor.
 */
export function judgeClientVersion(reported: string | null, floor: string | null): string | null {
  if (!floor) return null;

  if (reported === null || reported.trim() === '') {
    return `This client did not report a version; Motir expects @motir/cli ${floor} or newer. Upgrade with: npm install -g @motir/cli@latest`;
  }

  const seen = reported.trim();
  if (!REPORTABLE.test(seen)) {
    // Unparseable is treated as unreported rather than echoed: reflecting an
    // arbitrary request header into a response header is how a header-injection
    // bug is written.
    return `This client reported an unreadable version; Motir expects @motir/cli ${floor} or newer. Upgrade with: npm install -g @motir/cli@latest`;
  }

  if (compareClientVersions(seen, floor) >= 0) return null;

  return `@motir/cli ${seen} is below the ${floor} this server expects. Upgrade with: npm install -g @motir/cli@latest`;
}

/** The whole read, for the one caller in `withV1Route`. */
export function clientVersionWarning(
  req: { headers: { get: (name: string) => string | null } },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return judgeClientVersion(req.headers.get(CLIENT_VERSION_HEADER), clientVersionFloor(env));
}

/**
 * Stamp the verdict onto the response headers, if there is one.
 *
 * ⚠️ THE CONDITIONAL LIVES HERE, NOT AT THE CALL SITE. `withV1Route` is held at
 * 90% branches as part of the v1 envelope, and its callers never set a floor —
 * so an `if` in the wrapper would add an arm that only a route test configuring
 * the environment could reach, and the gate would fail on un-driven code in the
 * envelope rather than on anything about this feature. Here the same arm is
 * driven directly, by a unit test with no database.
 */
export function stampClientVersionWarning(
  headers: Headers,
  req: { headers: { get: (name: string) => string | null } },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const warning = clientVersionWarning(req, env);
  if (warning) headers.set(CLIENT_WARNING_HEADER, warning);
}
