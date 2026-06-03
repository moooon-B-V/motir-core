import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Single-source-of-truth guard (Subtask 2.3.5): the react-markdown render
// pipeline (react-markdown + remark-gfm + rehype-sanitize + rehype-highlight)
// must live in EXACTLY ONE module — `lib/markdown/render.tsx`. Every render
// surface (MarkdownView, the editor's live preview, the issue detail page)
// composes that module's `renderMarkdown`, so the editing preview and the read
// surface can never drift. This test fails if any other source file imports
// `react-markdown` directly, which would re-introduce a second pipeline.

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'components', 'lib'];
const THE_ONE_MODULE = join('lib', 'markdown', 'render.tsx');
const IMPORT_RE = /\bfrom\s+['"]react-markdown['"]/;

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

describe('markdown render pipeline is a single source of truth', () => {
  it('only lib/markdown/render.tsx imports react-markdown directly', () => {
    const offenders = SCAN_DIRS.flatMap((d) => collectSourceFiles(join(ROOT, d)))
      .filter((file) => IMPORT_RE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));

    expect(offenders).toEqual([THE_ONE_MODULE]);
  });
});
