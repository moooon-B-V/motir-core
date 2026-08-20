import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// THE PULL-REQUEST NUMBER-BLOCK GUARD (Bug MOTIR-3248).
//
// Pull-request numbers are a SHARED NAMESPACE across every E2E spec that
// delivers a signed `pull_request` webhook, and until this guard nothing
// enforced it. `github_pull_request` is `@@unique([repoId, number])`
// (prisma/schema.prisma) and `repoId` is the mirrored `github_repo` ROW — which
// two specs SHARE, because `seedGithubInstallation` seeds the fixed provider
// installation `99000001` and `github_installation.installation_id` is
// `@unique`: the second spec's seed UPSERTS the same installation and the same
// repo row, inheriting the first spec's pull-request rows along with it. A
// per-spec tenant does NOT isolate them.
//
// ── WHY THIS FAILS AT A DISTANCE, WHICH IS THE WHOLE REASON IT NEEDS A GUARD ─
//
// The lane runs many spec FILES against ONE database, and which files share a
// database is DERIVED, not written down:
//
//   * `playwright.acceptance.config.ts` — one database per shard, and
//     `.github/workflows/acceptance-video.yml` fans out `--shard=i/N` where N is
//     the number of acceptance specs the pull request touches. `--shard`
//     partitions in discovery order, so ADDING ANY SPEC FILE MOVES THE
//     PARTITION.
//   * `playwright.config.ts` — the bulk legs are bin-packed by measured cost
//     (`tests/e2e/shard-plan.ts`), so adding a spec re-packs the legs.
//
// Two specs with a colliding number therefore pass for as long as the partition
// happens to keep them apart, and go red the day somebody adds an UNRELATED
// file. The failure surfaces in a spec that author never opened, it reads
// exactly like a flake, and it is not one: MOTIR-3001 added
// `acceptance-scoped-run.spec.ts`, the partition moved, and
// `acceptance-repository-reference.spec.ts` (then on 6101/6102, the lifecycle
// spec's block) started resolving the lifecycle spec's change-request row —
// `expect(locator).toBeVisible() failed … 'Implemented'`, twice, on the same
// shard, on a spec the story had not touched.
//
// ── THE CONVENTION, WHICH ALREADY EXISTED ───────────────────────────────────
//
// Every spec owns a thousand-block: `github.spec.ts` 4xxx,
// `repository-set.spec.ts` 5xxx, `acceptance-implemented-lifecycle` 6xxx,
// `acceptance-scoped-run` 7xxx, `acceptance-repository-reference` 8xxx. Real,
// visible, and enforced by nothing until now.
//
// ── THE POPULATION THIS WAS WRITTEN AGAINST, MEASURED ───────────────────────
//
// On `origin/main` at b820c979: 5 participating specs, 23 number sites, 8
// distinct numbers, 0 collisions. Stated as a measurement so a later reader can
// tell what was counted from what was assumed (`notes.html` #317).
//
// ── THE BLIND SPOT, AND WHY IT IS A FAILURE RATHER THAN A PASS ──────────────
//
// The extractor keys on the KEY NAMES a number travels under, and a name
// whitelist is blind to exactly the site somebody chose a different name for
// (`notes.html` #231: a permission guard whose gate pattern was a whitelist
// could not see the three gates anyone had thought hard enough about to name).
// A silent zero would then read as a clean namespace.
//
// So the guard is written on ABSENCE, not on presence: a spec that PARTICIPATES
// in the namespace — it reaches `pullRequestPayload` / `checkSuitePayload` — and
// yields NO number is a FAILURE naming the file, because the guard cannot see
// its numbers and must not report a sweep it did not perform. (The same shape
// MOTIR-3227 had to be fixed into a scan that answered `0 rows` and `✓`.)

