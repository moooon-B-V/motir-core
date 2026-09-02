import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// MOTIR-4084 — the NAMED `max-w-*` STEP, at zero.
//
// ── The defect this exists to prevent ───────────────────────────────────────
// `packages/design-system/theme.css` declares the `--spacing-*` NAMESPACE inside
// its `@theme` block (`--spacing-xs: 8px`, `--spacing-sm: 12px`,
// `--spacing-md: 16px`, …). Tailwind v4 resolves `max-w-<name>` against that
// namespace in preference to the default `--container-<name>`, so a named step
// emits a rule whose value is a SPACING token — pixels, not the container width
// the class name suggests. Measured by compiling `app/globals.css` through
// `tailwindcss`'s own `compile()` (the measurement lives in
// `tests/theme/maxWidthResolution.test.ts`, which asserts it):
//
//   .max-w-xs  { max-width: var(--spacing-xs)  }   →   8px
//   .max-w-sm  { max-width: var(--spacing-sm)  }   →  12px
//   .max-w-md  { max-width: var(--spacing-md)  }   →  16px
//   .max-w-lg  { max-width: var(--spacing-lg)  }   →  20px
//   .max-w-xl  { max-width: var(--spacing-xl)  }   →  24px
//   .max-w-2xl { max-width: var(--spacing-2xl) }   →  32px
//   .max-w-3xl { max-width: var(--spacing-3xl) }   →  40px
//
// A paragraph capped at 16px wraps one word per line and each word overflows its
// box. Nothing errors: it type-checks, it lints, the component tests that assert
// the copy is PRESENT still pass, and the result is a plausible-looking narrow
// column rather than a failure. It had shipped on five surfaces when this guard
// was written, the reported one being the run section's empty state on the
// work-item page.
//
// ── Why the ban covers `4xl`–`7xl` too, which are CORRECT today ─────────────
// Measured on the same build: `max-w-4xl` … `max-w-7xl` emit
// `var(--container-4xl)` … `var(--container-7xl)` — the stock 56rem–80rem —
// because the `--spacing-*` namespace happens to stop at `3xl`. So four of the
// eleven steps are fine and seven are broken, and which is which is a fact about
// how far one namespace happens to extend. Adding `--spacing-4xl` — an ordinary
// thing to do to a spacing scale — silently collapses every `max-w-4xl` in the
// tree. The class of defect is the NAMED STEP, not the seven that are wrong now.
//
// ── Why not fix the theme instead: SETTLED, and it does not work ────────────
// The obvious remedy is to declare the container scale explicitly and let it win
// the lookup back. It does not: compiling `app/globals.css` with
// `@theme { --container-sm: 24rem; --container-md: 28rem }` appended still emits
// `.max-w-sm { max-width: var(--spacing-sm) }` and
// `.max-w-md { max-width: var(--spacing-md) }`. The spacing namespace shadows the
// container namespace whether the latter is defaulted or declared, so there is no
// theme-level fix to reach for and the arbitrary value is the remedy:
// `max-w-[28rem]`, `max-w-[24rem]`, `max-w-[20rem]`.
//
// ── Why a GUARD rather than five edits ─────────────────────────────────────
// The tree already carried five code comments explaining this trap — in
// `app/(auth)/layout.tsx`, `app/(authed)/reports/_components/ReportPageChrome.tsx`,
// `app/tokens/markdown-editor/page.tsx`, `components/planning/PlanEditsLauncher.tsx`
// and `packages/design-system/src/components/ui/Modal.tsx` — and every one of them
// sits on a line that is already correct. None is anywhere a person writing
// `max-w-md` for the first time would look. The trap had been met three times
// (the reports page, the plan-edits review dock, the run section) and the remedy
// each time was another comment on the fixed site.
//
// ── COMMENTS ARE NOT CODE, and here that is load-bearing ───────────────────
// Those five comments NAME the class they warn about, so a guard built on a raw
// `grep` would fail on the documentation that exists to prevent the defect —
// and the only way to make it pass would be to blunt the warnings into
// uselessness. The scan therefore reads `stripComments`'d source, the same
// scanner `tests/hosting/abandonedPathGuard.ts` uses for the same reason. It
// blanks comments to SPACES, so reported line numbers stay true.
//
// ── The scope, and what is deliberately outside it ─────────────────────────
// `app/`, `components/` and `packages/design-system/src/` — everything that
// compiles against this `@theme`. `design/**` is NOT scanned: a `*.mock.html`
// ships its own inlined vanilla stylesheet (`.max-w-md { max-width: 28rem }`),
// which is unaffected by the namespace and is why the mock renders correctly
// while the app does not. Nor is `lib/`, which paints nothing.

const SCAN_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/**
 * A named `max-w-*` step, as it appears in a class list.
 *
 * The leading and trailing guards are what let a VARIANT through the front door
 * (`sm:max-w-md`, `group-hover:max-w-lg` — the `:` is not a word character, so
 * the utility is still matched) while keeping an ARBITRARY value out
 * (`max-w-[28rem]` — the `[` follows a `-` that is not part of any step name).
 * `max-w-full` / `-none` / `-fit` / `-prose` / `-screen` / `-min` / `-max` and
 * the numeric scale are not named steps and are not matched.
 */
