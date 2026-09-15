import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-5547 — a SERVER page may import only COMPONENTS from a `'use client'`
// module, never a value.
//
// Across the client boundary every export of a `'use client'` module becomes a
// client REFERENCE on the server — a stub that throws if called and is not
// the value it names. A component survives that (the server renders the
// reference), a constant does not. `page.tsx` imported
// `PLAN_HISTORY_FIRST_PAGE` from `PlanHistorySection.tsx`: vitest has no
// client-reference transform, so every unit test saw the number 5, while the
// production build passed a stub to `clampPlanHistoryLimit`, which fell back to
// its default of 20 — the section lost its visible bound and its Show more.
// Only the acceptance run against a real build caught it (MOTIR-5549).
//
// So this reads the page's own imports: from any `'use client'` module it
// imports, every imported name must be a component (PascalCase).

const ROOT = process.cwd();
const PAGE = 'app/(authed)/items/[key]/page.tsx';

function resolveModule(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(ROOT, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(join(ROOT, fromFile)), spec)
      : null;
  if (!base) return null;
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

function isClientModule(path: string): boolean {
  const head = readFileSync(path, 'utf8').trimStart();
  return head.startsWith("'use client'") || head.startsWith('"use client"');
}

describe('the item page imports only components across the client boundary', () => {
  const source = readFileSync(join(ROOT, PAGE), 'utf8');
  const imports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)]
    .filter((m) => !m[0].startsWith('import type'))
    .map((m) => ({
      names: m[1]!
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith('type '))
        .map((n) => n.split(/\s+as\s+/).pop()!),
      spec: m[2]!,
    }));

  it('reads real imports out of the page', () => {
    // A guard on the guard: a regex that stopped matching would make the
    // assertion below vacuous.
    expect(imports.length).toBeGreaterThan(20);
  });

  it('takes no non-component value from a `use client` module', () => {
    const offending: string[] = [];
    for (const { names, spec } of imports) {
      const path = resolveModule(PAGE, spec);
      if (!path || !isClientModule(path)) continue;
      for (const name of names) {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || /^[A-Z0-9_]+$/.test(name)) {
          offending.push(`${name} from ${spec}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