// ── THE resetDatabase() QUESTION, ANSWERED (the second half of MOTIR-3248) ──
//
// Two of the colliding specs called `resetDatabase()` nowhere, and it was not
// written down whether that was a decision or an omission. It was an omission:
// both now reset, and each says why at the call. The cascade the remedy depends
// on — github_pull_request → github_repo → github_installation → workspace, three
// hops from the truncated root — is MEASURED in `tests/db-reset-cascade.test.ts`
// rather than read off the schema. It is safe to reset there because the
// acceptance lane is `workers: 1, fullyParallel: false` and each of those files
// holds exactly one `test()`, so a reset at the top of the body races nothing
// and destroys no shared setup.
//
// A THIRD acceptance spec calls it nowhere — `acceptance-run-findings.spec.ts` —
// and is deliberately LEFT that way, because it is not in this namespace at all:
// it delivers no pull-request webhook, and its isolation is a per-run unique
// email whose tenant nothing else writes into. Said here rather than left
// silent, because an absent reset and a considered absence look identical.

const LANE_DIR = path.join(__dirname, 'e2e');

/** A spec takes part in the shared namespace exactly when it reaches the webhook
 *  payload builders. Read from the FILE, never from a registered list, so a spec
 *  added tomorrow is covered without editing this guard. */
const PARTICIPATION = /\b(?:pullRequestPayload|checkSuitePayload)\b/;

/** The keys a pull-request number travels under. Deliberately matched ANYWHERE
 *  in a participating spec rather than only inside a `pullRequestPayload(` call:
 *  specs wrap the builder in a local `deliver()` helper and pass the number
 *  through their own object literal, which a call-site scan would miss. */
const NUMBER_KEY = /\b(?:number|prNumber|pull_number|pullRequestNumber)\s*:\s*(\d+)/g;

export interface SpecNumbers {
  /** The spec's path relative to `tests/e2e`, e.g. `github.spec.ts`. */
  file: string;
  /** Every distinct pull-request number the spec delivers, ascending. */
  numbers: number[];
}

/** Drop comments so a number that is only DISCUSSED — the header block of this
 *  very file names 6101 and 8101 — is never counted as a delivery. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `*.spec.ts` under `tests/e2e` that takes part in the pull-request
 *  namespace, with the numbers it delivers. Enumerated from the FILESYSTEM. */
export function collectSpecNumbers(dir: string = LANE_DIR): SpecNumbers[] {
  const out: SpecNumbers[] = [];
  const walk = (current: string, prefix: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
        continue;
      }
      if (!entry.name.endsWith('.spec.ts')) continue;
      const source = fs.readFileSync(path.join(current, entry.name), 'utf8');
      if (!PARTICIPATION.test(source)) continue;
      const body = stripComments(source);
      const numbers = new Set<number>();
      for (const match of body.matchAll(NUMBER_KEY)) numbers.add(Number(match[1]));
      out.push({ file: rel, numbers: [...numbers].sort((a, b) => a - b) });
    }
  };
  walk(dir, '');
  return out;
}

export interface BlockVerdict {
  ok: boolean;
  /** The full failure text; empty when ok. */
  message: string;
}

/** The lowest unused thousand-block, so the failure message can say what to take
 *  rather than leaving the reader to work it out from the table. */
export function nextFreeBlock(specs: readonly SpecNumbers[]): number {
  const taken = new Set(specs.flatMap((s) => s.numbers).map((n) => Math.floor(n / 1000)));
  let block = 4;
  while (taken.has(block)) block += 1;
  return block;
}

