import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  RATCHET_NAME,
  exposedRatchets,
  exposedSetRatchets,
  guardMessages,
  scanRatchets,
  scanSetRatchets,
  type Ratchet,
  type SetRatchet,
} from './ratchetScan';
import { remeasureFirst } from './remeasureFirst';

// The META-GUARD (MOTIR-2941) — a ratchet over the ratchets.
//
// ── The class ──────────────────────────────────────────────────────────────
// A ratchet constant is a measurement of a POPULATION taken at one commit, and
// that commit is a branch tip. Siblings merge between the measurement and the
// merge; if any of their work touches the counted population, the constant
// describes a tree that no longer exists. The guard then fires CORRECTLY — the
// count really did move — while its message accuses whoever is standing there
// of writing the thing it objects to. Nobody was wrong. The composition was, and
// no individual author was in a position to see it.
//
// MOTIR-2939 is the first instance, in full: `UNCONVERTED_E2E_CEILING` shipped
// as 454 measured at `bd0584c5`; `22316a62` merged seven minutes ahead of it
// adding three statements; `05ac5337` — the ratchet's own merge commit — was red
// on arrival, and every open PR inherited it, because CI checks out the branch
// merged with `main`. The expensive half was not the fix. It was proving that
// nobody had done what the message said they had.
//
// ── What this file enforces, and what it deliberately does not ─────────────
// It does NOT make ratchets merge-order-proof. That was decided against, with
// the two rejected alternatives and their prices, in
// `docs/decisions/ratchet-constant-staleness.md`. What it enforces is the half
// that pays the human cost: every EXPOSED ratchet must open its failure message
// by telling the reader to re-measure at `origin/main` before hunting a culprit.
//
// ── Why the enumeration is derived ─────────────────────────────────────────
// The card asked for every ratchet under `tests/rls/` enumerated with its value.
// A table in a markdown file would have satisfied that and been the wrong
// artifact for the card's OWN reason — it is a population measurement
// transcribed into the source tree, which is the thing that goes stale. So the
// enumeration is a scan, this guard is its consumer, and a ratchet added
// tomorrow is enrolled by being named, with no list to remember to update.

// ── MOTIR-5207: "enrolled by being named" was a narrower net than it read as ─
// The sentence above is the ADR's, and it was true of what the scanner could
// see: a NUMBER, under `tests/rls/`. MOTIR-5037's ratchet is a SET
// (`tests/helpers/pageRootedLocatorAllowList.json`) in another directory, so it
// was never enrolled, shipped with no preamble, and spent two merge-queue slots
// telling a runner that thirty-two locators were NEW when they had been on
// `main` for four hours.
//
// So enrolment now answers "which GUARD holds a baseline a sibling's merge can
// move?" in two derived shapes — a ratchet CONSTANT anywhere under `tests/`,
// and a CONTRACT file declaring a `count` — and the obligation follows the
// shape. A constant's assertions are attributed through the comparator that
// READS it, exactly as before; a contract has no comparator to follow, so the
// obligation is every message its guard can print. Both are in `ratchetScan.ts`,
// and neither introduces a list.

const FIXTURE = path.join(process.cwd(), 'tests/rls/__fixtures__/ratchets');

const describeRatchet = (r: Ratchet): string =>
  `${r.file}:${r.line} ${r.name} = ${r.value} (${r.direction})`;

