import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_EXEMPTIONS, SERVER_ACTION_GATES, type ActionGate } from './writeControlPairing';

// MOTIR-6176 — THE GUARD (Story MOTIR-6166). A CI test that fails when a control
// that writes can render for an actor without its permission key, naming the
// file, the component and the key — at ZERO from the day it lands.
//
// ── What it asserts, and why it is STATIC ────────────────────────────────────
// The invariant is a property of the code's WIRING: "whoever calls a gated write
// reads a capability first". A static read covers every surface at once,
// including the ones no test renders, which is where MOTIR-4822 came from — the
// surfaces added after the permission-gated UI rule (MOTIR-2462) were gated only
// if their author remembered. The render-level proof per surface is the story's
// integration gate (MOTIR-6177); this file is the net under every future surface.
//
// Four cases:
//   1. PAIRING  — every `'use server'` export under `app/(authed)` is paired in
//      `writeControlPairing.ts` with the gate its SERVICE applies, and every
//      pairing names a real export. A new action fails until someone says, in
//      that file, which key it asks for.
//   2. ENABLED STATE — every client file that calls a GATED action (a key, a
//      role, or a known gap) reads a capability, or is exempted with a reason
//      the guard VERIFIES (its parents read one; its page refuses the actor;
//      or a filed card owns it).
//   3. NAVIGATION — every project-nav row names a key or `browse-only` with
//      evidence. That case, and "every paired key is a catalog key", live in
//      `writeControlPairing.test.ts`: they import app code, and this file runs
//      in the structural-guards lane, which may not.
//   4. TIGHT BOTH WAYS — an exemption that no longer excuses anything fails.
//
// ⚠️ "Reads a capability" is a TOKEN test, deliberately: `can(…)`, a `can*` /
// `readOnly*` / `editable` value, `useProjectAccess`, `held.has`,
// `satisfiesRequirement`, or a role predicate. It cannot prove the read GATES
// the write — that is MOTIR-6177's render test — but it proves the author
// thought about who the control is for, which is the step the four-month gap
// after MOTIR-2462 skipped every time. A file that names one of these and still
// renders ungated is a bug the integration gate exists to catch.

const ROOT = resolve(__dirname, '..', '..');
const AUTHED = 'app/(authed)/';

/** Comments carry prose about the rule; strip them so prose cannot satisfy it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CAPABILITY_READ =
  /\bcan\(|\bcan[A-Z]\w*|\breadOnly\w*|\beditable\b|\buseProjectAccess\b|\bheld\.has\(|\bsatisfiesRequirement\(|\bisOwner\w*|\bisWorkspaceManager\b|\bisOrgAdmin\w*/;

