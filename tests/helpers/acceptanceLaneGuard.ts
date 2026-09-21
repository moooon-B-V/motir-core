import fs from 'node:fs';
import path from 'node:path';

// THE LANE-MEMBERSHIP GUARD (Story MOTIR-2765 · Subtask MOTIR-2770).
//
// ⚠️ IT READS THE SPEC FILES AND NOTHING ELSE (MOTIR-5872, retired by MOTIR-5874).
// It used to ask the PRODUCT whether each story's acceptance receipt was
// `approved` and evict the spec when it was. That tied a TEST's lane to whether a
// RECORD had been signed, and a lane is a PLACEMENT decided once when the spec is
// written (`docs/decisions/acceptance-receipt-lifecycle.md` AMENDMENT 1). The
// status read, its credential (the MOTIR-4162 read-only PAT), the binding
// declaration that forced CI to carry it (MOTIR-4093) and the GET route it read
// (MOTIR-4144) are all gone. What stays is the half that is true of the file
// itself: a spec that declares no story can never publish a receipt.
//
// ── WHAT A DEVELOPER SEES ───────────────────────────────────────────────────
//
// This will fire months from now, on someone who has never read this story, in
// the middle of an unrelated PR. So the message names the spec and the legal
// remedies.

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

/**
 * Judge the lane. Pure, so the "can it fail" fixtures can drive it without a
 * network.
 *
 * ⚠️ IT NO LONGER ASKS WHETHER A STORY'S RECEIPT IS APPROVED (MOTIR-5872). That
 * half evicted a spec the moment its receipt was signed, which tied a TEST's lane
 * to whether a RECORD had been signed: a story whose merge was ejected came back
 * to be reworked with its spec already demanded out of the lane, and because this
 * guard runs in the main suite, every pull request in the repository went red
 * with it. A spec's lane is a PLACEMENT, decided once when the spec is written
 * (`docs/decisions/acceptance-receipt-lifecycle.md` AMENDMENT 1). What stays is
 * the half that is true of the file itself: a spec that declares no story can
 * never publish a receipt, so it is in this lane for no reason the lane serves.
 */
export function judgeLane(members: LaneMember[]): LaneVerdict {
  const undeclared = members.filter((m) => !m.storyKey);
  if (undeclared.length === 0) return { ok: true, message: '' };

  const lines: string[] = [
    `${undeclared.length} acceptance spec(s) declare NO story, so they can never publish a`,
    'receipt — they are in this lane for no reason it can serve:',
    '',
    ...undeclared.map((m) => `  · tests/e2e/${m.file}  →  no acceptanceStory() call`),
    '',
    'Either add `acceptanceStory(‘MOTIR-<n>’)` to the recorded happy path, or move the',
    'spec to a regression lane: rename it out of the `acceptance` prefix and swap its',
    'import to _helpers/promoted-regression (a cloud-gated subject goes to',
    '`cloud-<name>.spec.ts`, not the main lane). A story key in a header COMMENT does',
    'not count: the publisher reads the fixture, not the prose.',
  ];
  return { ok: false, message: lines.join('\n') };
}