describe('the ratchet scanner rules on every shape', () => {
  it('classifies the fixture in both directions', () => {
    const found = scanRatchets(FIXTURE);

    expect(
      found.map((r) => `${r.name}=${r.value}:${r.direction}:${r.assertions.length}`).sort(),
    ).toEqual([
      // A real message with no preamble is still an ASSERTED ratchet — the
      // scanner reports the message, the guard below rules on its content. The
      // two jobs stay apart so a wording change cannot silently unenroll one.
      'FIXTURE_BARE_MESSAGE_CEILING=3:ceiling:1',
      // Direction from the COMPARATOR, and attribution across distance: it is
      // declared second of three and asserted last of seven.
      'FIXTURE_COMPLIANT_CEILING=12:ceiling:1',
      'FIXTURE_COMPLIANT_FLOOR=7:floor:1',
      'FIXTURE_IMMUNE_CEILING=0:ceiling:1',
      'FIXTURE_NO_MESSAGE_CEILING=5:ceiling:1',
      // Declared, never asserted. Enrolled precisely so it can be reported.
      'FIXTURE_ORPHAN_CEILING=41:ceiling:0',
    ]);
  });

  it('does not enrol a number merely because it is a named constant', () => {
    const found = scanRatchets(FIXTURE).map((r) => r.name);

    // `FIXTURE_MAX_HOPS` is numeric, module-scoped, and compared with
    // `toBeLessThanOrEqual` — every surface property of a ceiling except the
    // one that enrols it. The real tree's `MAX_HELPER_HOPS`
    // (`contextArmScan.ts`) is the same shape, and a scanner that swept it in
    // would demand a re-measure preamble on a parser's recursion limit.
    expect(found).not.toContain('FIXTURE_MAX_HOPS');
    expect(found.every((n) => RATCHET_NAME.test(n))).toBe(true);
  });

  it('does not enrol a correctly-named number that is not a population COUNT', () => {
    // MOTIR-5207. `FIXTURE_GEOMETRY_FLOOR = 0.8` is suffixed, module-scoped and
    // read by a floor comparator — every surface property of a ratchet. It is
    // not one, because a population is counted in whole things: the real
    // instance is `ARRIVAL_FLOOR` in `cloud-roadmap-arrival.spec.ts`, the
    // design's legibility floor, and `origin/main` cannot adjudicate a scale.
    //
    // This is the widened ROOT's own safety rail. Under the flat `tests/rls/`
    // walk nothing outside one directory could be swept in at all; now that the
    // scan reaches `tests/e2e/`, the rule that keeps geometry out has to be
    // DERIVED — an integer test — rather than a name nobody remembers to add.
    const found = scanRatchets(FIXTURE);
    expect(found.map((r) => r.name)).not.toContain('FIXTURE_GEOMETRY_FLOOR');
    expect(found.every((r) => Number.isInteger(r.value) && r.value >= 0)).toBe(true);
  });

  it('reads the message through a modifier chain rather than reporting none', () => {
    // The blind spot that would make this guard report its own gap as somebody
    // else's defect: `expect(x, msg).not.toBeLessThanOrEqual(N)` hangs the
    // comparator off `.not`, so a receiver read naively is a PropertyAccess and
    // not a call, and the message reads as absent. Proven on the fixture's
    // compliant ceiling, which reaches `expect` directly, plus the walk itself.
    const compliant = scanRatchets(FIXTURE).find((r) => r.name === 'FIXTURE_COMPLIANT_CEILING');
    expect(compliant?.assertions[0]?.message).toContain('remeasureFirst');
  });

  it('reports a missing message as empty rather than skipping the assertion', () => {
    const bare = scanRatchets(FIXTURE).find((r) => r.name === 'FIXTURE_NO_MESSAGE_CEILING');

    // Not merely absent from the compliant set — PRESENT with an empty message.
    // A scanner that dropped message-less assertions would let the cheapest way
    // to violate this rule also be the way to hide from it.
    expect(bare?.assertions).toHaveLength(1);
    expect(bare?.assertions[0]?.message).toBe('');
  });
});

