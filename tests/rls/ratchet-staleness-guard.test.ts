import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { RATCHET_NAME, exposedRatchets, scanRatchets, type Ratchet } from './ratchetScan';
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
