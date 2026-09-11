#!/usr/bin/env node
// MOTIR-5035 — enumerate every PAGE-ROOTED strict locator under `tests/e2e/**`.
//
// ── The defect this measures ────────────────────────────────────────────────
// React keeps the PREVIOUS subtree mounted while the new one streams, and
// Playwright resolves locators BEFORE filtering on visibility. So a locator
// rooted at `page` can match a node the author never knew was there:
//
//   1. the transient VISIBLE double subtree        (MOTIR-3692)
//   2. the OUTGOING subtree on a navigation        (MOTIR-3737, MOTIR-5035)
//   3. React's hidden `S:0` SSR staging block      (MOTIR-3929)
//
// `getByRole` is immune to all three, because the accessibility tree excludes
// the hidden copy — `tests/e2e/_helpers/settle.ts` says so, and Playwright
// prints the role alias in its own failure text. Six sites have cost a
// merge-queue slot; a queue failure EJECTS the pull request with nothing red on
// it to explain why.
//
// ── Why this is a SCRIPT and not a number in a card ─────────────────────────
// A count is dated evidence; a predicate re-evaluates itself. The card that
// commissioned this sweep was sized from a figure in `motir-core/CLAUDE.md`
// ("30 assertions across 17 spec files") that measures something else entirely
// — how many assertions went red when ONE route-group boundary was added — and
// the real population is ~50x that. So the authority here is this file, and
// `tests/helpers/pageLocatorInventory.json` is its dated output.
//
//   node scripts/enumerate-page-locators.mjs --ref origin/main
//   node scripts/enumerate-page-locators.mjs --worktree --out tests/helpers/pageLocatorInventory.json
//
// ── TWO entry points, ONE predicate ─────────────────────────────────────────
// `--ref` reads a COMMIT (`git ls-tree` + `git show`), so a count cannot pick up
// uncommitted edits in whichever worktree it is run from — that is what makes a
// number in a card checkable, and it is why there is no directory-walk default.
//
// `--worktree` reads the CHECKED-OUT tree, and exists for MOTIR-5037's guard,
// which must rule on the merge commit CI built — a ref nobody can name in
// advance. Sharing this scanner is the point: two copies of the predicate is how
// the inventory and the guard come to disagree about what the population is.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The non-role `getBy*` family. Each addresses a node by something the DOM may
 *  legitimately carry twice while a page is mid-navigation or mid-stream.
 *
 *  ⚠️ `getByPlaceholder` is here and MOTIR-5035 did not originally name it. A
 *  placeholder is an accessible name of last resort, so the locator is page-level
 *  and strict in exactly the way the other three are — 63 sites the card's own
 *  predicate would have missed. Name the aliases, and let the union win. */
const METHODS = ['getByTestId', 'getByText', 'getByLabel', 'getByPlaceholder'];

/** `.first()` / `.nth()` / `.last()` resolve to ONE element, so strict mode
 *  cannot fire on them. They are ENUMERATED and marked exempt rather than
 *  dropped, so this file and MOTIR-5037's guard cannot disagree about what the
 *  population is — the guard exempts the same three by name.
 *
 *  ⚠️ `.filter()` is NOT here, deliberately. It narrows the match set without
 *  guaranteeing one element, so a filtered locator still throws strict mode. */
const RESOLVERS = ['first', 'nth', 'last'];

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const REF = argOf('--ref', 'HEAD');
const OUT = argOf('--out', null);
/** Scan the CHECKED-OUT tree instead of a ref.
 *
 *  ⚠️ This exists for MOTIR-5037, and it is not a convenience. A guard has to
 *  rule on the tree it is running against — the merge commit CI built, which is
 *  a ref nobody can name in advance — so a ref-only tool could not be shared
 *  with it, and the guard would have to grow a SECOND copy of this predicate.
 *  Two predicates for one rule is how the inventory and the guard come to
 *  disagree about what the population is. One scanner, two entry points. */
const WORKTREE = args.includes('--worktree');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Walk forward from the '(' of a call and return the index just past its
 *  matching ')'. Quote- and template-aware, so a paren inside a string literal
 *  does not close the call. Returns -1 when the call is not closed on the text
 *  given — the caller then re-runs it over the joined continuation. */