describe('the ratchets over the real guards', () => {
  // ⚠️ Scan ONCE and share it. Every `it` below parses the same twelve files,
  // and a guard that re-derives a TypeScript parse per test passes bare and
  // TIMES OUT under `vitest run --coverage`, where v8 instruments every module
  // the parse touches (MOTIR-2815). The scan is memoised per root, so these are
  // cache hits.
  let all: readonly Ratchet[];
  let exposed: readonly Ratchet[];
  beforeAll(() => {
    all = scanRatchets();
    exposed = exposedRatchets();
  }, 60_000);

  it('finds the ratchets — the enumeration MOTIR-2941 owes, derived not transcribed', () => {
    // Names only. The VALUES deliberately do not appear in this assertion: a
    // value is exactly the thing a sibling merging beneath us moves, and pinning
    // one here would make every legitimate re-measure fail an unrelated guard —
    // the defect this card exists to close, re-committed one level up.
    expect(all.map((r) => r.name).sort()).toEqual([
      'BARE_TRANSACTION_CEILING',
      'GATED_BARE_TRANSACTION_CEILING',
      'RAW_CEILING',
      // ⚠️ The NINTH, and it is why the root widening is not tidiness
      // (MOTIR-5207). It has been live in `tests/navigation/` since MOTIR-3449,
      // one directory outside the old flat walk, and was therefore invisible to
      // every assertion in this file — a ceiling over 87 pages whose failure
      // printed a bare array diff and no instruction at all.
      'SERIAL_READ_CEILING',
      'UNBOUND_CALL_SITE_CEILING',
      'UNCONVERTED_E2E_CEILING',
      'UNCONVERTED_VITEST_CEILING',
      'UNREVIEWED_CEILING',
      'UNTOUCHED_OUT_OF_SCOPE_FLOOR',
    ]);
  });

  it('every ratchet is actually asserted somewhere', () => {
    const orphans = all.filter((r) => r.assertions.length === 0);

    expect(
      orphans.map(describeRatchet),
      `A ratchet constant is declared that no assertion reads. It is documentation ` +
        `wearing a guard's clothes: it will be kept up to date by nobody and enforce ` +
        `nothing. Either assert it, or delete it and put the number in prose where a ` +
        `reader can see it is not enforced.`,
    ).toEqual([]);
  });

  it('every NON-ZERO ratchet opens with the re-measure preamble', () => {
    const missing = exposed.flatMap((r) =>
      r.assertions
        .filter((a) => !a.message.includes('remeasureFirst'))
        .map((a) => `${r.file}:${a.line} ${r.name} = ${r.value}`),
    );

    expect(
      missing,
      `A non-zero ratchet's failure message does not start with ` +
        `\`remeasureFirst('<NAME>')\` (\`tests/rls/remeasureFirst.ts\`).\n\n` +
        `Its value is a measurement taken on a BRANCH, so the first thing its message owes ` +
        `the reader is that the movement may not be theirs — a sibling merging beneath it ` +
        `moves the population without touching the constant. That is not hypothetical: it ` +
        `is how \`UNCONVERTED_E2E_CEILING\` failed on its own merge commit and took every ` +
        `open PR red with it (MOTIR-2939), and the expense was not the fix but proving that ` +
        `nobody had done what the message accused them of.\n\n` +
        `Concatenate it at the FRONT of the message:\n\n` +
        `    expect(\n` +
        `      count,\n` +
        `      remeasureFirst('YOUR_CEILING') + \`\${count} … (ceiling \${YOUR_CEILING}).\`,\n` +
        `    ).toBeLessThanOrEqual(YOUR_CEILING);\n\n` +
        `A ratchet of exactly 0 is exempt and this guard skips it: nothing merging beneath ` +
        `a zero can move it. If yours just moved OFF zero, this firing is that exemption ` +
        `expiring — which is the moment it becomes exposed.\n\n` +
        `See \`docs/decisions/ratchet-constant-staleness.md\` for why this is the rule ` +
        `rather than deriving the value from \`origin/main\` at run time.`,
    ).toEqual([]);
  });

  it('an immune ratchet is one at exactly zero, and only that', () => {
    // The exemption is stated as an assertion so it cannot quietly widen. A
    // ceiling of 0 cannot be pushed below 0 and a floor of 0 cannot fail, so
    // neither can be moved by anything a sibling merges. Every other value can,
    // including a value of 1.
    const immune = all.filter((r) => !exposed.includes(r));

    expect(immune.every((r) => r.value === 0)).toBe(true);
    expect(exposed.every((r) => r.value !== 0)).toBe(true);
    expect(immune.length + exposed.length).toBe(all.length);
  });

  it('at least one real ratchet is exposed, so a green run is not a vacuous one', () => {
    // The way this whole file goes quietly useless: every ratchet reaches zero
    // (which is the goal), `exposed` empties, and the preamble check passes over
    // nothing while still reading green. When that day comes this is the test
    // that fails, and the right response is to delete this file — the class is
    // closed — not to lower this assertion.
    expect(
      exposed.length,
      `No non-zero ratchet remains under \`tests/rls/\`. If that is real, every counted ` +
        `population has reached zero and the staleness class is CLOSED: delete this guard, ` +
        `\`ratchetScan.ts\` and \`remeasureFirst.ts\`, and record the closure in ` +
        `\`docs/decisions/ratchet-constant-staleness.md\`. If it is not real, this scanner ` +
        `has stopped seeing the guards — which is the failure mode a ratchet over ratchets ` +
        `has, and the reason this assertion exists.`,
    ).toBeGreaterThan(0);
  });
});

