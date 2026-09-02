import fs from 'node:fs';
import path from 'node:path';

// THE LANE-MEMBERSHIP GUARD (Story MOTIR-2765 · Subtask MOTIR-2770).
//
// An acceptance spec exists to record ONE receipt. Once that receipt is
// `approved` the spec has discharged its purpose and must leave the lane — by
// PROMOTION into a lane that runs on every PR, or by RETIREMENT
// (`docs/decisions/acceptance-receipt-lifecycle.md` §3). Nothing enforced that,
// so nothing happened: the lane accumulated 26 specs, none of which ever left,
// and this story exists because that convention decayed.
//
// This is the layer that FORCES the decision. The service refusal (MOTIR-2764)
// makes the data undestroyable and the publisher skip (MOTIR-2768) makes the
// refusal legible — but neither can ask anyone to triage a spec. Only a red
// check reaches a developer at the one moment they can act.
//
// ── WHERE THE STATUS COMES FROM, AND WHY ────────────────────────────────────
//
// DECIDED: query the PRODUCT; skip cleanly when it is unreachable.
//
// REJECTED: a committed manifest of the lane's specs and their stories'
// dispositions. It runs everywhere with no credential and it is greppable in a
// diff — and it is a repo-side COPY of a fact the product owns, which is the
// exact shape of the defect this whole story is fixing. Enforcing a rule about
// drift by introducing a second source of drift is a bad trade, and the copy
// would be wrong in the one direction that matters: a story approved after the
// manifest was written reads as still-in-flight forever.
//
// The cost of that choice is honest and stated here: with no credential the
// guard SKIPS, so it fires in CI and not on a laptop. It is never silent about
// which of the two it did.
//
// ⚠️ AND THAT SENTENCE WAS FALSE FOR ELEVEN WEEKS (MOTIR-4093). No job set
// either variable, so the guard took its degraded branch on every run it ever
// had — printing "It runs in CI" while measuring nothing. The degradation is
// still the design; what it now needs is an environment that DECLARES it must
// bind (`MOTIR_GUARD_REQUIRED`), and `requireStatusSource` FAILS there instead
// of degrading. `tests/ci-acceptance-lane-credential.test.ts` is what keeps the
// declaration attached to the job that runs this guard.
//
// ── WHAT A DEVELOPER SEES ───────────────────────────────────────────────────
//
// This will fire months from now, on someone who has never read this story, in
// the middle of an unrelated PR — the same situation that produced the original
// incident, where a developer inherited a red they had no context for and fixed
// it the wrong way because the wrong way was the obvious one. So the message
// names the spec, the story, and BOTH legal remedies with the rule for choosing.

const LANE_DIR = path.join(__dirname, '..', 'e2e');
const ACCEPTANCE_PREFIX = 'acceptance';

export interface LaneMember {
  /** The spec's basename, e.g. `acceptance-cadence.spec.ts`. */
  file: string;
  /** The story from its `acceptanceStory('MOTIR-<n>')` call, or null when absent. */
  storyKey: string | null;
}

/** Every spec the acceptance lane's `testMatch` glob selects, with its declared
 *  story. Read from the FILESYSTEM, never a hard-coded list, so a spec added
 *  tomorrow is covered without editing this guard. */
export function collectLaneMembers(dir: string = LANE_DIR): LaneMember[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(ACCEPTANCE_PREFIX) && f.endsWith('.spec.ts'))
    .sort()
    .map((file) => ({
      file,
      storyKey: parseDeclaredStory(fs.readFileSync(path.join(dir, file), 'utf8')),
    }));
}

/** The `acceptanceStory('MOTIR-123')` argument, or null. Deliberately tolerant
 *  of either quote style and of whitespace, and deliberately NOT tolerant of a
 *  story named only in a comment: a header comment does not publish a receipt. */