function endOfCall(line, openIdx) {
  let depth = 0;
  let quote = null;
  let regex = false;
  let charClass = false;
  for (let i = openIdx; i < line.length; i++) {
    const c = line[i];

    // ⚠️ REGEX LITERALS COME FIRST, and they are not a nicety. Playwright specs
    // are full of `page.getByText(/It's yours\./)`, and an apostrophe inside a
    // pattern opens a phantom string that swallows the rest of the line — five
    // sites in this suite. A scanner that treats `'` as a quote everywhere
    // reports those rows with a null argument and an unstable key.
    if (regex) {
      if (c === '\\') i++;
      else if (c === '[') charClass = true;
      else if (c === ']') charClass = false;
      else if (c === '/' && !charClass) regex = false;
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }

    if (c === '/') {
      // A `/` opening an ARGUMENT is a pattern; a `/` after a value is
      // division. Only the first can occur where this scanner is looking.
      const prev = line.slice(openIdx, i).trimEnd().slice(-1);
      if (prev === '' || '(,=:[&|!?+{;'.includes(prev)) regex = true;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Join a call onto its continuation lines until its parens balance, so an
 *  argument the formatter wrapped is still readable as one string. Bounded:
 *  a call that has not closed within a few lines is not one of these. */
function joinCall(lines, index, openIdx) {
  let text = lines[index];
  for (let n = 1; n <= 4; n++) {
    if (endOfCall(text, openIdx) !== -1) break;
    if (index + n >= lines.length) break;
    text += ` ${lines[index + n].trim()}`;
  }
  return { text };
}

/** Collapse the whitespace a wrapped argument carries, so the joined form of a
 *  call keys identically to the single-line form of the same locator. */
const normalizeArg = (s) => s.trim().replace(/\s+/g, ' ');

/** What the line DOES with the locator. Informational only — every row below is
 *  in the population regardless, because a locator bound to a `const` on one
 *  line is asserted or acted on a few lines later, and a per-line classifier
 *  cannot see that. Over-reporting is the safe direction here. */
function usageOf(line, callStart) {
  const before = line.slice(0, callStart);
  if (/\bexpect\(\s*$/.test(before)) return 'expect';
  if (/\b(const|let|var|return)\b|=>\s*$/.test(before)) return 'binding';
  return 'other';
}

const ACTIONS =
  /^\s*\.\s*(click|fill|press|check|uncheck|selectOption|hover|focus|blur|type|tap|dblclick|setInputFiles|scrollIntoViewIfNeeded)\s*\(/;

const files = (
  WORKTREE
    ? git('ls-files', '--cached', '--others', '--exclude-standard', 'tests/e2e')
    : git('ls-tree', '-r', '--name-only', REF, 'tests/e2e')
)
  .split('\n')
  .filter((f) => f.endsWith('.ts'))
  .sort();

const readFile = (path) => (WORKTREE ? readFileSync(path, 'utf8') : git('show', `${REF}:${path}`));

const rows = [];
const alertRows = [];
/** Occurrence counter, so two identical locators in one file get stable,
 *  distinguishable keys. The key is deliberately NOT the line number: a line
 *  number rots the moment anyone inserts a line above it, and MOTIR-5037's
 *  allow-list is asserted tight in both directions — a key that rots turns the
 *  suite red on work that was correct. */
const seen = new Map();

for (const file of files) {
  const src = readFile(file);
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    // The non-role family.
    for (const method of METHODS) {
      const needle = `page.${method}(`;
      let from = 0;
      for (;;) {
        const at = line.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;

        // `page.` must be the whole receiver: `subPage.getByText(` is a
        // different object and is not necessarily page-rooted.
        if (at > 0 && /[\w$.]/.test(line[at - 1])) continue;

        // A call whose argument runs onto the next line still has to yield a
        // STABLE key, so join the continuation rather than recording
        // `<multiline>`: MOTIR-5037 asserts its allow-list tight in both
        // directions, and a placeholder key would rot the first time one of
        // those six sites was re-wrapped by a formatter.
        const open = at + needle.length - 1;
        const joined = joinCall(lines, i, open);
        const end = endOfCall(joined.text, open);
        const arg = end === -1 ? null : normalizeArg(joined.text.slice(open + 1, end - 1));
        const tail = end === -1 ? '' : joined.text.slice(end);

        const resolver = RESOLVERS.find((r) => new RegExp(`^\\s*\\.\\s*${r}\\s*\\(`).test(tail));

        const key = `${file}::${method}::${arg ?? '<multiline>'}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);

        rows.push({
          id: `${key}::${n}`,
          file,
          method,
          arg,
          occurrence: n,
          line: i + 1,
          exempt: resolver ? `.${resolver}()` : null,
          usage: ACTIONS.test(tail) ? 'action' : usageOf(line, at),
          wrapped: joined.text !== line,
          unresolved: end === -1,
        });
      }
    }

    // The FOURTH member of the family, different in mechanism and identical in
    // shape: Radix's `Toast.Provider` keeps an empty `role="alert"` live region
    // mounted for the life of the authed shell, so a PAGE-LEVEL
    // `toHaveCount(0)` against it can never pass.
    let from = 0;
    for (;;) {
      const at = line.indexOf('page.getByRole(', from);
      if (at === -1) break;
      from = at + 15;
      if (at > 0 && /[\w$.]/.test(line[at - 1])) continue;
      const open = at + 14;
      const joined = joinCall(lines, i, open);
      const end = endOfCall(joined.text, open);
      const arg = end === -1 ? null : normalizeArg(joined.text.slice(open + 1, end - 1));
      if (!arg || !/^['"`]alert['"`]/.test(arg)) continue;
      const tail = end === -1 ? '' : joined.text.slice(end);
      alertRows.push({
        file,
        line: i + 1,
        arg,
        narrowed: /^\s*\.\s*(filter|first|nth|last)\s*\(/.test(tail)
          ? tail.trim().slice(0, 40)
          : null,
        isCount: /toHaveCount/.test(line),
      });
    }
  });
}

const byMethod = Object.fromEntries(
  METHODS.map((m) => [
    m,
    {
      total: rows.filter((r) => r.method === m).length,
      ruled: rows.filter((r) => r.method === m && !r.exempt).length,
    },
  ]),
);

const inventory = {
  $schema: 'MOTIR-5035 page-locator inventory',
  generatedBy: 'scripts/enumerate-page-locators.mjs',
  command: WORKTREE
    ? 'node scripts/enumerate-page-locators.mjs --worktree'
    : `node scripts/enumerate-page-locators.mjs --ref ${REF}`,
  // After this file's own pull request has merged, `--ref origin/main`
  // reproduces it exactly; `base` is what it was generated ON TOP of.
  ref: WORKTREE ? 'working tree' : git('rev-parse', REF).trim(),
  base: git('rev-parse', WORKTREE ? 'HEAD' : REF).trim(),
  refName: WORKTREE ? 'working tree' : REF,
  note: [
    'DATED EVIDENCE, not a contract. The PREDICATE is the script named above;',
    'this file is what it returned at the ref named above. Re-run it rather than',
    'hand-editing a row. MOTIR-5037 seeds its allow-list from `rows` and asserts',
    'it tight in both directions, so a row that stops describing the tree must be',
    'REMOVED by whoever fixed the site — which is the ratchet.',
  ].join(' '),
  remedy:
    "getByRole(<role>, { name }) — the accessibility tree excludes the streamed and outgoing copies. Where the node carries no role, scope to a live subtree instead (a dialog, a named region, page.getByRole('main')).",
  filesScanned: files.length,
  filesWithRows: new Set(rows.map((r) => r.file)).size,
  filesWithRuledRows: new Set(rows.filter((r) => !r.exempt).map((r) => r.file)).size,
  totals: {
    rows: rows.length,
    ruled: rows.filter((r) => !r.exempt).length,
    exempt: rows.filter((r) => r.exempt).length,
    wrapped: rows.filter((r) => r.wrapped).length,
    unresolved: rows.filter((r) => r.unresolved).length,
  },
  byMethod,
  alertAudit: {
    finding:
      'ZERO sites to fix, measured rather than assumed. Radix\'s Toast.Provider keeps an EMPTY role="alert" live region mounted for the life of the authed shell, so a page-level toHaveCount(0) against it can never pass. Every count site in the suite is already scoped to a container, several carrying comments that name this fact. The page-rooted uses that remain are .filter({ hasText }) narrowings, which are not counts.',
    pageRootedCounts: alertRows.filter((r) => r.isCount && !r.narrowed).length,
    rows: alertRows,
  },
  rows,
};

const json = `${JSON.stringify(inventory, null, 2)}\n`;
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  process.stderr.write(
    `${rows.length} rows (${inventory.totals.ruled} ruled, ${inventory.totals.exempt} exempt) ` +
      `across ${files.length} files at ${inventory.ref.slice(0, 9)} → ${OUT}\n`,
  );
} else {
  process.stdout.write(json);
}