const WHY = [
  'WHY THIS MATTERS, and why it is not order-dependence you can see by reading:',
  '',
  '  `github_pull_request` is @@unique([repoId, number]) and every spec seeds the',
  '  SAME mirrored repo row (`seedGithubInstallation` uses one fixed provider',
  '  installation, whose `installation_id` is @unique, so a second seed upserts',
  '  the first spec’s row). The acceptance lane then runs many spec FILES against',
  '  ONE database — playwright.acceptance.config.ts, one database per shard — and',
  '  WHICH files share it is derived: acceptance-video.yml fans out `--shard=i/N`',
  '  over the touched specs, and `--shard` partitions in discovery order, so THE',
  '  SHARD PARTITION CHANGES WHENEVER A SPEC FILE IS ADDED. (The main lane is the',
  '  same hazard by a different mechanism: tests/e2e/shard-plan.ts bin-packs the',
  '  bulk legs by measured cost, and a new spec re-packs them.)',
  '',
  '  So two specs sharing a number pass until an UNRELATED file joins the lane,',
  '  and then the second spec’s `opened` delivery resolves to the FIRST spec’s',
  '  change request and its card never moves. It reads as a flake in a file the',
  '  author never opened. It is not one. (MOTIR-3248, found via MOTIR-3001.)',
];

