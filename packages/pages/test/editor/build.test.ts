import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The built package's client boundary (MOTIR-7275): ONLY the editor's outputs
// open with `'use client'`, and the barrel reaches the editor through them
// rather than bundling it, so a server import of the barrel stays server code.
// Reads `dist/`, which the `pages` CI job builds before it tests (and the
// repository's postinstall builds too).

const dist = (file: string) => join(__dirname, '..', '..', 'dist', file);
const read = (file: string) => readFileSync(dist(file), 'utf8');
const directive = /^(?:"use strict";\s*)?["']use client["'];/;

describe.runIf(existsSync(dist('editor.js')))('the build', () => {
  it('marks the editor entry, in both formats, as client', () => {
    expect(read('editor.js')).toMatch(directive);
    expect(read('editor.cjs')).toMatch(directive);
  });

  it('leaves the barrel unmarked and pointing at the editor entry', () => {
    expect(read('index.js')).not.toMatch(/["']use client["']/);
    expect(read('index.cjs')).not.toMatch(/["']use client["']/);
    expect(read('index.js')).toContain('from "./editor.js"');
    expect(read('index.cjs')).toContain('require("./editor.cjs")');
    // The editor's code is not copied into the barrel.
    expect(read('index.js')).not.toContain('useEditor');
  });
});
