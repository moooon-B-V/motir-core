import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, specifiersOf, stripComments, stripTypeOnlyImports } from './importGraph';

// MOTIR-2461 — the walker's own behaviour, tested directly for the first time.
//
// `specifiersOf` is the primitive under both database-reach guards
// (`tests/root-layout-db-imports.test.ts`, `tests/public-docs-db-imports.test.ts`).
// Neither exercises it: they walk the app's real import graph and take the
// walker's word for the answer. So its two failure directions were never
// separated, and they are NOT symmetric:
//
//   * OVER-reporting is safe. A specifier the walker invents blocks a clean
//     file — visibly, on a red build somebody has to look at.
//   * UNDER-reporting is not. A specifier the walker loses ships a database
//     client to an anonymous reader and the guard stays green about it.
//
// The defect this file was written for is an over-report: comments were never
// stripped, so MOTIR-2458 documenting the import it had just removed re-flagged
// the file that removed it. The fix is a comment stripper, and a comment
// stripper is exactly the kind of change that can trade the safe direction for
// the unsafe one — an unterminated string swallows the rest of the file and
// every import after it disappears silently. That is why the false-NEGATIVE
// cases below outnumber the bug's own reproduction, and why the last test in
// this file re-checks the property over every real source file in the repo
// rather than over a fixture.

/** Assemble a fixture from lines — the newlines are load-bearing here. */
const source = (...lines: string[]): string => lines.join('\n');

describe('specifiersOf — a COMMENT is not an import (MOTIR-2461)', () => {
  it('reports a file documenting the import it REMOVED as clean — the reported bug', () => {
    // The shape of `lib/api/v1/ready/schema.ts` after MOTIR-2458: the runtime
    // Prisma import is gone and the comment above the replacement says so,
    // quoting the removed statement verbatim.
    const fixture = source(
      "import { z } from 'zod/v4';",
      '',
      '// These two vocabularies come from the DTO unions above, NOT from the',
      '// generated Prisma enums. This file used to carry',
      "//   import { WorkItemKind } from '@/generated/prisma/client';",
      '// which is a runtime VALUE, so it pulled the whole client into every',
      '// module graph reaching this file (MOTIR-2458).',
      'const KIND_VALUES = new Set<string>(READY_KINDS);',
    );

    expect(specifiersOf(fixture)).toEqual(['zod/v4']);
  });

  it('ignores a specifier quoted inside a BLOCK comment', () => {
    const fixture = source(
      '/**',
      " * Removed: `import { db } from '@/lib/db';` — this route is static.",
      ' */',
      "export { renderDocs } from './render';",
    );

    expect(specifiersOf(fixture)).toEqual(['./render']);
  });

  it('ignores a whole commented-out import BLOCK, side-effect form included', () => {
    const fixture = source(
      "// import '@/lib/db';",
      "/* import { prisma } from '@prisma/client'; */",
      "import { cache } from 'react';",
    );

    expect(specifiersOf(fixture)).toEqual(['react']);
  });

  it('strips a block comment WITHOUT shifting the lines around it', () => {
    const fixture = source(
      "import { a } from './a';",
      '/* one',
      '   two',
      '   three */',
      "import { b } from './b';",
    );
    const stripped = stripComments(fixture);

    expect(stripped.split('\n')).toHaveLength(fixture.split('\n').length);
    expect(stripped).toHaveLength(fixture.length);
    // The surviving code sits on exactly the lines it started on.
    expect(stripped.split('\n')[0]).toBe("import { a } from './a';");
    expect(stripped.split('\n')[4]).toBe("import { b } from './b';");
    expect(stripped.split('\n').slice(1, 4).join('').trim()).toBe('');
  });
});