/** Judge the namespace. Pure, so the fixtures below can drive it directly. */
export function judgeNumberBlocks(specs: readonly SpecNumbers[]): BlockVerdict {
  const owners = new Map<number, string[]>();
  for (const spec of specs) {
    for (const n of spec.numbers) owners.set(n, [...(owners.get(n) ?? []), spec.file]);
  }
  const collisions = [...owners.entries()]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => a - b);
  const unreadable = specs.filter((s) => s.numbers.length === 0);

  if (collisions.length === 0 && unreadable.length === 0) return { ok: true, message: '' };

  const lines: string[] = [];
  if (collisions.length > 0) {
    lines.push(
      `${collisions.length} pull-request number(s) are used by MORE THAN ONE spec file:`,
      '',
      ...collisions.map(
        ([n, files]) => `  · ${n}  ←  ${files.map((f) => `tests/e2e/${f}`).join('  AND  ')}`,
      ),
      '',
      'Every spec owns a THOUSAND-BLOCK of its own. Give one of the colliding files',
      `a free block — the lowest unused one is ${nextFreeBlock(specs)}xxx — and say so in a`,
      'comment at its first use, the way tests/e2e/acceptance-repository-reference.spec.ts',
      'does. Do NOT reuse a neighbour’s block and rely on the two landing in',
      'different shards: that is the arrangement this guard exists to end.',
      '',
      ...WHY,
    );
  }
  if (unreadable.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${unreadable.length} spec(s) deliver pull-request webhooks but expose NO number this`,
      'guard can read, so their block could not be checked at all:',
      '',
      ...unreadable.map((s) => `  · tests/e2e/${s.file}  →  0 numbers found`),
      '',
      'This is a FAILURE and not a pass: a sweep that read nothing is a broken',
      'instrument, not a clean namespace. The extractor keys on the property names',
      `a number travels under (${'number'} / prNumber / pull_number / pullRequestNumber).`,
      'Either pass the number under one of those names, or widen NUMBER_KEY in',
      'tests/e2e-pull-request-number-blocks.test.ts — never leave it unreadable.',
    );
  }
  return { ok: false, message: lines.join('\n') };
}

describe('pull-request numbers are a shared namespace, one thousand-block per spec (MOTIR-3248)', () => {
  it('no two spec files use the same pull-request number', () => {
    const specs = collectSpecNumbers();
    // The population itself is asserted: a lane that suddenly participates in
    // nothing is a broken collector, not an empty namespace.
    expect(
      specs.length,
      'no spec reaches pullRequestPayload/checkSuitePayload — the collector is broken, not the lane empty',
    ).toBeGreaterThan(0);
    const verdict = judgeNumberBlocks(specs);
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

// ── THE GUARD CAN FAIL ──────────────────────────────────────────────────────
//
// A guard nobody has watched fail is a guard nobody knows works, and this one is
// written for a runtime it does not execute in (`notes.html` #343). So the
// fixtures drive the REAL collector over a real directory, not only the judge.

describe('the guard itself', () => {
  const fixtureDir = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-blocks-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };

  const delivery = (n: number): string =>
    `await postSignedWebhook(page.request, 'pull_request', pullRequestPayload({ action: 'opened', number: ${n} }));`;

  it('goes RED when two FILES share a number, naming both files and the number', () => {
    const dir = fixtureDir({
      'alpha.spec.ts': delivery(6101),
      'beta.spec.ts': delivery(6101),
    });

    const verdict = judgeNumberBlocks(collectSpecNumbers(dir));

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('6101');
    expect(verdict.message).toContain('tests/e2e/alpha.spec.ts');
    expect(verdict.message).toContain('tests/e2e/beta.spec.ts');
    // The reason, stated at the failure — the thing a reader six months from now
    // has no other way to learn.
    expect(verdict.message).toContain('ONE database');
    expect(verdict.message).toContain('SHARD PARTITION CHANGES WHENEVER A SPEC FILE IS ADDED');
    // And what to do about it.
    expect(verdict.message).toContain('THOUSAND-BLOCK');
  });

  it('PASSES the same two specs once one takes a free block', () => {
    const dir = fixtureDir({
      'alpha.spec.ts': delivery(6101),
      'beta.spec.ts': delivery(9101),
    });
    expect(judgeNumberBlocks(collectSpecNumbers(dir)).ok).toBe(true);
  });

  it('lets ONE file reuse its OWN number across deliveries — that is not a collision', () => {
    const dir = fixtureDir({
      'alpha.spec.ts': [
        delivery(6101),
        delivery(6101),
        'checkSuitePayload({ prNumber: 6101 })',
      ].join('\n'),
    });
    expect(judgeNumberBlocks(collectSpecNumbers(dir)).ok).toBe(true);
  });

  it('reads the numbers from the SPECS, so a file added tomorrow needs no edit here', () => {
    const dir = fixtureDir({
      'alpha.spec.ts': delivery(4100),
      // Not a spec file.
      'helper.ts': delivery(4100),
      // A spec that never touches the webhook seam: not in the namespace at all,
      // so its unrelated `number:` key is none of this guard's business.
      'unrelated.spec.ts': "await page.getByRole('row', { number: 4100 }).click();",
    });

    expect(collectSpecNumbers(dir)).toEqual([{ file: 'alpha.spec.ts', numbers: [4100] }]);
  });

  it('does NOT count a number that is only mentioned in a comment', () => {
    const dir = fixtureDir({
      'alpha.spec.ts': ['// 8101 is the lifecycle spec’s. Do not reuse it.', delivery(4100)].join(
        '\n',
      ),
      'beta.spec.ts': ['/* number: 4100 — what alpha uses */', delivery(8101)].join('\n'),
    });
    expect(collectSpecNumbers(dir)).toEqual([
      { file: 'alpha.spec.ts', numbers: [4100] },
      { file: 'beta.spec.ts', numbers: [8101] },
    ]);
  });

  it('FAILS a participating spec whose numbers it cannot read — a zero is not a clean sweep', () => {
    const dir = fixtureDir({
      // Delivers, but hands the number through a name the extractor does not know.
      'opaque.spec.ts': "pullRequestPayload({ action: 'opened', pr: 6101 });",
    });

    const verdict = judgeNumberBlocks(collectSpecNumbers(dir));

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('tests/e2e/opaque.spec.ts');
    expect(verdict.message).toContain('0 numbers found');
    expect(verdict.message).toContain('broken');
    // Not conflated with the collision case.
    expect(verdict.message).not.toContain('MORE THAN ONE spec file');
  });

  it('names the lowest FREE thousand-block, skipping every one already taken', () => {
    expect(nextFreeBlock([{ file: 'a.spec.ts', numbers: [4100] }])).toBe(5);
    expect(
      nextFreeBlock([
        { file: 'a.spec.ts', numbers: [4100, 4101] },
        { file: 'b.spec.ts', numbers: [5101] },
        { file: 'c.spec.ts', numbers: [6101, 6102] },
        { file: 'd.spec.ts', numbers: [7101] },
        { file: 'e.spec.ts', numbers: [8101, 8102] },
      ]),
    ).toBe(9);
  });
});
