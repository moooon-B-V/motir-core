import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// THE WIRING GUARD (Bug MOTIR-5191) — every production mount of the approval
// frame SUPPLIES the *waiting on* name, rather than hardcoding it away.
//
// ⚠️ THIS IS THE TEST THE BUG EXISTS FOR, AND IT IS A TEXT READ FOR A REASON.
// The frame's own component tests already pass `routedToLabel: 'Mara S.'` and
// assert the sentence renders — three of them — and every one was GREEN on the
// defect, because they supplied the name the application did not. That is not a
// gap in those tests; it is what a component test IS. A test that hands a
// component its input cannot discover that no caller ever does, so no amount of
// rendering the frame more carefully could have caught this.
//
// What was actually wrong lived at the CALL SITE — `routedToLabel={null}`,
// written once, compiling perfectly, typechecking perfectly, and rendering the
// generic fallback (*"this work item's assignee"*) to every non-decider in the
// product. So the assertion has to quantify over CALL SITES, and the cheapest
// honest way to do that is to read them.
//
// It quantifies over whatever mounts the frame TODAY rather than over a list
// written today: when MOTIR-4879 added the Approvals tab it added a SECOND
// mount, which inherited the same hardcoded `null` — so a guard naming one file
// would have gone green while the defect doubled. `tests/` is excluded, because
// a fixture passing `null` to exercise the fallback is the fallback being
// tested, not the product shipping it.

const ROOT = path.resolve(__dirname, '..');

/** `app` + `components` + `lib` — the PRODUCT surface, the same population
 *  `tests/approval-gate-one-language.test.ts` quantifies over and for the same
 *  reason: a test file naming the prop is a fixture, not a shipped call. */
const SOURCE_ROOTS = ['app', 'components', 'lib'] as const;

const CONTROL_MODULE = 'components/approvals/ApprovalGateControl';

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every production file that MOUNTS the frame — it imports the module AND
 * renders the element. Both halves are required: `DesignResultPanel.tsx` names
 * the module in a comment and mounts nothing, and a guard keyed on the import
 * alone would demand a prop from a file that passes none.
 */
const MOUNT_SITES: readonly { file: string; code: string }[] = SOURCE_ROOTS.flatMap((dir) =>
  collectSourceFiles(path.join(ROOT, dir)),
)
  .map((file) => ({ file: path.relative(ROOT, file), code: fs.readFileSync(file, 'utf8') }))
  .filter(({ code }) => code.includes(`from '@/${CONTROL_MODULE}'`))
  .filter(({ code }) => /<ApprovalGateControl[\s/>]/.test(code));

describe('every production mount of the approval frame NAMES who it is waiting on', () => {
  it('finds the mount sites at all — the guard must not pass vacuously', () => {
    // A rename of the component or of its module path would empty the list
    // above, and an empty `forEach` is a green test asserting nothing. This is
    // the assertion that turns that into a failure instead. Two sites today:
    // the item page's design-result section and the Workbench's Approvals tab.
    expect(MOUNT_SITES.map((s) => s.file).sort()).toEqual([
      'app/(authed)/items/[key]/_components/DesignResultSection.tsx',
      'app/(authed)/workbench/_components/ApprovalsList.tsx',
    ]);
  });

  it.each(MOUNT_SITES.map((s) => s.file))('%s passes a routedToLabel', (file) => {
    const { code } = MOUNT_SITES.find((s) => s.file === file)!;
    expect(code).toMatch(/routedToLabel=\{/);
  });

  it.each(MOUNT_SITES.map((s) => s.file))(
    '%s does NOT hardcode routedToLabel to null — the defect itself',
    (file) => {
      const { code } = MOUNT_SITES.find((s) => s.file === file)!;
      // ⚠️ THE ONE ASSERTION THAT WAS RED BEFORE THE FIX, at BOTH sites. The
      // prop is optional (`routedToLabel?: string | null`), so a literal null
      // compiles, typechecks and renders a complete, grammatical sentence — it
      // just renders the wrong one, for ever, to everybody who may not decide.
      // Nothing else in the suite can see it: the string is not missing, the
      // prop is not missing, and the fallback is a sentence rather than a blank.
      expect(
        /routedToLabel=\{\s*null\s*\}/.test(code),
        `${file} passes routedToLabel={null} — the frame will draw its generic fallback`,
      ).toBe(false);
    },
  );
});
