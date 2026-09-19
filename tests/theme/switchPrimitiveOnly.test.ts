import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// MOTIR-5735 — ONE switch in the product, and it is the design system's.
//
// ── The defect this exists to prevent ───────────────────────────────────────
// `packages/design-system/src/components/ui/Switch.tsx` had its three contrast
// pairs fixed through Switch-scoped tokens (MOTIR-5711 the OFF knob, MOTIR-5715
// the ON track, MOTIR-5725 the OFF edge), and `switchStateContrast.test.ts`
// measures every pair the primitive binds. Two surfaces did not use it: the
// automation rule `RuleSwitch` and the dashboard widget-config `Toggle` each
// drew their own `role="switch"` button in the GENERIC tokens, so none of those
// fixes reached them. An OFF automation rule rendered its knob at 1.00:1 against
// its own track in all 20 palette × theme contexts.
//
// A contrast suite over the primitive cannot see a copy of the primitive. So the
// guard is structural: `role="switch"` is written in exactly one file, and every
// other surface renders `Switch` — and inherits whatever it is fixed to next.
//
// ── COMMENTS ARE NOT CODE ───────────────────────────────────────────────────
// Doc comments name the role (`Switch.tsx`'s own header, the GitLab sync
// switch's), so the scan reads `stripComments`'d source. It blanks comments to
// spaces, so reported line numbers stay true.
//
// ── The scope ───────────────────────────────────────────────────────────────
// Every `.tsx` under `app/`, `components/` and `packages/` — everything that
// renders. A new package joins without anyone remembering to add it.

const SCAN_ROOTS = ['app', 'components', 'packages'] as const;

/** The one file allowed to render `role="switch"`. */
const PRIMITIVE = 'packages/design-system/src/components/ui/Switch.tsx';

/**
 * `role="switch"` as code: the JSX attribute in any quoting (`"…"`, `'…'`,
 * `{'…'}`, `` {`…`} ``) and the object-literal form a spread-props site writes
 * (`role: 'switch'`).
 */
const SWITCH_ROLE = /\brole\s*(?:=\s*(?:\{\s*)?|:\s*)(["'`])switch\1/g;

/** Every `.tsx` under `dir`, repo-relative with `/` separators. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx')) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

/** Each `role="switch"` written as code in `source`, as `line: text`. */
function switchRolesIn(source: string): string[] {
  const lines = stripComments(source).split('\n');
  const found: string[] = [];
  lines.forEach((text, index) => {
    if (text.match(SWITCH_ROLE)) found.push(`${index + 1}: ${text.trim()}`);
  });
  return found;
}

describe('only the design-system Switch renders role="switch" (MOTIR-5735)', () => {
  it('finds source files at all — the scan is not vacuous', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(400);
    expect(SOURCE_FILES).toContain(PRIMITIVE);
    expect(SOURCE_FILES).toContain(
      'app/(authed)/settings/project/automation/_components/AutomationRuleList.tsx',
    );
  });

  it('the pattern MATCHES the shapes it is written for, and skips comments', () => {
    // The control. A pattern that has stopped matching reports a clean tree in
    // exactly the same words as a tree that is clean — so it is run against the
    // pre-fix `RuleSwitch` / `Toggle` shape, and must fire.
    const offending = [
      '<button type="button" role="switch" aria-checked={checked}>',
      "<button role='switch'>",
      "<button role={'switch'}>",
      '<button role={`switch`}>',
      '<div role = "switch" />',
      "const props = { role: 'switch', 'aria-checked': on };",
    ];
    for (const line of offending) {
      expect(switchRolesIn(line), `missed: ${line}`).toHaveLength(1);
    }

    const allowed = [
      '/** A sliding switch (`role="switch"`), keyboard-operable. */',
      '// renders `role="switch"` via the primitive',
      '<Switch checked={on} onCheckedChange={setOn} aria-label="Enabled" />',
      '<div role="switchboard" />',
      '<div role="radiogroup" />',
      "screen.getByRole('switch')",
    ];
    for (const line of allowed) {
      expect(switchRolesIn(line), `false positive: ${line}`).toEqual([]);
    }
  });

  it('the primitive itself is found by the scan — the exemption is not what keeps it quiet', () => {
    expect(switchRolesIn(readFileSync(join(REPO_ROOT, PRIMITIVE), 'utf8'))).toHaveLength(1);
  });

  it('no other `.tsx` renders its own switch — use `Switch` from `@/components/ui/Switch`', () => {
    const offences = SOURCE_FILES.filter((file) => file !== PRIMITIVE).flatMap((file) =>
      switchRolesIn(readFileSync(join(REPO_ROOT, file), 'utf8')).map((hit) => `${file}:${hit}`),
    );
    expect(offences).toEqual([]);
  });
});
