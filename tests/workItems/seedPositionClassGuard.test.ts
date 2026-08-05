import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isValidOrderKey } from '@/lib/workItems/positioning';

// The CLASS guard for a work-item `position` (MOTIR-2198).
//
// A `work_item.position` MUST be a real fractional-index key — the shape
// `lib/workItems/positioning.ts` mints. A seeder that writes a number formatted
// as a string instead (`String(key).padStart(8, '0')`, `` `p${key}` ``) produces
// a row the product itself can never emit, and the cost is not theoretical:
//
//   - `String(key).padStart(n, '0')` has head `'0'`, which `generateKeyBetween`
//     rejects outright ("invalid order key head: 0"). Every board drag landing
//     next to such a card threw → the move API 500'd and the board rendered
//     "Move not allowed".
//   - `` `p${String(key).padStart(7, '0')}` `` is invalid for a subtler reason:
//     head `'p'` demands a 17-character integer part. It SORTS correctly, so a
//     board seeded with it renders fine and nothing goes red — what it silently
//     exercises is `keyBetweenSafe`'s invalid-bound TOLERANCE arm (the one that
//     exists for legacy rows, and degrades a drop to an append) rather than the
//     ordinary `keyBetween` path the assertion claims to be about.
//
// This defect was found, fixed and explained in a comment block three separate
// times — `scripts/plan-seed/seed.ts`, `scripts/seedLargeBoard.ts`, then
// MOTIR-2196's `tests/fixtures/workItemFixtures.ts` — and reappeared in five
// more writers anyway, because a lesson living in three comment blocks reaches
// nobody who does not already read those files. So it is asserted here instead:
// a new writer that formats a number into a work-item `position` is a red test,
// not a bug someone re-finds from a bare 500 next month.
//
// SCOPE: only `work_item` position writes. Other entities (`board_column`,
// `project_repo`, `workflow_status`, custom-field options) order by their own
// `position` under their own rules and are deliberately out of this class —
// widening the guard to every `position:` in the repo would assert a contract
// this card has no evidence for.

const ROOT = process.cwd();
const SCAN_DIRS = ['lib', 'scripts', 'tests'];

// This file's own regexes and prose are examples OF the offending form.
const SELF = join('tests', 'workItems', 'seedPositionClassGuard.test.ts');

// Sites that still carry the old form on `origin/main` and are FIXED by the
// open PR #1868 (MOTIR-2196) — the other half of this class, which lands as its
// own diff so the two runs do not ship two mechanisms for one defect. The
// assertion below is a SUBSET check, not an equality one, so it stays green
// whichever of the two PRs merges first and needs no follow-up edit when #1868
// lands (the entries simply stop matching). A writer that is NOT on this list
// fails immediately — which is the whole point.
const KNOWN_ON_MAIN_FIXED_BY_MOTIR_2196 = new Set(
  [
    'tests/fixtures/workItemFixtures.ts',
    'tests/entitlementsService.test.ts',
    'tests/integration/work-items/link-candidate-search.test.ts',
    'tests/integration/work-items/mention-search-route.test.ts',
    'tests/integration/work-items/quick-search.test.ts',
  ].map((p) => p.split('/').join(sep)),
);

/** A write through one of the two paths that reach `work_item` rows. */
const WORK_ITEM_WRITE_RE =
  /\b(?:db|tx|prisma)\.(\w+)\.(?:create|createMany|update|updateMany|upsert)\b|\b(\w+Repository)\.(?:create|update|upsert)\b/;

/** `position: <value>` — the value up to the end of the line. */
const POSITION_WRITE_RE = /(?:^|[\s{,])position:\s*(.+?),?\s*$/;

/** How far back a `position:` line may sit from the write call that owns it. */
const LOOKBACK_LINES = 40;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Is `value` a work-item position the product could NOT have minted?
 *
 * Decidable statically for exactly the two forms of the class: a number run
 * through `padStart` / `String(...)`, and a hand-built literal. A call into
 * `positioning.ts` (or a variable holding one) is accepted — that is the fix.
 */
function isOffendingValue(value: string): boolean {
  if (/\bpadStart\s*\(/.test(value)) return true;
  if (/^String\s*\(/.test(value)) return true;
  // A template literal built by hand: `p${…}` and friends. A key is opaque —
  // there is no reason to interpolate one rather than mint it.
  if (/^`/.test(value)) return true;
  // A plain string literal is decidable outright.
  const literal = /^'([^']*)'$|^"([^"]*)"$/.exec(value);
  if (literal) return !isValidOrderKey(literal[1] ?? literal[2] ?? '');
  return false;
}

interface Offender {
  file: string;
  line: number;
  value: string;
}

function findOffenders(file: string): Offender[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Offender[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = POSITION_WRITE_RE.exec(lines[i]!);
    if (!match) continue;
    const value = match[1]!.trim();
    if (!isOffendingValue(value)) continue;

    // Attribute the write to its entity: the nearest preceding write call wins.
    let entity: string | null = null;
    for (let j = i; j >= Math.max(0, i - LOOKBACK_LINES); j--) {
      const call = WORK_ITEM_WRITE_RE.exec(lines[j]!);
      if (call) {
        entity = call[1] ?? call[2] ?? null;
        break;
      }
    }
    if (entity !== 'workItem' && entity !== 'workItemRepository') continue;

    out.push({ file: relative(ROOT, file), line: i + 1, value });
  }
  return out;
}

describe('work-item `position` seeds are real fractional-index keys', () => {
  it('no seeder writes a padded or prefixed NUMBER into work_item.position', () => {
    const offenders = SCAN_DIRS.flatMap((d) => collectSourceFiles(join(ROOT, d)))
      .filter((f) => relative(ROOT, f) !== SELF)
      .flatMap(findOffenders)
      .filter((o) => !KNOWN_ON_MAIN_FIXED_BY_MOTIR_2196.has(o.file));

    expect(
      offenders.map((o) => `${o.file}:${o.line} → position: ${o.value}`),
      'mint the key via lib/workItems/positioning.ts (keyForAppend, chained in creation order) — see this file for why',
    ).toEqual([]);
  });

  it('the checker recognises every historical form of the defect', () => {
    // The four shapes this class actually took in the repo, so the guard cannot
    // rot into a regex that matches nothing.
    expect(isOffendingValue("String(key).padStart(8, '0')")).toBe(true);
    expect(isOffendingValue('`p${String(key).padStart(7, "0")}`')).toBe(true);
    expect(isOffendingValue('`p${key}`')).toBe(true);
    expect(isOffendingValue("'pa'")).toBe(true);
    // …and accepts the fix, in each of the forms it is written in.
    expect(isOffendingValue('keyForAppend(lastPosition)')).toBe(false);
    expect(isOffendingValue('(position = keyForAppend(position))')).toBe(false);
    expect(isOffendingValue('nextPosition()')).toBe(false);
    expect(isOffendingValue("'a0'")).toBe(false);
  });
});