describe('specifiersOf — what a comment stripper must NOT eat', () => {
  it('does not treat // inside a STRING literal as a comment', () => {
    const fixture = source(
      "const DOCS = 'https://motir.co/docs/api';",
      'const PROTOCOL_RELATIVE = "//cdn.example.com/app.js";',
      "import { db } from '@/lib/db';",
    );

    // Either quote opening a comment would erase the rest of its line; the
    // import three lines down is what proves nothing ran away.
    expect(specifiersOf(fixture)).toEqual(['@/lib/db']);
    expect(stripComments(fixture)).toBe(fixture);
  });

  it('does not treat // inside a TEMPLATE literal as a comment', () => {
    const fixture = source(
      'const href = `https://motir.co/w/${slug}/items`;',
      "import { db } from '@/lib/db';",
    );

    expect(specifiersOf(fixture)).toEqual(['@/lib/db']);
    expect(stripComments(fixture)).toBe(fixture);
  });

  // ── The false-NEGATIVE direction — the criterion that matters most ────────
  //
  // Each fixture below ends with a real import on its LAST line. If the
  // preceding line opens a string the scanner never closes, that import
  // vanishes and the guard goes quiet about a database client. Asserting the
  // last line, specifically, is what makes these tests worth having.

  it('an APOSTROPHE in comment prose does not swallow the rest of the file', () => {
    const fixture = source(
      "// The client's enums are the upstream authority; don't import them here.",
      '/* It isn’t obvious, and that’s the whole problem with this one. */',
      "// You can't tell a value import from a type import by looking.",
      "import { db } from '@/lib/db';",
    );

    expect(specifiersOf(fixture)).toEqual(['@/lib/db']);
  });

  it('a QUOTE inside a regex character class does not swallow the rest of the file', () => {
    const fixture = source(
      'const QUOTED = /[\'"]([^\'"]+)[\'"]/g;',
      'const NOT_A_COMMENT = /\\/\\/ still a regex/;',
      'const DIVISION = total / 2;',
      "import { db } from '@/lib/db';",
    );

    expect(specifiersOf(fixture)).toEqual(['@/lib/db']);
  });

  it('an UNTERMINATED quote cannot reach past its own line', () => {
    // A lone quote in code is a syntax error, not a string that spans lines —
    // so the scanner must give up on it at the newline rather than treat every
    // following line as string content. This is the firewall that keeps a
    // scanner bug bounded to one line instead of one file.
    const fixture = source("const broken = 'oops", "import { db } from '@/lib/db';");

    expect(specifiersOf(fixture)).toContain('@/lib/db');
  });

  it('leaves a file with no comments at all byte-for-byte unchanged', () => {
    const fixture = source(
      "import { z } from 'zod/v4';",
      "import { db } from '@/lib/db';",
      'export const schema = z.object({});',
    );

    expect(stripComments(fixture)).toBe(fixture);
    expect(specifiersOf(fixture)).toEqual(['zod/v4', '@/lib/db']);
  });

  it('still reports every form the two guards depend on', () => {
    const fixture = source(
      "import { db } from '@/lib/db';",
      "import '@/lib/instrumentation';",
      "export { toDto } from '@/lib/mappers/readyMappers';",
      "export * from './shared';",
    );

    expect(specifiersOf(fixture).sort()).toEqual(
      ['./shared', '@/lib/db', '@/lib/instrumentation', '@/lib/mappers/readyMappers'].sort(),
    );
  });

  it('does NOT see a dynamic `import(…)` — pinned as it is, not as it should be', () => {
    // Pre-existing and NOT introduced here: both specifier patterns require
    // whitespace after `import`, and `import('…')` has a parenthesis. A lazily
    // imported module IS traced into the bundle, so this is the unsafe
    // direction — but widening the walk changes what both guards report and is
    // its own card (MOTIR-2484), not a passenger on a comment-stripping fix.
    //
    // It is pinned rather than left undocumented because MOTIR-2461's repo
    // sweep is what found it: `app/api/%5Ftest/work-items/route.ts` dynamically
    // imports `react-dom/server` on line 95, and the ONLY reason the walker
    // ever reported that specifier was the comment on line 86 describing it.
    expect(specifiersOf("const lazy = await import('@/lib/heavy');")).toEqual([]);
  });

  it('still strips `import type`, and does not strip the value import beside it', () => {
    const fixture = source(
      "import type { ReadyItemDto } from '@/lib/dto/ready';",
      "import { db } from '@/lib/db';",
    );

    expect(specifiersOf(fixture)).toEqual(['@/lib/db']);
  });
});

