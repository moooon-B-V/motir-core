import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-6190 — a Part number in a `design-notes.md` is an ADDRESS, and nothing
// measured that it addressed one thing.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `design/ai-planning/design-notes.md` is cut into `# Part <N>` sections, and
// cards, mocks and later notes cite them by number ("Part XX §20.4"). The number
// is picked by reading the file's last Part and adding one. Two things went wrong
// at once: a Part published on a design result but never landed in the file was
// invisible to that read, so the next author took its number (MOTIR-6134's Part
// XX, beside MOTIR-6033's published Part XX); and the index table at the top of
// the file had lost the row for Part XIX. A citation then resolved to the wrong
// design, and a reader of the table could not find a section that was there.
//
// ── What this guard can and cannot see ─────────────────────────────────────
// It reads the FILES. It rules that within one file every Part number is used
// once, and that the index table and the headings name the same set. It cannot
// see a result that was published and never landed — that half is the sentence
// under the table in `design/ai-planning/design-notes.md`, which tells an author
// to check the published results before taking a number.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');
const NOTES = 'design-notes.md';

/** A Part heading: `# Part XIX — …` or `## Part XI — …`, capturing the numeral. */
const PART_HEADING = /^#{1,2} Part ([IVXLC]+)\b/;

/** An index-table row whose last cell names a Part: `| … | Part XIX |`. */
const INDEX_ROW = /^\|.*\|\s*Part ([IVXLC]+)\s*\|\s*$/;

type PartFindings = { duplicates: string[]; unindexed: string[]; dangling: string[] };

/**
 * The three findings for one notes file. Pure, so the failure path runs on a
 * fixture below rather than only ever comparing a healthy tree against `[]`.
 */
function partFindings(source: string): PartFindings {
  const headings: string[] = [];
  const indexed = new Set<string>();
  for (const line of source.split('\n')) {
    const heading = PART_HEADING.exec(line);
    if (heading) headings.push(heading[1]!);
    const row = INDEX_ROW.exec(line);
    if (row) indexed.add(row[1]!);
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const part of headings) {
    if (seen.has(part)) duplicates.add(part);
    seen.add(part);
  }
  return {
    duplicates: [...duplicates].sort(),
    // A file with no index table at all has nothing to keep in step, so only a
    // file that HAS one is held to it.
    unindexed: indexed.size === 0 ? [] : [...seen].filter((part) => !indexed.has(part)).sort(),
    dangling: [...indexed].filter((part) => !seen.has(part)).sort(),
  };
}

/** Every `design-notes.md` under `design/`, as a repo-relative POSIX path. */
function notesFiles(dir: string = DESIGN_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) notesFiles(path, out);
    else if (entry.name === NOTES) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out.sort();
}

const FILES = notesFiles();
const PARTED = FILES.filter((file) =>
  readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .some((line) => PART_HEADING.test(line)),
);

describe('a design-notes Part number addresses ONE section (MOTIR-6190)', () => {
  it('finds the notes that are cut into Parts', () => {
    // Without this every assertion below passes vacuously if the walk breaks or
    // the heading grammar changes.
    expect(PARTED).toContain('design/ai-planning/design-notes.md');
  });

  it.each(PARTED)('%s uses every Part number once', (file) => {
    const { duplicates } = partFindings(readFileSync(join(ROOT, file), 'utf8'));
    expect(duplicates, `${file}: a Part number names two sections`).toEqual([]);
  });

  it.each(PARTED)('%s indexes every Part, and indexes no Part it lacks', (file) => {
    const { unindexed, dangling } = partFindings(readFileSync(join(ROOT, file), 'utf8'));
    expect(unindexed, `${file}: a Part heading has no index-table row`).toEqual([]);
    expect(dangling, `${file}: an index-table row names a Part with no heading`).toEqual([]);
  });
});

describe('the Part check on a fixture', () => {
  const HEALTHY = [
    '| Surface | Files | Card | Section |',
    '| --- | --- | --- | --- |',
    '| One | `one.mock.html` | MOTIR-1 | Part I |',
    '| Two | `two.mock.html` | MOTIR-2 | Part II |',
    '| Two, again | `two.mock.html` (panel B) | MOTIR-3 | Part II |',
    '',
    '# Part I — one',
    '## I.1 a subsection, not a Part',
    '## Part II — a Part at the second level',
  ].join('\n');

  it('passes a file whose headings and index agree, a Part cited by two rows included', () => {
    expect(partFindings(HEALTHY)).toEqual({ duplicates: [], unindexed: [], dangling: [] });
  });

  it('fails a Part number used twice', () => {
    const twice = `${HEALTHY}\n# Part II — a different design under a taken number`;
    expect(partFindings(twice).duplicates).toEqual(['II']);
  });

  it('fails a Part heading with no index row', () => {
    expect(partFindings(`${HEALTHY}\n# Part III — never indexed`).unindexed).toEqual(['III']);
  });

  it('fails an index row naming a Part with no heading', () => {
    const row = '| Four | `four.mock.html` | MOTIR-4 | Part IV |';
    expect(partFindings(HEALTHY.replace('| Two, again', `${row}\n| Two, again`)).dangling).toEqual([
      'IV',
    ]);
  });

  it('does not ask for an index in a file that keeps none', () => {
    expect(partFindings('# Part I — one\n# Part II — two').unindexed).toEqual([]);
  });
});