describe('the preamble itself', () => {
  it('names the constant, the instruction and the re-measure command', () => {
    // The meta-guard checks that each ratchet REACHES this helper; nothing there
    // reads what it says. So the content is pinned here — the two halves compose
    // into the guarantee, and neither is sufficient alone.
    const text = remeasureFirst('SOME_CEILING');

    expect(text).toContain('SOME_CEILING');
    expect(text).toContain('origin/main');
    expect(text).toContain('git worktree add ../recheck origin/main');
    expect(text).toContain('MOTIR-2939');
    expect(text).toMatch(/before looking for a culprit/i);
    // The lane's command, not `pnpm vitest run tests/rls/` — which MOTIR-3144
    // made unable to run these guards at all when it moved them out of the root
    // config's `include`, and which this preamble went on printing for months
    // (MOTIR-5207).
    expect(text).toContain('pnpm test:guards');
  });

  it('prints the RE-RUN command it was given, so a guard outside the lane is reachable', () => {
    // MOTIR-5207. A preamble whose command does not run the failing guard is a
    // re-measure instruction the reader cannot follow — which is most of what
    // the instruction was for. `SERIAL_READ_CEILING` runs in the sharded root
    // job, not the guards lane, so it passes its own.
    const text = remeasureFirst('SOME_CEILING', 'pnpm vitest run tests/navigation/some.test.ts');

    expect(text).toContain('pnpm vitest run tests/navigation/some.test.ts');
    expect(text).not.toContain('pnpm test:guards');
  });

  it('names the MERGE QUEUE, because that is where a stale baseline now fails', () => {
    // The ADR's AMENDMENT (2026-09-12): the queue builds the COMPOSED tree, so
    // it is the first thing to meet a stale baseline — and it reports that as an
    // EJECTION, which is harder to read than a red check, not easier. A reader
    // who only ever meets this message in a queue rejection needs it to say so.
    const text = remeasureFirst('SOME_CEILING');

    expect(text).toMatch(/merge queue/i);
    expect(text).toContain('MOTIR-5207');
  });

  it('leads with the instruction rather than burying it', () => {
    // A preamble that arrives after four paragraphs of "you did X" has already
    // lost: by then the reader has accepted the accusation. Vitest truncates a
    // long message, so position is not cosmetic.
    const first = remeasureFirst('SOME_CEILING').split('\n')[0] ?? '';

    expect(first).toMatch(/FIRST/);
    expect(first).toMatch(/MAY NOT BE YOUR CHANGE/);
  });
});