const USE_SERVER = /^\s*['"]use server['"]/;
const USE_CLIENT = /^\s*['"]use client['"]/;

export interface SourceFile {
  path: string;
  source: string;
}

export interface Violation {
  file: string;
  component: string;
  action: string;
  key: string;
}

/** The label a failure prints for a gate — the key, the role, or the gap's card. */
function gateLabel(gate: ActionGate): string {
  if (gate.kind === 'key') return gate.key;
  if (gate.kind === 'role') return gate.role;
  if (gate.kind === 'known-gap') return `${gate.card} (known gap)`;
  return gate.kind;
}

function isGated(gate: ActionGate): boolean {
  return gate.kind === 'key' || gate.kind === 'role' || gate.kind === 'known-gap';
}

/** `export async function x` / `export const x` in a `'use server'` file. */
export function serverExports(source: string): string[] {
  return [...code(source).matchAll(/^export (?:async function|function|const|let) (\w+)/gm)].map(
    (m) => m[1]!,
  );
}

function resolveImport(spec: string, from: string, known: ReadonlySet<string>): string | null {
  const base = spec.startsWith('@/')
    ? spec.slice(2)
    : spec.startsWith('.')
      ? normalize(join(dirname(from), spec))
      : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * THE CHECK — pure, so the fixture below can feed it a file that is not on disk.
 * Returns one violation per (client file, gated action) that has no capability
 * read and no exemption.
 */
export function findViolations(
  files: readonly SourceFile[],
  gates: Readonly<Record<string, ActionGate>>,
  exemptions: Readonly<Record<string, unknown>>,
): Violation[] {
  const serverFiles = new Set(files.filter((f) => USE_SERVER.test(f.source)).map((f) => f.path));
  const violations: Violation[] = [];
  for (const file of files) {
    if (!USE_CLIENT.test(file.source) || file.path in exemptions) continue;
    const src = code(file.source);
    if (CAPABILITY_READ.test(src)) continue;
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(m[2]!, file.path, serverFiles);
      if (!target) continue;
      for (const raw of m[1]!.split(',')) {
        const name = raw
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim();
        if (!name) continue;
        const gate = gates[`${target.slice(AUTHED.length)}#${name}`];
        if (gate && isGated(gate)) {
          violations.push({
            file: file.path,
            component: basename(file.path).replace(/\.tsx?$/, ''),
            action: name,
            key: gateLabel(gate),
          });
        }
      }
    }
  }
  return violations;
}

// ── the tree, read once ──────────────────────────────────────────────────────

const TRACKED = execFileSync('git', ['ls-files', 'app', 'components'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => /\.tsx?$/.test(p));
const FILES: SourceFile[] = TRACKED.map((path) => ({
  path,
  source: readFileSync(join(ROOT, path), 'utf8'),
}));
const SERVER_ACTIONS = FILES.filter(
  (f) => f.path.startsWith(AUTHED) && USE_SERVER.test(f.source),
).flatMap((f) => serverExports(f.source).map((name) => `${f.path.slice(AUTHED.length)}#${name}`));

const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('1 · every server action is PAIRED with the gate its service applies', () => {
  it('finds the population it guards (a guard over nothing is not a guard)', () => {
    expect(SERVER_ACTIONS.length).toBeGreaterThan(80);
  });

  it('every `use server` export under app/(authed) has a pairing', () => {
    const unpaired = SERVER_ACTIONS.filter((id) => !(id in SERVER_ACTION_GATES));
    expect(
      unpaired,
      'pair each in tests/permissions/writeControlPairing.ts with the key its service asserts',
    ).toEqual([]);
  });

  it('every pairing names a real export — a stale row fails', () => {
    const exported = new Set(SERVER_ACTIONS);
    expect(Object.keys(SERVER_ACTION_GATES).filter((id) => !exported.has(id))).toEqual([]);
  });
});

describe('2 · a control that calls a gated write reads a capability first', () => {
  it('ZERO violations across app/ and components/', () => {
    const found = findViolations(FILES, SERVER_ACTION_GATES, CONTROL_EXEMPTIONS).map(
      (v) =>
        `${v.file} — ${v.component} calls ${v.action}, which needs ${v.key}, and reads no capability`,
    );
    expect(found).toEqual([]);
  });

  it('BITES — a control wired to a gated write with no capability read fails with its file, component and key', () => {
    const fixture: SourceFile[] = [
      {
        path: 'app/(authed)/items/[key]/edit/actions.ts',
        source: "'use server';\nexport async function updateIssueAction() {}\n",
      },
      {
        path: 'app/(authed)/items/[key]/_components/UngatedPriorityPicker.tsx',
        source:
          "'use client';\n" +
          "import { updateIssueAction } from '../edit/actions';\n" +
          '// the rule says canEdit — a COMMENT must not satisfy the guard\n' +
          'export function UngatedPriorityPicker() { return <button onClick={() => updateIssueAction()} />; }\n',
      },
    ];
    const violations = findViolations(fixture, SERVER_ACTION_GATES, {});
    expect(violations).toEqual([
      {
        file: 'app/(authed)/items/[key]/_components/UngatedPriorityPicker.tsx',
        component: 'UngatedPriorityPicker',
        action: 'updateIssueAction',
        key: 'work_item:edit',
      },
    ]);
    // …and the same control with a capability read passes.
    fixture[1]!.source = fixture[1]!.source.replace(
      'export function',
      "const canEdit = useProjectAccess().can('work_item:edit');\nexport function",
    );
    expect(findViolations(fixture, SERVER_ACTION_GATES, {})).toEqual([]);
  });

  it('a READ or a self-scoped write needs no capability read', () => {
    const fixture: SourceFile[] = [
      {
        path: 'app/(authed)/items/actions.ts',
        source: "'use server';\nexport async function listRootIssuesAction() {}\n",
      },
      {
        path: 'app/(authed)/items/_components/Tree.tsx',
        source: "'use client';\nimport { listRootIssuesAction } from '../actions';\n",
      },
    ];
    expect(findViolations(fixture, SERVER_ACTION_GATES, {})).toEqual([]);
  });
});

describe('4 · every exemption is TRUE, and still NEEDED', () => {
  const unexempted = findViolations(FILES, SERVER_ACTION_GATES, {});
  const needing = new Set(unexempted.map((v) => v.file));

  it.each(Object.entries(CONTROL_EXEMPTIONS))('%s', (file, exemption) => {
    // STILL NEEDED: the file still calls a gated write with no capability read.
    // Fix the control and this entry fails until it is deleted.
    expect(needing.has(file), 'stale exemption — the file no longer needs one').toBe(true);
    const e = exemption as
      | { kind: 'mounted-by'; parents: string[] }
      | { kind: 'page-guarded'; page: string }
      | { kind: 'known-gap'; card: string };
    if (e.kind === 'mounted-by') {
      const name = basename(file).replace(/\.tsx?$/, '');
      for (const parent of e.parents) {
        expect(existsSync(join(ROOT, parent)), parent).toBe(true);
        const src = code(source(parent));
        expect(src, `${parent} must import ${name}`).toContain(name);
        expect(CAPABILITY_READ.test(src), `${parent} must read a capability`).toBe(true);
      }
    } else if (e.kind === 'page-guarded') {
      expect(code(source(e.page))).toMatch(/guardSettingsPage\(/);
    } else {
      expect(e.card).toMatch(/^MOTIR-\d+$/);
    }
  });

  it('every known-gap exemption names the SAME card as a pairing it calls', () => {
    const cards = new Set(
      Object.values(SERVER_ACTION_GATES).flatMap((g) => (g.kind === 'known-gap' ? [g.card] : [])),
    );
    for (const [file, e] of Object.entries(CONTROL_EXEMPTIONS)) {
      if (e.kind === 'known-gap') expect(cards.has(e.card), file).toBe(true);
    }
  });
});
