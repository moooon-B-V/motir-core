import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-2540 — the product calls this object ONE thing, and a test is the only
// form of "everywhere" that survives contact with time.
//
// ── What this guards ────────────────────────────────────────────────────────
// Story MOTIR-2532 settled the reader-facing noun on **Tokens**. Eleven files
// were swept by hand. That sweep is correct today and starts rotting tomorrow:
// six weeks from now a new docs page, a new error hint or a new guide step
// reintroduces "API tokens", written in good faith by someone who never read
// the story. Nothing fails, because prose is not resolved by any build — the
// exact shape `tests/design-asset-addresses.test.ts` was built for one layer
// down, and whose structure this file copies deliberately.
//
// ── The pattern is the SPACED ENGLISH PHRASE, and that is the whole design ──
// `/API tokens?/i` matches the words a reader sees. It does NOT match
// `apiTokens`, `ApiToken`, `api_token`, `api-tokens` or `/api/me/api-tokens`,
// and that is not an oversight — MOTIR-2532 deliberately KEPT every one of
// those. An i18n key is not a surface; a table name is not a surface; the
// client island's internal fetch route is not a surface. A guard that fired on
// them would be quietly campaigning for the opposite of the decision in every
// future PR, so the boundary is asserted below with a fixture for each rather
// than left to the regex to imply.
//
// ── What is EXCLUDED BY CONSTRUCTION, and why it is not an allowlist ────────
// Three trees are out of scope entirely, because for them the old wording is
// CORRECT and permanent — listing them row by row would be thousands of
// exemptions describing one decision:
//
//   * `design/**` — a design asset is a RECORD OF THE MOMENT IT WAS DRAWN, not
//     a spec that tracks the product (Yue, 2026-08-10). The assets say
//     "API tokens" because that is what the surface said when they were drawn.
//     MOTIR-2533, the card that would have swept them, was archived unbuilt on
//     that call. (Their ADDRESSES are a different question, and the design
//     address guard handles it.)
//   * `docs/decisions/**` — an ADR is a dated record of what was decided and
//     why. Back-editing one so a later rename looks tidy destroys the thing
//     that makes it worth keeping.
//   * `scripts/plan-seed/**` — a frozen bootstrap snapshot the live tenant
//     diverged from long ago. Not a surface.
//
// The `KNOWN` table below is for the residue: a line INSIDE the scan set where
// the old phrase is right. It is asserted TIGHT in both directions — an
// unlisted hit fails, and a listed row that no longer matches fails too — which
// is what stops it decaying into a mute button.

const ROOT = process.cwd();

/** The phrase a reader sees, in both shipped locales. Never the identifiers. */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'API token(s)', re: /API tokens?/gi },
  { label: 'API令牌', re: /API\s*令牌/g },
];

/** Reader-facing trees only. A file outside these is not a surface. */
const SCAN: { dir: string; match: (rel: string) => boolean }[] = [
  { dir: 'messages', match: (r) => r.endsWith('.json') },
  { dir: 'lib/apiDocs', match: (r) => r.endsWith('.ts') || r.endsWith('.tsx') },
  { dir: 'lib/api/v1/openapi', match: (r) => r.endsWith('.ts') },
  { dir: 'app', match: (r) => r.endsWith('.ts') || r.endsWith('.tsx') },
  { dir: 'packages/cli/src', match: (r) => r.endsWith('.ts') },
  { dir: 'docs', match: (r) => r.endsWith('.md') && !r.startsWith(`decisions${sep}`) },
  { dir: '.github/actions', match: (r) => r.endsWith('.yml') || r.endsWith('.yaml') },
];

/** Single files that are reader-facing but live outside a scanned tree. */
const SCAN_FILES = ['packages/cli/README.md', 'packages/cli/sandbox/README.md'];

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

/** Every reader-facing file in scope, as repo-relative paths. */
export function scanFiles(root = ROOT): string[] {
  const files: string[] = [];
  for (const { dir, match } of SCAN) {
    for (const abs of walk(join(root, dir))) {
      const rel = relative(join(root, dir), abs);
      if (match(rel)) files.push(relative(root, abs));
    }
  }
  for (const f of SCAN_FILES) files.push(f);
  return files.map((f) => f.split(sep).join('/')).sort();
}

