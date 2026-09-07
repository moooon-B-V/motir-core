import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4757 — the planner's own vocabulary does not ship to the user.
//
// ── What this guards ────────────────────────────────────────────────────────
// *"Pre-plan"* is the CORPUS's word for the four-tier direction stage. It is not
// the product's, and it is undefined for anyone who has not read the planning
// rules — yet it shipped, in the onboarding topbar, above the very screen where
// a user is answering those questions:
//
//     onboarding.chat.topbarStep           = "Pre-plan · building your direction"
//     onboarding.chat.topbarStepRevisiting = "Pre-plan · revisiting your direction"
//
// The product's own noun was in the same namespace the whole time —
// `onboarding.chat.stepHeader` reads *"Building your direction"*, and
// *direction* is defined by the thing it names (`DirectionDocKind`, the
// direction docs, the roadmap's direction cluster).
//
// ── Why a GUARD and not just a rename ───────────────────────────────────────
// This is a recorded failure mode rather than a one-off: internal vocabulary
// travelling from a rule corpus into user-facing strings, written in good faith
// by somebody building an onboarding surface in the vocabulary of the document
// they were reading, and passed by everybody downstream because nothing
// mechanical objects. It happens again unless something does. One assertion
// over the catalogs is cheaper than noticing it a second time.
//
// Modelled on `tests/reader-facing-noun.test.ts` — the same structure, the same
// KNOWN discipline, the same self-check — rather than a new lane.
//
// ── SCOPE: the message catalogs, and nothing else ───────────────────────────
// The internal IDENTIFIERS are correctly internal and are NOT swept: the
// `discovery` / `vision` / `feasibility` / `validation` tier keys,
// `DirectionDocKind`, and every use of the term in the planning corpus, in an
// ADR, or in a design asset (a record of the moment it was drawn). A catalog is
// the one tree whose every string is read by a user, which is what makes the
// boundary a scope rather than an allowlist.

const ROOT = process.cwd();

/** The phrase a reader sees, in both shipped locales. Never an identifier. */
const PATTERNS: { label: string; re: RegExp }[] = [
  // Hyphen OR space, any case — "Pre-plan", "pre plan", "PRE-PLAN".
  { label: 'Pre-plan', re: /pre[-\s]plan/gi },
  { label: '预规划', re: /预规划/g },
];

/** Reader-facing catalogs only. */
const SCAN: { dir: string; match: (rel: string) => boolean }[] = [
  { dir: 'messages', match: (r) => r.endsWith('.json') },
];

/**
 * A line INSIDE the scan set where the term is genuinely right. Empty, and
 * asserted TIGHT in both directions below — an unlisted hit fails, and a listed
 * row that no longer matches fails too, which is what stops the table decaying
 * into a mute button.
 */
const KNOWN: { file: string; line: number; why: string }[] = [];

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  label: string;
  text: string;
}

/** Every catalog in scope, as repo-relative paths. */
export function scanCatalogs(root = ROOT): string[] {
  const files: string[] = [];
  for (const { dir, match } of SCAN) {
    for (const abs of walk(join(root, dir))) {
      const rel = relative(join(root, dir), abs);
      if (match(rel)) files.push(relative(root, abs));
    }
  }
  return files.map((f) => f.split(sep).join('/')).sort();
}

/** Every occurrence of the internal phase noun in the catalogs. */
export function findPhaseNoun(root = ROOT): Finding[] {
  const found: Finding[] = [];
  for (const rel of scanCatalogs(root)) {
    let source: string;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    source.split('\n').forEach((text, index) => {
      for (const { label, re } of PATTERNS) {
        re.lastIndex = 0;
        if (re.test(text)) found.push({ file: rel, line: index + 1, label, text: text.trim() });
      }
    });
  }
  return found;
}

describe('no user-facing string names an internal planning phase', () => {
  it('scans a real, non-empty set of catalogs', () => {
    // A scan that silently matches nothing is the most convincing kind of green
    // there is. Anchor it on both shipped locales.
    const files = scanCatalogs();
    expect(files).toContain('messages/en.json');
    expect(files).toContain('messages/zh.json');
  });

  it('finds no catalog string still saying "Pre-plan"', () => {
    const unlisted = findPhaseNoun()
      .filter((f) => !KNOWN.some((k) => k.file === f.file && k.line === f.line))
      .map((f) => `${f.file}:${f.line} — ${f.label} — ${f.text.slice(0, 90)}`);

    expect(
      unlisted,
      '"Pre-plan" is the planning corpus\'s word for the four-tier direction stage, not the ' +
        'product\'s. Say what the user is doing ("your direction"), or add the line to KNOWN ' +
        'with a reason if the term is genuinely right there.',
    ).toEqual([]);
  });

  it('keeps KNOWN honest — every row still matches something', () => {
    const found = findPhaseNoun();
    const stale = KNOWN.filter(
      (k) => !found.some((f) => f.file === k.file && f.line === k.line),
    ).map((k) => `${k.file}:${k.line} (${k.why})`);
    expect(stale, 'This KNOWN row no longer matches anything — delete it.').toEqual([]);
  });

  it('the two topbar strings read in the product’s own vocabulary', () => {
    // The positive half. The negative above would also be satisfied by deleting
    // the strings; this pins that they still say something, and that they read
    // as one voice with `stepHeader` without duplicating it (both can be on
    // screen at once — the topbar above, the tier gate's header inside it).
    const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8')) as {
      onboarding: { chat: Record<string, string> };
    };
    const chat = en.onboarding.chat;
    expect(chat['topbarStep']).toBe('Setting your direction');
    expect(chat['topbarStepRevisiting']).toBe('Revisiting your direction');
    expect(chat['stepHeader']).toBe('Building your direction');
    expect(chat['topbarStep']).not.toBe(chat['stepHeader']);
    for (const key of ['topbarStep', 'topbarStepRevisiting', 'stepHeader']) {
      expect(chat[key]).toMatch(/direction/i);
    }
  });

  it('does NOT fire on the identifiers that are correctly internal', () => {
    // The boundary IS the decision, so it is a test rather than a comment. A
    // tier key, the doc-kind enum and the corpus's own prose are not surfaces.
    const kept = [
      "type DirectionDocKind = 'discovery' | 'vision' | 'feasibility' | 'validation'",
      'const DIRECTION_DOC_ORDER = [...]',
      'preplanSessionService.loadCarriedState(aiProjectId)',
      'the approved preplan baseline',
    ];
    for (const line of kept) {
      for (const { re } of PATTERNS) {
        re.lastIndex = 0;
        expect(re.test(line), `the guard must not fire on: ${line}`).toBe(false);
      }
    }
  });

  it('DOES fire on the phrase a reader sees — proven on a real file in the scan set', () => {
    // The self-check, and the criterion that matters most: without it, a walk
    // that silently resolved to nothing would pass every assertion above.
    const probe = join(ROOT, 'messages', '__phase-noun-probe.json');
    try {
      writeFileSync(probe, '{\n  "topbarStep": "Pre-plan · building your direction"\n}\n', 'utf8');
      const hits = findPhaseNoun().filter((f) => f.file === 'messages/__phase-noun-probe.json');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.line).toBe(2);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it('fires on every spelling the rule names — hyphen, space and case', () => {
    for (const spelling of ['Pre-plan', 'pre plan', 'PRE-PLAN', 'Pre Plan', '预规划']) {
      const hit = PATTERNS.some(({ re }) => {
        re.lastIndex = 0;
        return re.test(`"topbarStep": "${spelling} · something"`);
      });
      expect(hit, `the guard must fire on: ${spelling}`).toBe(true);
    }
  });
});
