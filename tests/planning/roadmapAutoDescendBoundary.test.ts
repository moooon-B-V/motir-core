import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Story-MOTIR-1803 OPT-IN BOUNDARY guard — the third leg of the story's vitest
// gate (the coverage top-up + the adapter seam live in
// `tests/components/roadmapAutoDrillGate.test.tsx`).
//
// The guarantee a coverage percentage cannot express: `ProjectRoadmapCanvas` is
// the reusable FOUNDATION behind several surfaces, and `autoDescendSingleParent`
// defaults to `false` precisely so the others are unaffected. A well-meant later
// edit that turns the behaviour on globally — flipping the default, or adding the
// prop at another mount — would silently walk the ONBOARDING canvas past its
// single station, and no test of THIS story would notice: every auto-drill spec
// would still pass, because they all opt in explicitly.
//
// So the invariant is asserted STRUCTURALLY, by reading the mount sites the way a
// reviewer would (the `planChangeArchitecture` / `render-single-source` pattern),
// rather than by re-rendering all the consumers. Scanning the whole tree — instead
// of listing today's consumers — means a NEW consumer that opts in is caught too.
//
// (`PlanningWorkspaceHost` mounts the canvas TRANSITIVELY, through
// `WorkItemRoadmap`, so it inherits the opt-in rather than passing the prop; the
// scan below reflects that by asserting on the direct mount sites it finds.)

const ROOT = process.cwd();
const PROP = 'autoDescendSingleParent';
/** The one consumer that is ALLOWED to enable it. */
const OPTED_IN = join('components', 'planning', 'WorkItemRoadmap.tsx');
const CANVAS = join('components', 'planning', 'ProjectRoadmapCanvas.tsx');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = ['app', 'components', 'lib'].flatMap((d) => collectSourceFiles(join(ROOT, d)));

const read = (file: string) => readFileSync(file, 'utf8');

/** Source with comments stripped: a prose mention is the RECORD of why the
 *  default is what it is; only real code can be the regression. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** Every file that MOUNTS the canvas as JSX (not merely imports its types). */
const MOUNT_SITES = SOURCE_FILES.filter((f) => /<ProjectRoadmapCanvas[\s/>]/.test(code(read(f))))
  .map((f) => relative(ROOT, f))
  .sort();

describe('auto-descend is opt-in, and exactly one consumer opts in', () => {
  it('the scan actually found the canvas mount sites (not vacuous)', () => {
    // A scan that silently matched nothing would make every assertion below
    // pass by accident — the failure mode a structural guard is most prone to.
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(MOUNT_SITES.length).toBeGreaterThan(1);
    expect(MOUNT_SITES).toContain(OPTED_IN);
  });

  it('ONLY WorkItemRoadmap enables the prop, at any mount site in the tree', () => {
    // The core assertion. Every OTHER consumer mounting the same foundation must
    // leave the prop off entirely (the `false` default), so the behaviour cannot
    // leak into onboarding, plan review, or the plan-change canvas.
    const enablers = MOUNT_SITES.filter((rel) => code(read(join(ROOT, rel))).includes(PROP));
    expect(enablers).toEqual([OPTED_IN]);
  });

  it('the other mount sites pass no such prop, spelled any way', () => {
    // Belt-and-braces on the assertion above: named explicitly so a refactor
    // that renames the prop cannot quietly satisfy the `includes` check while
    // the behaviour is on somewhere else.
    for (const rel of MOUNT_SITES.filter((r) => r !== OPTED_IN)) {
      const text = code(read(join(ROOT, rel)));
      expect(text, `${rel} must not enable auto-descend`).not.toMatch(/autoDescend/i);
    }
  });

  it('the canvas DEFAULTS the prop to false', () => {
    // The default is load-bearing: the guard above only proves nobody passes it.
    // If the default flipped to `true`, every non-opted-in consumer would descend
    // while still passing that test.
    const canvas = code(read(join(ROOT, CANVAS)));
    expect(canvas).toMatch(new RegExp(`${PROP}\\s*=\\s*false`));
    // …and the prop is OPTIONAL, so a consumer that omits it stays on the default
    // rather than being forced to make a choice.
    expect(canvas).toMatch(new RegExp(`${PROP}\\?:\\s*boolean`));
  });

  it('WorkItemRoadmap enables it for BOTH scopes, not just the sprint read', () => {
    // The opt-in must not be narrowed by SCOPE (MOTIR-1807): a single-epic project
    // has the same degenerate shape in project scope, so an edit that made it
    // `autoDescendSingleParent={scope === 'sprint'}` would silently shrink the
    // feature while every descent spec still passed.
    //
    // ⚠️ This assertion USED to be "the prop is a bare attribute, with no `={…}`
    // at all". That was a proxy for the real rule, and MOTIR-2287 outgrew it: the
    // adapter can now be ROOTED at one work item (the Children panel), where the
    // design's recorded verdict is that auto-descend must be OFF — a panel that
    // says "this item's children" must show them even when there is exactly one.
    // So the value is legitimately an expression now, and the guard has to name
    // WHICH gate is allowed instead of banning every gate. It keeps its teeth:
    // the scope form below still fails it.
    const adapter = code(read(join(ROOT, OPTED_IN)));
    const passed = adapter.match(new RegExp(`${PROP}(?:\\s*=\\s*\\{([^}]*)\\})?`));
    expect(passed, 'the adapter must still opt in at its canvas mount').not.toBeNull();
    const value = (passed?.[1] ?? '').trim();
    // Whatever gates it, SCOPE may not: that is the MOTIR-1807 decision this
    // guard was written to protect, and it is unchanged.
    expect(value, 'auto-descend must not be gated on scope').not.toMatch(/scope/i);
    // And the ONLY gate allowed is the subtree-rooting one (MOTIR-2285's verdict).
    // An empty value is the original unconditional opt-in, still legal.
    expect(['', '!rooted'], `unexpected auto-descend gate: ${value || '(none)'}`).toContain(value);
  });

  it('the rooting gate is real: a rooted mount is what turns auto-descend off', () => {
    // The assertion above reads the SOURCE, so on its own it could be satisfied by
    // a `rooted` that never means anything. This one drives the behaviour: the
    // adapter must derive `rooted` from the subtree-root prop, so the gate is
    // wired to the thing it claims to be wired to. (The behavioural proof — a
    // rooted level with one drillable child does NOT descend — lives in
    // `tests/components/WorkItemRoadmap.test.tsx`, both directions.)
    const adapter = code(read(join(ROOT, OPTED_IN)));
    expect(adapter).toMatch(/const\s+rooted\s*=\s*subtreeRootId\s*!=\s*null/);
  });
});
