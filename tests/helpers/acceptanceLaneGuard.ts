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
 * The credential + origin the guard reads the product with, or null when this
 * environment has none (a laptop, a fork's CI).
 *
 * `MOTIR_GUARD_AUTH=github-oidc` opts into the keyless arm; anything else (and
 * the absence of it) is the bearer-PAT arm, which is what CI is expected to
 * wire — the read asks only for `project:browse`
 * (`ACCEPTANCE_STATUS_READ_PERMISSION`), so the credential this guard needs is a
 * read-only PAT and nothing more. MOTIR-4093 owns putting it in the lane.
 */
export function resolveStatusSource(env: Record<string, string | undefined>): StatusSource | null {
  const baseUrl = env['MOTIR_GUARD_BASE_URL'] ?? env['MOTIR_BASE_URL'] ?? '';
  const token = env['MOTIR_GUARD_TOKEN'] ?? env['MOTIR_UPLOAD_TOKEN'] ?? '';
  const authMode = env['MOTIR_GUARD_AUTH'] === 'github-oidc' ? 'github-oidc' : 'bearer';
  return baseUrl && token ? { baseUrl: baseUrl.replace(/\/$/, ''), token, authMode } : null;
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
