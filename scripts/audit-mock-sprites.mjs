#!/usr/bin/env node
/**
 * Audit a design mock's SVG sprite sheet against the installed `lucide-react`
 * (MOTIR-5136 — the fourth drift bug against `design/github`, fixed as a
 * predicate instead of as a reading).
 *
 * WHY A SCRIPT AND NOT A README LINE. Three separate bugs against one asset
 * (MOTIR-5007, MOTIR-5008, MOTIR-5136) were all the same defect: a symbol whose
 * NAME says one icon and whose PATH DATA is a hand drawing of something else.
 * Every one of them was found by a person rendering a panel and looking at it.
 * A hand-typed path is an unmeasured claim, and the ones that get trusted are
 * the ones that look deliberate — so the check has to be a command, not care.
 *
 * THE TEST. For every `<symbol>` in the mock that DECLARES a lucide icon, the
 * symbol's shape list must equal that icon's `__iconNode` in the installed
 * package — same shapes, same order, same attributes (lucide's own `key` is
 * ignored; it is a React reconciliation key, not geometry).
 *
 * HOW A SYMBOL DECLARES ITS ICON: the provenance comment immediately above it,
 *     <!-- lucide `git-merge` — EXTRACTED from the installed `lucide-react@…`
 * which is the convention MOTIR-5008 established and MOTIR-5136 completed. The
 * declaration is what makes this checkable: a symbol's `id` is a HINT and
 * routinely wrong (`#i-x` is `circle-x`; `#i-repo` was drawn as `book` while
 * the shipped nav renders `FolderGit2`), so the audit never guesses from the id.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE — a symbol with no provenance comment is
 * reported as UNDECLARED, not as drift. Brand marks (`#i-github`, `#i-gitlab`)
 * come from each provider's own kit and are not lucide at all, so they are
 * declared with an explicit `NOT-LUCIDE` marker and skipped. An asset is only
 * as good as its declarations, so UNDECLARED is a finding too — it just is not
 * the same finding, and `--strict` is what makes it fail the run.
 *
 * USAGE
 *   node scripts/audit-mock-sprites.mjs design/github/github.mock.html
 *   node scripts/audit-mock-sprites.mjs design/*&#47;*.mock.html --strict
 *
 * Exit 0 = no drift. Exit 1 = at least one symbol disagrees with the package
 * (or, under `--strict`, at least one is undeclared).
 */

/* eslint-disable no-console -- This is a REPORTING script: stdout is its whole
   interface, exactly as for `scripts/scan-e2e-mutation-assert.mjs`, which holds
   the same exemption as a `files` override in `eslint.config.mjs`. It is taken
   here as a file-level comment rather than there because MOTIR-5136 pins its
   diff to `design/github/**` plus this script; if a second reporting script
   under `scripts/` ever wants it, promote both to the shared override. */

import { readFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const ICON_DIR = 'node_modules/lucide-react/dist/esm/icons';

/** Shapes lucide draws with. Anything else in a symbol is not icon geometry. */
const SHAPE_TAGS = ['circle', 'path', 'line', 'polyline', 'rect', 'ellipse', 'polygon'];

/**
 * Normalise one shape to a comparable string.
 *
 * `key` is dropped: it is lucide's React reconciliation key and carries no
 * geometry, so a symbol that omits it (every symbol does) is not drifting.
 * Attributes are sorted so that attribute ORDER — which SVG does not care about
 * and which a hand edit reorders freely — is not reported as a difference.
 */
function normaliseShape([tag, attrs]) {
  const pairs = Object.entries(attrs)
    .filter(([k]) => k !== 'key')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  return `${tag}(${pairs.join(' ')})`;
}

const normalise = (shapes) => shapes.map(normaliseShape);

/**
 * lucide's files are kebab-case (`circle-x.mjs`) but a declaration may name the
 * COMPONENT (`CircleX`, `X`) — both conventions are in the tree, from
 * MOTIR-5008 and MOTIR-5007 respectively. Accept either.
 */
const toKebab = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

function packageShapes(iconName) {
  let file = `${ICON_DIR}/${iconName}.mjs`;
  if (!existsSync(file)) file = `${ICON_DIR}/${toKebab(iconName)}.mjs`;
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const literal = /const __iconNode = (\[[\s\S]*?\]);/.exec(src);
  if (!literal) return null;
  // The literal is data, from a package already on disk and already imported by
  // the app; `eval` is what reads a JS literal as JS without a parser.
  return Function(`"use strict"; return (${literal[1]});`)();
}

/**
 * Pull every `<symbol>` out of the mock, with the lucide name its provenance
 * comment declares (or null when it declares none / declares NOT-LUCIDE).
 */
function readSymbols(html) {
  const out = [];
  const re = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = /id="([^"]+)"/.exec(m[1])?.[1] ?? '(no id)';

    // The provenance comment is the nearest `<!-- … -->` ENDING before this
    // symbol with nothing but whitespace between it and the tag.
    // Walk BACK by index rather than matching a regex over the prefix. A regex
    // anchored with `$` over a 200 KB prefix either finds the FIRST comment in
    // the file (leftmost-match) or, once forced rightward with a greedy prefix,
    // backtracks catastrophically — this audit's own first draft did both.
    const before = html.slice(0, m.index);
    const close = before.lastIndexOf('-->');
    // Only whitespace may sit between the comment and the tag; anything else
    // means this symbol has no provenance comment of its own.
    const text =
      close !== -1 && before.slice(close + 3).trim() === ''
        ? before.slice(before.lastIndexOf('<!--', close) + 4, close)
        : '';
    const notLucide = /NOT-LUCIDE/.test(text);
    // ⚠️ ANCHOR TO THE COMMENT'S OPENING. A provenance comment routinely names
    // OTHER icons in its prose — `#i-close`'s explains at length that it is not
    // `#i-x`, "which is lucide `circle-x`" — so a first-match search reads the
    // neighbour's name and reports a drift that is not there. The declaration
    // is the opening clause and nothing else.
    const declared = /^\s*lucide\s+`([A-Za-z0-9-]+)`/.exec(text)?.[1] ?? null;

    const shapes = [];
    const tagRe = new RegExp(`<(${SHAPE_TAGS.join('|')})\\b([^>]*?)/?>`, 'g');
    let t;
    while ((t = tagRe.exec(m[2]))) {
      const attrs = {};
      // Attribute names carry digits (`x1`, `y2`) — a name class without them
      // silently drops those attributes and makes a matching symbol look like
      // a mismatch, which is how this audit's own first draft mis-read
      // `#i-card`.
      const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(t[2]))) attrs[a[1]] = a[2];
      shapes.push([t[1], attrs]);
    }
    out.push({ id, declared, notLucide, shapes });
  }
  return out;
}

function auditFile(path, { strict }) {
  const html = readFileSync(path, 'utf8');
  const symbols = readSymbols(html);
  const drift = [];
  const undeclared = [];
  let checked = 0;
  let skipped = 0;

  for (const sym of symbols) {
    if (sym.notLucide) {
      skipped += 1;
      continue;
    }
    if (!sym.declared) {
      undeclared.push(sym);
      continue;
    }
    const pkg = packageShapes(sym.declared);
    if (!pkg) {
      drift.push({ ...sym, reason: `no such icon in the installed package: \`${sym.declared}\`` });
      continue;
    }
    checked += 1;
    const mine = normalise(sym.shapes);
    const theirs = normalise(pkg);
    if (mine.join('|') !== theirs.join('|')) {
      drift.push({ ...sym, reason: 'shape data differs from the package', mine, theirs });
    }
  }

  console.log(`\n${path}`);
  console.log(
    `  ${symbols.length} symbols · ${checked} checked against lucide-react · ` +
      `${skipped} declared NOT-LUCIDE · ${undeclared.length} undeclared · ${drift.length} DRIFTED`,
  );

  for (const d of drift) {
    console.log(`\n  ✗ ${d.id} — declared lucide \`${d.declared}\`: ${d.reason}`);
    if (d.mine) {
      console.log(`      mock:    ${d.mine.join('\n               ')}`);
      console.log(`      package: ${d.theirs.join('\n               ')}`);
    }
  }
  for (const u of undeclared) {
    console.log(`  ? ${u.id} — no provenance comment; cannot be audited`);
  }

  return drift.length > 0 || (strict && undeclared.length > 0);
}

const args = argv.slice(2);
const strict = args.includes('--strict');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('usage: node scripts/audit-mock-sprites.mjs <mock.html>... [--strict]');
  exit(2);
}
if (!existsSync(ICON_DIR)) {
  console.error(
    `lucide-react is not installed (${ICON_DIR} is missing) — run \`pnpm install\` first.`,
  );
  exit(2);
}

let failed = false;
for (const f of files) failed = auditFile(f, { strict }) || failed;
console.log('');
exit(failed ? 1 : 0);
