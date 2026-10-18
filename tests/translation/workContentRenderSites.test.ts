import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../helpers/stripSourceComments';
import { WORK_CONTENT_RENDER_SITES } from '@/lib/translation/renderSites';

// Story MOTIR-7738 · MOTIR-8834 — the guard behind `lib/translation/renderSites.ts`.
// A file that draws a title beside a work item key must be on the list, and a
// `covered` entry must import the title-translation machinery.

const ROOT = join(__dirname, '..', '..');
const KIT = /titleTranslation\/|SurfaceTitleTranslation|surfaceTranslation/;
const TITLE_JSX = /\{[A-Za-z.?]*\.title\}/;
const KEY = /\.identifier|workItemKey/;

/** The files in `files` (path → source) that draw a title next to a key. */
export function titleRenderSites(files: Record<string, string>): string[] {
  return Object.keys(files).filter((file) => {
    const code = stripSourceComments(files[file] ?? '');
    return TITLE_JSX.test(code) && KEY.test(code) && !file.includes('titleTranslation/');
  });
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

describe('work-content render sites', () => {
  const registered = new Set(WORK_CONTENT_RENDER_SITES.map((s) => s.file));

  it('finds a title drawn beside a key and flags it when unregistered (fixture)', () => {
    const fixture = {
      'app/(authed)/new/Row.tsx':
        'export const R = ({ item }) => <b>{item.identifier} {item.title}</b>;',
      'app/(authed)/new/Plain.tsx': 'export const P = ({ item }) => <b>{item.name}</b>;',
    };
    const found = titleRenderSites(fixture);
    expect(found).toEqual(['app/(authed)/new/Row.tsx']);
    expect(found.filter((f) => !registered.has(f))).toEqual(['app/(authed)/new/Row.tsx']);
  });

  it('every file that draws a title beside a key is on the list', () => {
    const listed = execSync('git ls-files "app/**/*.tsx" "components/**/*.tsx"', {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
    const files: Record<string, string> = {};
    for (const f of listed) files[f] = read(f);
    const missing = titleRenderSites(files).filter((f) => !registered.has(f));
    expect(
      missing,
      `unregistered title render sites — add them to lib/translation/renderSites.ts`,
    ).toEqual([]);
  });

  it('every entry names a file that exists, and a covered one imports the kit', () => {
    for (const site of WORK_CONTENT_RENDER_SITES) {
      const source = read(site.file);
      if (site.status === 'covered') {
        expect(KIT.test(source), `${site.file} is marked covered but does not use the kit`).toBe(
          true,
        );
      }
      expect(site.why.length).toBeGreaterThan(8);
    }
  });
});
