import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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

const LANE_DIR = path.join(__dirname, 'e2e');
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

interface StatusSource {
  baseUrl: string;
  token: string;
}

/** The credential + origin the guard reads the product with, or null when this
 *  environment has none (a laptop, a fork's CI). */
export function resolveStatusSource(env: Record<string, string | undefined>): StatusSource | null {
  const baseUrl = env['MOTIR_GUARD_BASE_URL'] ?? env['MOTIR_BASE_URL'] ?? '';
  const token = env['MOTIR_GUARD_TOKEN'] ?? env['MOTIR_UPLOAD_TOKEN'] ?? '';
  return baseUrl && token ? { baseUrl: baseUrl.replace(/\/$/, ''), token } : null;
}

/** The subset of `storyKeys` whose CURRENT receipt is `approved`. A story the
 *  read cannot resolve is treated as NOT approved — the guard must never fail a
 *  spec on the strength of a 404 or a flaky hop. */
export async function fetchApprovedStories(
  storyKeys: readonly string[],
  source: StatusSource,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const approved = new Set<string>();
  for (const key of storyKeys) {
    try {
      const res = await fetchImpl(`${source.baseUrl}/api/work-items/${key}/acceptance-evidence`, {
        headers: { authorization: `Bearer ${source.token}` },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { evidence?: { status?: string } | null };
      if (body?.evidence?.status === 'approved') approved.add(key);
    } catch {
      // Unreachable for this key: not evidence of anything. Skip it.
    }
  }
  return approved;
}

describe('the acceptance lane holds only IN-FLIGHT stories (MOTIR-2770)', () => {
  it('no spec in the lane has an approved receipt, and every one declares its story', async () => {
    const members = collectLaneMembers();
    if (members.length === 0) {
      // A legitimate and, after a triage, common state: no story is in review.
      // Not a skip — an empty lane genuinely satisfies the rule.
      expect(members).toEqual([]);
      return;
    }

    const source = resolveStatusSource(process.env);
    if (!source) {
      // The stated degradation. Never a silent pass: the reason is printed, and
      // the undeclared-story half of the rule is checked anyway because it needs
      // no credential at all.
      const verdict = judgeLane(members, new Set());
      expect(
        verdict.ok,
        `${verdict.message}\n\n(The approved-receipt half of this guard was SKIPPED: no ` +
          'MOTIR_GUARD_TOKEN/MOTIR_UPLOAD_TOKEN + MOTIR_BASE_URL in this environment, so the ' +
          'product could not be asked which receipts are approved. It runs in CI.)',
      ).toBe(true);
      return;
    }

    const keys = members.map((m) => m.storyKey).filter((k): k is string => k !== null);
    const verdict = judgeLane(members, await fetchApprovedStories(keys, source));
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

// ── THE GUARD CAN FAIL ──────────────────────────────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works. These drive the
// same judgement the check above runs, on fixtures.

describe('the guard itself', () => {
  it('FAILS a spec whose story is already approved, naming it and both remedies', () => {
    const verdict = judgeLane(
      [
        { file: 'acceptance-cadence.spec.ts', storyKey: 'MOTIR-813' },
        { file: 'acceptance-in-flight.spec.ts', storyKey: 'MOTIR-9999' },
      ],
      new Set(['MOTIR-813']),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('tests/e2e/acceptance-cadence.spec.ts');
    expect(verdict.message).toContain('MOTIR-813');
    expect(verdict.message).toContain('PROMOTE');
    expect(verdict.message).toContain('RETIRE');
    // The one instruction that reverses the original incident's reflex.
    expect(verdict.message).toContain('Do NOT edit the spec');
    // …and it does NOT drag in the spec whose story is still in flight.
    expect(verdict.message).not.toContain('acceptance-in-flight.spec.ts');
  });

  it('PASSES a spec whose story is in review — the lane’s legitimate member', () => {
    expect(judgeLane([{ file: 'acceptance-x.spec.ts', storyKey: 'MOTIR-1' }], new Set()).ok).toBe(
      true,
    );
  });

  it('fails a spec with NO acceptanceStory() DISTINCTLY — a different defect', () => {
    const verdict = judgeLane([{ file: 'acceptance-orphan.spec.ts', storyKey: null }], new Set());
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('declare NO story');
    expect(verdict.message).toContain('acceptance-orphan.spec.ts');
    // Not conflated with the discharged case.
    expect(verdict.message).not.toContain('APPROVED receipt');
  });

  it('reads the declaration from CODE, not from a header comment', () => {
    // `acceptance-shell-context-path.spec.ts` named its story only in a comment
    // and published against the uploader's PR fallback for its whole life.
    expect(parseDeclaredStory("// Story MOTIR-2554 — the shell's context path.")).toBeNull();
    expect(parseDeclaredStory("/* acceptanceStory('MOTIR-2554') */")).toBeNull();
    expect(parseDeclaredStory("  acceptanceStory('MOTIR-2554');")).toBe('MOTIR-2554');
    expect(parseDeclaredStory('  acceptanceStory( "MOTIR-2554" );')).toBe('MOTIR-2554');
  });

  it('enumerates from the FILESYSTEM — a spec added tomorrow needs no edit here', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-'));
    fs.writeFileSync(path.join(dir, 'acceptance-new.spec.ts'), "acceptanceStory('MOTIR-42');");
    fs.writeFileSync(path.join(dir, 'ordinary.spec.ts'), "acceptanceStory('MOTIR-43');");
    fs.writeFileSync(path.join(dir, 'acceptance-helper.ts'), "acceptanceStory('MOTIR-44');");

    expect(collectLaneMembers(dir)).toEqual([
      { file: 'acceptance-new.spec.ts', storyKey: 'MOTIR-42' },
    ]);
  });

  it('treats a story the product cannot resolve as NOT approved', async () => {
    const approved = await fetchApprovedStories(
      ['MOTIR-1', 'MOTIR-2', 'MOTIR-3'],
      { baseUrl: 'https://motir.test', token: 't' },
      (async (url: string) => {
        if (url.includes('MOTIR-1')) return { ok: false, status: 404 };
        if (url.includes('MOTIR-2')) throw new Error('ECONNRESET');
        return { ok: true, json: async () => ({ evidence: { status: 'approved' } }) };
      }) as unknown as typeof fetch,
    );
    // Only the story the product actually answered `approved` for.
    expect([...approved]).toEqual(['MOTIR-3']);
  });

  it('needs BOTH an origin and a token before it will claim to know anything', () => {
    expect(resolveStatusSource({})).toBeNull();
    expect(resolveStatusSource({ MOTIR_BASE_URL: 'https://x' })).toBeNull();
    expect(resolveStatusSource({ MOTIR_UPLOAD_TOKEN: 't' })).toBeNull();
    expect(resolveStatusSource({ MOTIR_BASE_URL: 'https://x/', MOTIR_UPLOAD_TOKEN: 't' })).toEqual({
      baseUrl: 'https://x',
      token: 't',
    });
  });
});