/** Every occurrence of the old noun in the reader-facing set. */
export function findOldNoun(root = ROOT): Finding[] {
  const found: Finding[] = [];
  for (const rel of scanFiles(root)) {
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

describe('the product calls it Tokens, everywhere a reader can see', () => {
  it('scans a real, non-empty set of reader-facing files', () => {
    // A scan that silently matches nothing is the most convincing kind of green
    // there is. Anchor it: the catalogues and the CLI's error module are in
    // scope by construction, and there are many files, not three.
    const files = scanFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('messages/en.json');
    expect(files).toContain('messages/zh.json');
    expect(files).toContain('packages/cli/src/errors.ts');
    expect(files).toContain('packages/cli/README.md');
  });

  it('finds no reader-facing surface still saying "API token"', () => {
    const unlisted = findOldNoun()
      .filter((f) => !KNOWN.some((k) => k.file === f.file && k.line === f.line))
      .map((f) => `${f.file}:${f.line} — ${f.label} — ${f.text.slice(0, 90)}`);

    expect(
      unlisted,
      'A reader meets one name for this object: Tokens. Rename the surface, or add the ' +
        'line to KNOWN with a reason if the old phrase is genuinely right there.',
    ).toEqual([]);
  });

  it('keeps KNOWN honest — every row still matches something', () => {
    // The other direction, which is what stops the table becoming a mute
    // button: a row whose line was fixed or moved must be deleted, not left.
    const found = findOldNoun();
    const stale = KNOWN.filter(
      (k) => !found.some((f) => f.file === k.file && f.line === k.line),
    ).map((k) => `${k.file}:${k.line} (${k.why})`);
    expect(stale, 'This KNOWN row no longer matches anything — delete it.').toEqual([]);
  });

  it('does NOT fire on the identifiers MOTIR-2532 deliberately kept', () => {
    // The boundary IS the decision, so it is a test rather than a comment. An
    // i18n key, a Prisma model, a table, a route segment and the internal fetch
    // path are not surfaces — a guard that flagged them would be arguing for
    // the opposite conclusion in every future PR.
    const kept = [
      'settings.apiTokens.heading',
      'const apiTokens = await apiTokensService.list()',
      'model ApiToken {',
      'api_token',
      '/settings/account/api-tokens',
      '/api/me/api-tokens',
      "import { apiTokensClient } from './apiTokensClient'",
    ];
    for (const line of kept) {
      for (const { re } of PATTERNS) {
        re.lastIndex = 0;
        expect(re.test(line), `the guard must not fire on: ${line}`).toBe(false);
      }
    }
  });

  it('DOES fire on the phrase a reader sees — proven on a real file in the scan set', () => {
    // The self-check. Seed the phrase into a temporary file inside a scanned
    // tree and assert the scan reports it; without this, a walk that silently
    // resolved to nothing would pass every assertion above.
    const probe = join(ROOT, 'docs', '__reader-noun-probe.md');
    try {
      writeFileSync(probe, '# probe\n\nMint one in Settings → Account → API tokens.\n', 'utf8');
      const hits = findOldNoun().filter((f) => f.file === 'docs/__reader-noun-probe.md');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.line).toBe(3);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it('excludes the three trees where the old wording is CORRECT', () => {
    const files = scanFiles();
    // A design asset records the moment it was drawn; an ADR records a dated
    // decision; the plan seed is a frozen snapshot. None tracks the product.
    expect(files.some((f) => f.startsWith('design/'))).toBe(false);
    expect(files.some((f) => f.startsWith('docs/decisions/'))).toBe(false);
    expect(files.some((f) => f.startsWith('scripts/plan-seed/'))).toBe(false);
    // …and the exclusions are load-bearing, not vacuous: those trees really do
    // still carry the old phrase, which is why they had to be excluded rather
    // than swept.
    const designNotes = readFileSync(join(ROOT, 'design/settings/design-notes.md'), 'utf8');
    expect(designNotes).toMatch(/API tokens/);
  });
});
