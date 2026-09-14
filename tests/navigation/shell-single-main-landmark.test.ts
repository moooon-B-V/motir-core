import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SHELL_ROOT, findMainLandmarks, scanShellMainLandmarks } from './mainLandmarkScan';

// MOTIR-5432 — the signed-in document has exactly ONE `main` landmark.
//
// `AppLayout` owns it: `<main id="main" tabIndex={-1}>`, the skip-link's target,
// wrapped around every page under `app/(authed)/`. The work item page rendered
// its content column as a second `<main>` inside that one, so a screen reader
// offered two "main content" regions and `page.getByRole('main')` matched two
// elements — found as a strict-mode violation in an acceptance spec, where it
// had quietly been worked around by scoping to a card instead.
//
// Nothing caught it before because nothing COULD: the page compiles, renders
// correctly, and every E2E locator that chains THROUGH `main` still resolves
// (the shell's `main` contains the inner one, so the union is the same
// subtree). Only an assertion on the landmark itself goes red, and no suite
// made one. This guard makes it, statically, for every page in the shell.

const REPO_ROOT = resolve(__dirname, '..', '..');

const describeSite = (s: ReturnType<typeof findMainLandmarks>[number]) =>
  `${s.file}:${s.line} ${s.form === 'element' ? '<main>' : 'role="main"'}`;

describe('the signed-in shell renders ONE main landmark (MOTIR-5432)', () => {
  const { files, sites } = scanShellMainLandmarks(REPO_ROOT);

  it('reads the shell at all, and AppLayout still owns the landmark (a guard over nothing proves nothing)', () => {
    expect(files).toBeGreaterThan(100);
    const layout = 'components/ui/AppLayout.tsx';
    expect(findMainLandmarks(readFileSync(resolve(REPO_ROOT, layout), 'utf8'), layout)).toEqual([
      expect.objectContaining({ file: layout, form: 'element' }),
    ]);
  });

  it(`no file under ${SHELL_ROOT} renders a second main landmark`, () => {
    expect(
      sites.map(describeSite),
      'AppLayout (components/ui/AppLayout.tsx) already renders this document\'s `<main id="main">` ' +
        `around every page under ${SHELL_ROOT}. A second one gives assistive tech two main regions ` +
        "and makes `page.getByRole('main')` ambiguous. Render the column as a `<div>` and keep its " +
        'layout classes (the work item page is the worked example). See MOTIR-5432.',
    ).toEqual([]);
  });

  // ⚠️ Proven by feeding it the violation — a guard never shown to fail is
  // indistinguishable from no guard.
  describe('fires on every way to spell a main landmark', () => {
    it('the shape that shipped: a content column rendered as <main>', () => {
      const src = `
        export default function Page() {
          return (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
              <main className="flex min-w-0 flex-col gap-6">body</main>
              <aside>rail</aside>
            </div>
          );
        }`;
      expect(findMainLandmarks(src, 'fixture/page.tsx')).toEqual([
        { file: 'fixture/page.tsx', line: 5, form: 'element' },
      ]);
    });

    it('role="main" on another element, in either attribute form', () => {
      const src = `
        export function A() { return <div role="main">a</div>; }
        export function B() { return <section role={'main'} />; }`;
      expect(findMainLandmarks(src, 'fixture/roles.tsx').map((s) => s.form)).toEqual([
        'role',
        'role',
      ]);
    });
  });

  describe('does NOT fire on what is not a landmark', () => {
    it('a comment or a string that names <main>, a Main component, and other roles', () => {
      const src = `
        // the first child of <main>, above Description
        export function Page({ Main }) {
          return (
            <div className="min-w-0" data-note="<main> is the shell's">
              {/* sits inside the shell's <main> */}
              <Main />
              <aside role="complementary" />
              <nav role="navigation" />
            </div>
          );
        }`;
      expect(findMainLandmarks(src, 'fixture/quiet.tsx')).toEqual([]);
    });
  });
});