describe('the CONTRACT ratchets — the shape enrolment by NAME could not see (MOTIR-5207)', () => {
  const describeSet = (r: SetRatchet): string => `${r.file} (count ${r.count})`;

  describe('the scanner rules on the fixture pair', () => {
    it('enrols the CONTRACT and not the EVIDENCE beside it', () => {
      // The distinction MOTIR-5037's guard argues for in prose, falling out of
      // the shape instead: `fixtureAllowList.json` declares a `count` and an
      // array of exactly that length — a committed population measurement —
      // while `fixtureEvidence.json` is a regenerated snapshot and declares no
      // `count` at all. The real pair is `pageRootedLocatorAllowList.json`
      // (hand-shrunk, the ratchet) beside `pageLocatorInventory.json` (re-run,
      // "DATED EVIDENCE, not a contract" in its own note).
      const found = scanSetRatchets(FIXTURE);

      expect(found.map((r) => `${r.name}=${r.count}`)).toEqual(['fixtureAllowList.json=3']);
    });

    it('DERIVES the guard from the source that names the contract, not from a list', () => {
      // Nothing registers `fixtureContractGuard.ts` anywhere. It is found
      // because it contains the contract's path as a string — which is the only
      // way a guard can read a contract at all, so it cannot be forgotten the
      // way a registration can.
      const [contract] = scanSetRatchets(FIXTURE);

      expect(contract?.guards).toEqual(['tests/rls/__fixtures__/ratchets/fixtureContractGuard.ts']);
    });

    it('reports a message WITHOUT the preamble, and skips one that is not a message', () => {
      // The three cases in one file, which is the shape the rule must rule on: a
      // compliant message, a real message with no preamble (what MOTIR-5037's
      // guard shipped), and an `expect` with no message argument — out of scope
      // because it accuses nobody, the same ground the scanner gives for a bare
      // numeric sanity floor.
      const messages = guardMessages('tests/rls/__fixtures__/ratchets/fixtureContractGuard.ts');

      expect(messages.map((m) => m.message.includes('remeasureFirst'))).toEqual([true, false]);
    });
  });

  describe('over the real contracts', () => {
    let sets: readonly SetRatchet[];
    let exposedSets: readonly SetRatchet[];
    beforeAll(() => {
      sets = scanSetRatchets();
      exposedSets = exposedSetRatchets();
    }, 60_000);

    it('finds the contracts — derived, so a contract written tomorrow is enrolled', () => {
      // Paths only, never counts: a count is exactly what a sibling merging
      // beneath us moves, and pinning one here would re-commit the defect this
      // file exists to close, one level up. Same reason the constant
      // enumeration above carries names and no values.
      expect(sets.map((r) => r.file).sort()).toEqual([
        'tests/helpers/pageRootedLocatorAllowList.json',
      ]);
    });

    it('every contract is actually read by a guard', () => {
      const orphans = sets.filter((r) => r.guards.length === 0);

      expect(
        orphans.map(describeSet),
        `A contract file declares a population that no test reads. It is documentation ` +
          `wearing a ratchet's clothes: nothing will fail when it stops describing the tree. ` +
          `Either assert it, or delete it and put the measurement where a reader can see it ` +
          `is not enforced.`,
      ).toEqual([]);
    });

    it('every NON-EMPTY contract guard opens EVERY message with the re-measure preamble', () => {
      const missing = exposedSets.flatMap((r) =>
        r.guards.flatMap((guard) =>
          guardMessages(guard)
            .filter((m) => !m.message.includes('remeasureFirst'))
            .map((m) => `${m.file}:${m.line} (contract ${r.file}, count ${r.count})`),
        ),
      );

      expect(
        missing,
        `A guard holding a CONTRACT ratchet prints a failure message that does not open with ` +
          `\`remeasureFirst(…)\` (\`tests/rls/remeasureFirst.ts\`).\n\n` +
          `Its contract is a population measured on a BRANCH, so the first thing any of its ` +
          `messages owes the reader is that the movement may not be theirs. That is not ` +
          `hypothetical and it is not the numeric ratchets' story borrowed: MOTIR-5037's ` +
          `allow-list shipped without this, told a runner that thirty-two locators were NEW ` +
          `when they had been on \`main\` for four hours, and cost PR #2818 two merge-queue ` +
          `slots (runs 34643738460 / 34646088683).\n\n` +
          `Concatenate it at the FRONT of the message:\n\n` +
          `    const PREAMBLE = remeasureFirst('yourContract.json');\n` +
          `    expect(offenders, PREAMBLE + \`…\`).toEqual([]);\n\n` +
          `⚠️ EVERY message, not only the one you expect to fail. A contract guard has no ` +
          `comparator for the scanner to attribute an assertion through — the offender list is ` +
          `computed in one statement and asserted in the next — so the obligation is the whole ` +
          `file. An \`expect\` with NO message argument is out of scope: it accuses nobody.\n\n` +
          `A contract whose \`count\` is 0 is exempt, for the same reason a zero ceiling is.\n\n` +
          `See \`docs/decisions/ratchet-constant-staleness.md\` (AMENDMENT, 2026-09-12) for why ` +
          `the merge queue does NOT retire this rule.`,
      ).toEqual([]);
    });

    it('at least one contract is exposed, so a green run is not a vacuous one', () => {
      // The same failure mode the constant half guards against, and it has an
      // extra door here: the contract scan derives its guard by SOURCE TEXT, so
      // a refactor that moves a path into a constant in another module would
      // empty `guards` silently. The orphan assertion above catches that one;
      // this catches the scan finding no contract at all.
      expect(
        exposedSets.length,
        `No non-empty CONTRACT ratchet remains under \`tests/\`. If that is real, every ` +
          `contract-shaped debt has been paid down and this half of the class is CLOSED: ` +
          `delete this block and \`scanSetRatchets\` and record the closure in ` +
          `\`docs/decisions/ratchet-constant-staleness.md\`. If it is not real, the scanner has ` +
          `stopped seeing the contracts — which is the failure mode a ratchet over ratchets ` +
          `has, and the reason this assertion exists.`,
      ).toBeGreaterThan(0);
    });
  });
});
