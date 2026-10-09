import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// GUARD — THE OVERLAY ADDRESS HAS ONE AUTHOR (Story MOTIR-7883 · MOTIR-7892).
//
// Every door to an undecided plan lands on the planning overlay over its own
// conversation, and that address — the `planSession` parameter — is composed in
// exactly one place: `withPlanningOverlay` in `lib/planning/launcher.ts`, which
// reads the parameter's name from `OVERLAY_PARAM_NAMES.session`. Every other door
// asks `planRowDestination` / `planSessionLaunchContext`, which ask the launcher.
//
// The failure this exists to stop is quiet: a later change hand-writes
// `?planSession=${id}` (or `params.set('planSession', id)`) at one call site. It
// works on the day it lands, and then drifts — the next change to the address
// (a renamed parameter, a new companion like `planVia`) reaches every door but
// that one, and no unit test of the rule can see it.
//
// WHAT IT SCANS: `app/`, `components/`, `lib/` — `.ts` / `.tsx` — with comments
// removed by a small lexer (so the prose that NAMES the parameter, of which there
// is plenty, is not a finding). Inside string and template literals it fails on:
//   · `planSession=` — a hand-built query string;
//   · a literal `'planSession'` used as a search-param KEY — `.set(` / `.append(`'s
//     first argument, or an object key (`{ 'planSession': … }`);
// and, in code, a bare `planSession:` key inside `new URLSearchParams({ … })`.
// It also fails if the launcher stops DEFINING the mapping, so the guard cannot
// pass vacuously because the one author moved.
//
// A READ of the parameter (`searchParams.get('planSession')`) is not a build and
// is not flagged. TEST FILES ARE OUT OF SCOPE on purpose: a test asserts on the
// address, and spelling it out is how it does
// (`tests/integration/planning/surfaceArrivalGate.test.tsx`).
//
// Measured on 2026-10-08 (`git grep -n "planSession" origin/main -- app components
// lib`): every non-launcher hit is a comment, so the guard is green on the base.

const ROOT = resolve(__dirname, '../..');
const SCANNED = ['app', 'components', 'lib'] as const;
const AUTHOR = 'lib/planning/launcher.ts';
const PARAM = 'planSession';

/** A string or template literal's text, with the line it opens on. */
interface Literal {
  text: string;
  line: number;
  /** The code immediately before the opening quote (same statement, comments removed). */
  before: string;
  /** The code immediately after the closing quote. */
  after: string;
}

/**
 * Split TypeScript source into CODE (comments removed, literals kept as `""`
 * placeholders) and its LITERALS. Not a parser — a regex literal containing a
 * quote or `//` can confuse it — but it is correct for comments vs. strings,
 * which is the one distinction this guard depends on, and the self-tests below
 * pin both directions of it.
 */
export function lex(source: string): { code: string; literals: Literal[] } {
  let code = '';
  const literals: Literal[] = [];
  let line = 1;
  let i = 0;
  // Template nesting: each entry is the brace depth at which a `${` opened.
  const templateStack: number[] = [];
  let braceDepth = 0;

  const readQuoted = (quote: string): string => {
    let text = '';
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        text += source[i]! + (source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (source[i] === '\n') line += 1;
      text += source[i];
      i += 1;
    }
    i += 1;
    return text;
  };

  /** Read template text from `i` up to the closing backtick or the next `${`. */
  const readTemplateChunk = (): { text: string; opensExpr: boolean } => {
    let text = '';
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\\') {
        text += ch + (source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        return { text, opensExpr: false };
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        return { text, opensExpr: true };
      }
      if (ch === '\n') line += 1;
      text += ch;
      i += 1;
    }
    return { text, opensExpr: false };
  };

  const pending: Array<{ index: number; start: number }> = [];
  const pushLiteral = (text: string, startLine: number) => {
    literals.push({ text, line: startLine, before: code.slice(-80), after: '' });
    pending.push({ index: literals.length - 1, start: code.length + 2 });
    code += '""';
  };

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      code += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      pushLiteral(readQuoted(ch), startLine);
      continue;
    }
    if (ch === '`' || (ch === '}' && templateStack.at(-1) === braceDepth)) {
      if (ch === '}') templateStack.pop();
      const startLine = line;
      i += 1;
      const chunk = readTemplateChunk();
      pushLiteral(chunk.text, startLine);
      if (chunk.opensExpr) templateStack.push(braceDepth);
      continue;
    }
    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    if (ch === '\n') line += 1;
    code += ch;
    i += 1;
  }
  for (const { index, start } of pending) literals[index]!.after = code.slice(start, start + 40);
  return { code, literals };
}