/** Every `.ts`/`.tsx` file under `dir`, repo-relative. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        out.push(relative(REPO_ROOT, full).split('\\').join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, dir));
  return out.sort();
}

/**
 * The pre-MOTIR-2461 walk — everything `specifiersOf` does EXCEPT stripping
 * comments, so a difference between this and the shipped walk is attributable
 * to the comment stripper and to nothing else. `import type` is erased here
 * too: it was always dropped deliberately and is not what is under test.
 *
 * Each hit carries its OFFSET, because the question below is not "does this
 * specifier appear in code somewhere" — a module named in a comment is usually
 * also imported for real three lines up — but "was THIS occurrence code".
 */
function matchesBeforeTheFix(source_: string): {
  code: string;
  hits: Array<{ specifier: string; index: number }>;
} {
  // ⚠️ The offsets are into THIS string, not into `source_` — stripping the
  // type-only imports deletes text and shifts everything after it. Returning
  // the two together is what keeps the caller from reading an index against
  // the wrong string, which is a mistake worth one extra field to prevent.
  const code = stripTypeOnlyImports(source_);
  const hits: Array<{ specifier: string; index: number }> = [];
  for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
    hits.push({ specifier: match[1]!, index: match.index });
  }
  for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    hits.push({ specifier: match[1]!, index: match.index });
  }
  return { code, hits };
}

/**
 * Whether the character at `index` sits on a comment-PREFIXED line — a cheap
 * read of "this is prose", independent of the scanner under test. Deliberately
 * conservative: it recognises only the line shapes a comment block actually
 * takes, so anything else counts as code and has to survive the strip.
 */
function onACommentLine(source_: string, index: number): boolean {
  const lineStart = source_.lastIndexOf('\n', index) + 1;
  const lineEnd = source_.indexOf('\n', index);
  const line = source_.slice(lineStart, lineEnd === -1 ? source_.length : lineEnd).trimStart();
  return line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');
}

describe('specifiersOf over the REAL repo — no import disappears, none is invented', () => {
  // A fixture proves the stripper handles the cases somebody thought of. This
  // runs it over every source file the product actually ships, which is the
  // only way to find the case nobody thought of — and it is the false-negative
  // axis, so it is worth the second or two it costs.
  const files = ['app', 'lib', 'components'].flatMap(sourceFilesUnder);

  it('walks a non-trivial file set — an empty sweep would pass for the wrong reason', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('never LOSES a specifier written on a code line', () => {
    const lost: string[] = [];

    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const after = new Set(specifiersOf(text));
      const { code, hits } = matchesBeforeTheFix(text);
      for (const { specifier, index } of hits) {
        if (after.has(specifier)) continue;
        // Dropped — legitimate only if this occurrence was itself prose.
        if (onACommentLine(code, index)) continue;
        lost.push(`${file} → ${specifier}`);
      }
    }

    expect(
      lost,
      'The comment stripper removed a specifier that is quoted on a code line. That is the ' +
        'UNSAFE failure direction: a route can now reach the Prisma client with both database-' +
        'reach guards green. Fix the scanner — do not relax this assertion.',
    ).toEqual([]);
  });

  it('never INVENTS a specifier the raw source does not contain', () => {
    const invented: string[] = [];

    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      const before = new Set(matchesBeforeTheFix(text).hits.map((hit) => hit.specifier));
      for (const specifier of specifiersOf(text)) {
        if (!before.has(specifier)) invented.push(`${file} → ${specifier}`);
      }
    }

    // Stripping can only ever remove. Anything new means the scanner spliced
    // two unrelated fragments together, which would misdirect a real failure.
    expect(invented).toEqual([]);
  });

  it('leaves every source file the same LENGTH — the stripper only blanks', () => {
    const resized = files.filter((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      return stripComments(text).length !== text.length;
    });

    // Length preservation is what keeps a reported line/column honest, and it
    // is a strong shape check on the scanner: a run that deletes rather than
    // blanks is a run that can join two lines into a specifier neither had.
    expect(resized).toEqual([]);
  });
});