export function parseDeclaredStory(source: string): string | null {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /acceptanceStory\(\s*['"]([A-Z][A-Z0-9]*-\d+)['"]\s*\)/.exec(withoutComments)?.[1] ?? null;
}

export interface LaneVerdict {
  ok: boolean;
  /** The full failure text; empty when ok. */
  message: string;
}

/** Judge the lane against the approved set. Pure, so the "can it fail" fixture
 *  below can drive it without a network. */
export function judgeLane(members: LaneMember[], approved: ReadonlySet<string>): LaneVerdict {
  const discharged = members.filter((m) => m.storyKey && approved.has(m.storyKey));
  const undeclared = members.filter((m) => !m.storyKey);
  if (discharged.length === 0 && undeclared.length === 0) return { ok: true, message: '' };

  const lines: string[] = [];
  if (discharged.length > 0) {
    lines.push(
      `${discharged.length} acceptance spec(s) have already produced an APPROVED receipt, so they`,
      'have discharged their purpose and must leave the acceptance lane:',
      '',
      ...discharged.map((m) => `  · tests/e2e/${m.file}  →  ${m.storyKey} (accepted)`),
      '',
      'Pick ONE of the two legal remedies for each, once:',
      '',
      '  PROMOTE  the flow is worth protecting on EVERY PR. Rename it out of the',
      '           `acceptance` prefix, swap its import to _helpers/promoted-regression',
      '           (which no-ops the chaptering and pacing), and KEEP EVERY ASSERTION.',
      '           If its subject is cloud-gated — billing, motir-ai, code-health, the',
      '           GitHub provisioning seam — the destination is `cloud-<name>.spec.ts`',
      '           (playwright.cloud.config.ts), NOT the main lane, where those flags',
      '           are off and the assertion would pass for the wrong reason.',
      '  RETIRE   the receipt exists and the flow is covered elsewhere. Delete it, and',
      '           SAY WHERE the coverage now lives — a deletion that cannot name its',
      '           cover is a coverage regression wearing a cleanup’s clothes.',
      '',
      'Do NOT edit the spec’s assertions to match how the product behaves today.',
      'That is right for a regression test and backwards for a receipt: it edits',
      'history to agree with the present.',
      '',
      'Why: docs/decisions/acceptance-receipt-lifecycle.md §3.',
      'Precedent for both remedies: docs/acceptance-lane-triage.md.',
    );
  }
  if (undeclared.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${undeclared.length} acceptance spec(s) declare NO story, so they can never publish a`,
      'receipt — they are in this lane for no reason it can serve:',
      '',
      ...undeclared.map((m) => `  · tests/e2e/${m.file}  →  no acceptanceStory() call`),
      '',
      'Either add `acceptanceStory(‘MOTIR-<n>’)` to the recorded happy path, or move',
      'the spec to a regression lane per the remedies above. A story key in a header',
      'COMMENT does not count: the uploader reads the fixture, not the prose.',
    );
  }
  return { ok: false, message: lines.join('\n') };
}

export interface StatusSource {
  baseUrl: string;
  token: string;
  /** How `token` authenticates: an ordinary bearer PAT, or a GitHub Actions
   *  OIDC JWT, which the product only accepts behind the `x-motir-auth` marker
   *  (`lib/github/oidcAuth.ts`). DECLARED, never sniffed from the token's shape:
   *  a JWT and a PAT are both opaque strings to this file, and guessing wrong
   *  produces a 401 that looks exactly like a bad credential. */
  authMode: 'bearer' | 'github-oidc';
}

/**
 * ── THE NAMES, IN ONE PLACE (MOTIR-4093) ────────────────────────────────────
 *
 * The environment variables this guard reads, exported because they now have a
 * SECOND reader: `tests/ci-acceptance-lane-credential.test.ts` scans
 * `.github/workflows/**` for a job that runs this guard without setting them.
 * A workflow guard that hard-codes its own copy of these names is a guard that
 * keeps passing after a rename — the precise shape of the defect this card is
 * about, one level up.
 *
 * ⚠️ ORDER IS PRECEDENCE, and the guard-specific name comes FIRST for a reason
 * that is not cosmetic. `MOTIR_BASE_URL` is the APPLICATION's own origin
 * (`lib/baseUrl.ts` rung 1, whose header says "Nothing else may read the
 * variable directly"), so setting it in a job's `env:` re-points every emailed
 * link, Better-Auth `baseURL`, canonical and sitemap entry that the ~1360-file
 * Vitest lane resolves. `MOTIR_GUARD_BASE_URL` has exactly one reader — this
 * function — so a job that sets it cannot change what any other test sees. The
 * legacy names stay accepted so an environment that already exports them keeps
 * working; nothing in this repository sets them any more.
 */
export const GUARD_ORIGIN_VARS = ['MOTIR_GUARD_BASE_URL', 'MOTIR_BASE_URL'] as const;
/** The credential, same precedence rule. `MOTIR_UPLOAD_TOKEN` was the acceptance
 *  publisher's PAT fallback and is kept only as a legacy alias — MOTIR-4096
 *  retired its last writer, and it was never a configured secret here. */
export const GUARD_TOKEN_VARS = ['MOTIR_GUARD_TOKEN', 'MOTIR_UPLOAD_TOKEN'] as const;
/** Opt into the keyless arm. Anything but the exact value is the PAT arm. */
export const GUARD_AUTH_VAR = 'MOTIR_GUARD_AUTH';
/**
 * The environment's own declaration that it is SUPPOSED to bind — the
 * discriminator {@link requireStatusSource} turns a silent degradation into a
 * failure on.
 *
 * ⚠️ IT CANNOT BE `CI`, and that is the whole reason this variable exists. A
 * fork's pull request sets `CI` too and is given no secrets, so keying the
 * requirement on `CI` would red-light every fork PR — the one degradation this
 * guard's design is explicit about keeping. Only the workflow knows which of
 * its own runs are supposed to have a credential, so the workflow says it.
 */
export const GUARD_REQUIRED_VAR = 'MOTIR_GUARD_REQUIRED';

/** `a ?? b ?? ''` over a name list — an empty string SET beats a name unset,
 *  which is the existing behaviour and is what makes `${{ secrets.MISSING }}`
 *  (which expands to `''`) resolve to no source rather than to the next name. */
function firstDefined(env: Record<string, string | undefined>, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return value;
  }
  return '';
}

/**
 * The credential + origin the guard reads the product with, or null when this
 * environment has none (a laptop, a fork's CI).
 *
 * `MOTIR_GUARD_AUTH=github-oidc` opts into the keyless arm; anything else (and
 * the absence of it) is the bearer-PAT arm, which is what CI wires — the read
 * asks only for `project:browse` (`ACCEPTANCE_STATUS_READ_PERMISSION`), so the
 * credential this guard needs is a read-only PAT and nothing more. MOTIR-4162
 * minted it; MOTIR-4093 put it in the lane.
 *
 * ⚠️ A null here is NOT by itself a pass — see {@link requireStatusSource},
 * which is what callers use.
 */
export function resolveStatusSource(env: Record<string, string | undefined>): StatusSource | null {
  const baseUrl = firstDefined(env, GUARD_ORIGIN_VARS);
  const token = firstDefined(env, GUARD_TOKEN_VARS);
  const authMode = env[GUARD_AUTH_VAR] === 'github-oidc' ? 'github-oidc' : 'bearer';
  return baseUrl && token ? { baseUrl: baseUrl.replace(/\/$/, ''), token, authMode } : null;
}

/** Whether this environment DECLARES that it must bind. */
export function statusSourceRequired(env: Record<string, string | undefined>): boolean {
  return (env[GUARD_REQUIRED_VAR] ?? '').trim().toLowerCase() === 'true';
}

/**
 * The guard was told it must bind, and could not.
 *
 * ⚠️ THIS IS THE HATCH BEING SHUT, AND IT IS WORTH SAYING WHY A DEGRADATION
 * BRANCH NEEDED ONE. Skipping cleanly when there is no credential is correct
 * and stays: a laptop and a fork's pull request have no secrets, and a guard
 * that fails there is a guard somebody deletes. What was missing is the
 * assertion that the environment which is SUPPOSED to bind actually binds —
 * so for eleven weeks this guard printed "It runs in CI" and never did. No job
 * set either name, it took the degraded branch on every run it ever had, and
 * reported green (MOTIR-4093). An escape hatch needs a test that it is shut
 * where it counts, or the check is indistinguishable from one that works right
 * up until the day it matters.
 */
export class LaneGuardUnboundError extends Error {
  constructor() {
    super(
      `The acceptance-lane guard was told this environment MUST bind (${GUARD_REQUIRED_VAR}=true)\n` +
        'and could not resolve a status source, so it FAILS rather than degrading.\n\n' +
        "It needs BOTH, in the job's `env:`:\n" +
        `  ${GUARD_ORIGIN_VARS[0]}   the origin to ask, e.g. https://app.motir.co\n` +
        `  ${GUARD_TOKEN_VARS[0]}      a Motir PAT granted \`project:browse\` and nothing else —\n` +
        `                          the repository Actions secret of the same name (MOTIR-4162)\n\n` +
        'Which one is it?\n\n' +
        '  · the secret is missing or was renamed  →  `gh secret list --repo <owner>/<repo>`\n' +
        '  · the token was revoked                 →  MOTIR-4162 AC 3 is the curl that tells you\n' +
        `  · you are on a laptop                   →  leave ${GUARD_REQUIRED_VAR} unset; nothing is wrong\n` +
        `  · you are on a FORK's pull request      →  the workflow already leaves ${GUARD_REQUIRED_VAR}\n` +
        '                                             false there; if it did not, that is the bug\n\n' +
        'Do NOT "fix" this by deleting the requirement. The degradation is the design;\n' +
        'the declaration is what stops it from being the only branch that ever runs.',
    );
    this.name = 'LaneGuardUnboundError';
  }
}

/**
 * The status source, or null when this environment is ALLOWED to degrade.
 *
 * THROWS {@link LaneGuardUnboundError} when the environment declares it must
 * bind and no source resolves. Callers use this rather than
 * {@link resolveStatusSource} — a null from that function alone cannot tell a
 * laptop from a mis-wired CI job.
 */
export function requireStatusSource(env: Record<string, string | undefined>): StatusSource | null {
  const source = resolveStatusSource(env);
  if (source) return source;
  if (statusSourceRequired(env)) throw new LaneGuardUnboundError();
  return null;
}

/**
 * The product answered, and the answer was not one this guard can interpret —
 * a 404/405/401/403 from the READ PATH ITSELF rather than a fact about a story.
 *
 * ⚠️ THIS CLASS IS THE POINT OF MOTIR-4144, so it is worth saying why it is not
 * over-engineering. The guard's tolerance of an unresolvable read is correct and
 * stays: a flaky hop must never fail somebody's unrelated PR. What that
 * tolerance could not express is the difference between *the network wobbled*
 * and *there is no route here* — and for eleven weeks it absorbed the second as
 * though it were the first. `GET .../acceptance-evidence` did not exist, every
 * call was **405**, the approved set was empty on every run, and the check went
 * green for a structural reason no amount of credential-fixing could reach. A
 * fail-open branch written for one failure mode will silently swallow every
 * other one that arrives through it, so the modes have to be told apart at the
 * point where they are still distinguishable.
 */
export class LaneGuardReadError extends Error {
  constructor(
    readonly storyKey: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(
      `The lane guard could not read ${storyKey}'s acceptance receipt: the product answered ` +
        `HTTP ${status} for\n  GET ${url}\n\n` +
        "That is a defect in the GUARD'S OWN WIRING, not a fact about the story, so it is " +
        'reported instead of being read as "no approved receipt".\n\n' +
        '  405  the route is not deployed on this origin (the MOTIR-4144 defect itself)\n' +
        '  404  the key did not resolve for this credential — wrong workspace, or a spec\n' +
        '       declaring a story that does not exist. A story that exists and simply has\n' +
        '       no receipt yet answers 200 with `evidence: null`, so 404 never means that\n' +
        '  401  the credential is missing, expired or not the arm the origin expects\n' +
        '       (MOTIR_GUARD_AUTH=github-oidc sends the keyless marker; otherwise a PAT)\n' +
        '  403  the credential is valid but lacks `project:browse` on this project',
    );
    this.name = 'LaneGuardReadError';
  }
}

/**
 * The subset of `storyKeys` whose CURRENT receipt is `approved`.
 *
 * TWO failure modes, and keeping them apart is the whole contract:
 *
 *   · a TRANSPORT failure (`ECONNRESET`, a timeout, DNS) is tolerated exactly as
 *     before — the key is skipped and counts as not approved. The guard must
 *     never fail a spec on the strength of a flaky hop.
 *   · a ROUTE-LEVEL status the guard cannot interpret THROWS
 *     {@link LaneGuardReadError}. It is a defect in this guard's wiring, and a
 *     wiring defect that reports itself as "nothing is approved" is a check that
 *     measures nothing while looking green.
 *
 * A resolvable story ALWAYS answers 200 — `{ evidence: null }` when it has no
 * receipt yet — which is what makes every non-2xx unambiguous enough to throw on.
 */
export async function fetchApprovedStories(
  storyKeys: readonly string[],
  source: StatusSource,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const approved = new Set<string>();
  for (const key of storyKeys) {
    const url = `${source.baseUrl}/api/work-items/${key}/acceptance-evidence`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: authHeaders(source) });
    } catch {
      // Unreachable for this key: not evidence of anything. Skip it.
      continue;
    }
    if (!res.ok) throw new LaneGuardReadError(key, res.status, url);
    const body = (await res.json()) as { evidence?: { status?: string } | null };
    if (body?.evidence?.status === 'approved') approved.add(key);
  }
  return approved;
}

/** The auth headers for the guard's read — the keyless arm needs the marker the
 *  product opts into OIDC on, which the uploader has always sent and this guard
 *  never did (`scripts/upload-acceptance-video.mjs`'s `authHeadersFor`). */
function authHeaders(source: StatusSource): Record<string, string> {
  return source.authMode === 'github-oidc'
    ? { authorization: `Bearer ${source.token}`, 'x-motir-auth': 'github-oidc' }
    : { authorization: `Bearer ${source.token}` };
}