/** Every way this source hand-builds the `planSession` address, as `line: tell`. */
export function findAddressBuilds(source: string): string[] {
  const { code, literals } = lex(source);
  const out: string[] = [];
  for (const lit of literals) {
    if (lit.text.includes(`${PARAM}=`)) {
      out.push(`${lit.line}: a literal containing \`${PARAM}=\``);
      continue;
    }
    if (lit.text !== PARAM) continue;
    if (/\.(set|append)\(\s*$/.test(lit.before) && /^\s*,/.test(lit.after)) {
      out.push(`${lit.line}: '${PARAM}' set as a search-param key`);
    } else if (/^\s*:/.test(lit.after)) {
      out.push(`${lit.line}: '${PARAM}' used as an object key`);
    }
  }
  if (new RegExp(`URLSearchParams\\(\\s*\\{[^}]*\\b${PARAM}\\s*:`).test(code)) {
    out.push(`a \`${PARAM}:\` key inside new URLSearchParams({ … })`);
  }
  return out;
}

/** Every `.ts` / `.tsx` file under the scanned roots, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

const FILES = SCANNED.flatMap((d) => walk(join(ROOT, d)));

describe('the overlay address has ONE author', () => {
  it('scans the tree it means to (a walk that finds nothing passes vacuously)', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain(AUTHOR);
    expect(FILES).toContain('lib/planning/planDestination.ts');
    expect(FILES).toContain('components/planning/PlanOverlayDoor.tsx');
  });

  it('nothing outside `lib/planning/launcher.ts` builds the `planSession` parameter', () => {
    const findings: string[] = [];
    for (const file of FILES) {
      if (file === AUTHOR) continue;
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (!source.includes(PARAM)) continue;
      for (const f of findAddressBuilds(source)) findings.push(`${file}:${f}`);
    }
    expect(
      findings,
      'compose the overlay address through withPlanningOverlay / planRowDestination',
    ).toEqual([]);
  });

  it('the launcher still DEFINES the mapping `session: "planSession"`', () => {
    const { code, literals } = lex(readFileSync(join(ROOT, AUTHOR), 'utf8'));
    expect(code).toMatch(/\bsession:\s*""/);
    const mapping = literals.find((l) => l.text === PARAM && /\bsession:\s*$/.test(l.before));
    expect(mapping, `${AUTHOR} maps \`session\` to '${PARAM}'`).toBeDefined();
  });
});

describe('the guard itself (self-test on in-memory fixtures)', () => {
  it('fails a hand-built query string in a template literal', () => {
    const src = 'const href = `/plans?planSession=${id}`;\n';
    expect(findAddressBuilds(src)).toEqual([`1: a literal containing \`planSession=\``]);
  });

  it('fails `params.set("planSession", id)` and `.append`', () => {
    expect(findAddressBuilds("params.set('planSession', id);")).toEqual([
      "1: 'planSession' set as a search-param key",
    ]);
    expect(findAddressBuilds('q.append("planSession", sessionId);')).toEqual([
      "1: 'planSession' set as a search-param key",
    ]);
  });

  it('fails a quoted object key and a bare key inside new URLSearchParams', () => {
    expect(findAddressBuilds("const q = { 'planSession': id };")).toEqual([
      "1: 'planSession' used as an object key",
    ]);
    expect(
      findAddressBuilds('const q = new URLSearchParams({ plan: "project", planSession: id });'),
    ).toEqual(['a `planSession:` key inside new URLSearchParams({ … })']);
  });

  it('fails a plain string with the parameter, and a template chunk after an expression', () => {
    expect(findAddressBuilds("const h = '/x?plan=project&planSession=' + id;")).toEqual([
      '1: a literal containing `planSession=`',
    ]);
    expect(findAddressBuilds('const h = `/x?plan=${mode}&planSession=${id}`;')).toEqual([
      '1: a literal containing `planSession=`',
    ]);
  });

  it('passes the same shapes when they are COMMENTED, and a READ of the parameter', () => {
    const src = [
      '// const href = `/plans?planSession=${id}`;',
      "/* params.set('planSession', id); */",
      '/**',
      " * `planSession=<id>` — written by the launcher, read by params.get('planSession')",
      ' */',
      "const id = searchParams.get('planSession');",
      'const url = "http://example.com"; // a trailing comment: planSession=',
    ].join('\n');
    expect(findAddressBuilds(src)).toEqual([]);
  });

  it('reports the line a finding is on', () => {
    const src = "const a = 1;\n// planSession=\nconst b = 2;\nparams.set('planSession', b);\n";
    expect(findAddressBuilds(src)).toEqual(["4: 'planSession' set as a search-param key"]);
  });
});