const NAMED_MAX_W = /(?<![\w-])max-w-(?:xs|sm|md|lg|xl|[2-7]xl)(?![\w-])/g;

/**
 * The same pattern without `g`, for `.test()`.
 *
 * A global regex carries `lastIndex` between calls, so `.test()` on one is
 * order-dependent and answers `false` on a string it just matched. Not a
 * hypothetical: it is how a guard reports a clean tree on its second file.
 */
const NAMED_MAX_W_ONCE = new RegExp(NAMED_MAX_W.source);

/** Every scannable source file under `dir`, repo-relative with `/` separators. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // `.css` is in because `@apply max-w-md` is the same declaration in a second
    // vocabulary — the half `tests/theme/shellViewportUnits.test.ts` learned to
    // cover when one file was fixed and its twin, written differently, was not.
    else if (/\.(tsx?|css)$/.test(entry)) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

interface Offence {
  file: string;
  line: number;
  utility: string;
  /** The source line, for a failure a reader can act on without opening the file. */
  text: string;
}

/** Every named `max-w-*` step written as CODE (not in a comment) in `files`. */
function offencesIn(files: readonly string[]): Offence[] {
  const found: Offence[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    const lines = code.split('\n');
    lines.forEach((text, index) => {
      for (const match of text.matchAll(NAMED_MAX_W)) {
        found.push({ file, line: index + 1, utility: match[0], text: text.trim() });
      }
    });
  }
  return found;
}

describe('named `max-w-*` steps (MOTIR-4084)', () => {
  it('finds source files at all — the scan is not vacuous', () => {
    // Without this, the assertion below passes on an empty set, which is how a
    // totality check dies quietly (the trap MOTIR-2815 hit one lane over).
    expect(SOURCE_FILES.length).toBeGreaterThan(400);
    expect(SOURCE_FILES).toContain('app/(authed)/items/[key]/_components/RunSection.tsx');
    expect(SOURCE_FILES).toContain('components/planning/PlanProposalList.tsx');
  });

  it('the pattern MATCHES the shapes it is written for, and only those', () => {
    // The negative control. A guard whose regex has stopped matching reports a
    // clean tree in exactly the same words as a tree that is clean.
    const offending = [
      '<p className="max-w-md font-sans text-sm">',
      '<div className="max-w-sm text-center">',
      '<section className="mt-8 flex max-w-xs flex-col gap-2">',
      '<div className="fixed w-full max-w-lg">',
      '<p className="sm:max-w-2xl">', // a variant is still the utility
      '<p className={clsx(compact && "max-w-3xl")}>',
    ];
    for (const line of offending) {
      expect([...line.matchAll(NAMED_MAX_W)].length, `missed: ${line}`).toBe(1);
    }

    const allowed = [
      '<p className="max-w-[28rem]">', // the remedy
      '<p className="max-w-[24rem] max-w-[20rem]">',
      '<div className="max-w-full">',
      '<div className="max-w-none max-w-fit max-w-prose max-w-min max-w-max">',
      '<div className="max-w-screen-md">', // the screen family is a different scale
      '<div className="max-w-96">', // the numeric scale is not a named step
      'const MAX_W_MD = 28;',
    ];
    for (const line of allowed) {
      expect(
        [...line.matchAll(NAMED_MAX_W)].map((m) => m[0]),
        `false positive: ${line}`,
      ).toEqual([]);
    }
  });

  it('COMMENTS explaining the trap are not offences — the five warnings survive', () => {
    // The guard must not be satisfiable by deleting the documentation that
    // exists to prevent the defect. These files carry the class name in prose
    // and nowhere else; if `stripComments` ever stops being applied, they are
    // the ones that go red first, and the "fix" would be to blunt them.
    const documented = [
      'app/(auth)/layout.tsx',
      'app/(authed)/reports/_components/ReportPageChrome.tsx',
      'app/tokens/markdown-editor/page.tsx',
      'components/planning/PlanEditsLauncher.tsx',
      'packages/design-system/src/components/ui/Modal.tsx',
    ];
    for (const file of documented) {
      const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(NAMED_MAX_W_ONCE.test(raw), `${file} no longer documents the trap`).toBe(true);
      expect(offencesIn([file]), `${file} writes a named step as CODE`).toEqual([]);
    }
  });

  it('NO file under app/, components/ or packages/design-system/src/ writes one', () => {
    const offences = offencesIn(SOURCE_FILES);
    const report = offences.map((o) => `  ${o.file}:${o.line}  ${o.utility}  ${o.text}`).join('\n');
    expect(
      offences,
      `A named \`max-w-*\` step resolves against the \`--spacing-*\` namespace, not the\n` +
        `container scale — \`max-w-md\` is 16px, \`max-w-sm\` is 12px, \`max-w-xs\` is 8px.\n` +
        `Use an arbitrary value instead: \`max-w-[28rem]\` / \`max-w-[24rem]\` / \`max-w-[20rem]\`.\n` +
        `See MOTIR-4084 and this file's header.\n${report}`,
    ).toEqual([]);
  });
});
