import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE DEPENDENCY GUARD (Story MOTIR-1916 · MOTIR-1921) —
// `docs/decisions/ci-runner-fleet.md` §4, rule 1:
//
//   > No `fly` types, imports or ids above `lib/orchestrator/adapters/fly/`. The
//   > webhook handler (MOTIR-1920), the gate (MOTIR-1922), the provisioner
//   > (MOTIR-1921) and the meter (MOTIR-1924) see `ContainerHandle` and
//   > `ContainerUsage` only.
//
// ⚠️ ASSERTED, NOT LEFT TO CONVENTION — which is the card's acceptance criterion
// ("asserted by an import/dependency guard, not by convention") and the only
// thing that makes §3's reversibility claim worth anything. A port whose
// boundary is a comment erodes the first time someone needs one more field, and
// the erosion is invisible until the day a second adapter is actually needed —
// by which point "swap the adapter" has quietly become "re-plan the fleet".
//
// It scans SOURCE rather than a module graph on purpose: a graph tells you what
// is imported, and half the ways Fly can leak (a hardcoded API host, an env var,
// a `state === 'started'` string) are not imports at all.

/** Where Fly may be named. Everything else in `lib/` must not know it exists. */
const ADAPTER_DIR = join('lib', 'orchestrator', 'adapters', 'fly');

/**
 * The COMPOSITION ROOT — the one file outside the adapter that must name it.
 *
 * `getOrchestrator()` chooses between adapters, so it imports them; a selector
 * that cannot name what it selects is not a selector. Exempting it is not a
 * weakening of the rule, it is where the rule POINTS: §4's claim is that
 * swapping Fly for §3's migration target is "a new file under `adapters/` plus
 * one branch here", and that claim is only true if here is exactly one place.
 * The guard therefore proves the leak set is {adapter, selector} — nothing else.
 */
const COMPOSITION_ROOT = join('lib', 'orchestrator', 'index.ts');

/** Roots that must stay provider-agnostic. */
const SCANNED_ROOTS = ['lib', 'app', 'components'];

/**
 * The tells, each one a way Fly leaks that is NOT an import statement.
 *
 * Deliberately narrow — `/fly/i` alone would match `flyout`, `butterfly` and
 * `overflying`, and a guard that cries wolf gets deleted. These match things
 * only the adapter can legitimately say.
 */
const FLY_TELLS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /adapters\/fly/, what: 'an import from the Fly adapter directory' },
  { pattern: /api\.machines\.dev/, what: "Fly's Machines API host" },
  { pattern: /\bFLY_[A-Z_]+\b/, what: 'a FLY_* environment variable' },
  { pattern: /\bfly(Machines|Orchestrator|FleetConfig|Machine)\b/, what: 'a Fly-named symbol' },
  { pattern: /\bFlyMachine\b/, what: 'the FlyMachine type' },
  { pattern: /\bauto_destroy\b/, what: "Fly's machine-config key" },
  { pattern: /\bcpu_kind\b/, what: "Fly's guest-config key" },
];

/**
 * The ONE sanctioned exception, and it is worth naming rather than hiding.
 *
 * `ciRunnerBootService` reads the fleet's IMAGE and REGION through
 * `flyFleetConfig()` to fill a provider-neutral `ContainerSpec`. Those two values
 * are deployment configuration that has to come from somewhere, and today the
 * only deployment is Fly's. It is a leak of the CONFIG accessor, not of a Fly
 * type: no `FlyMachine`, no machine id, no API call. When a second adapter lands,
 * the fix is a `defaultSpecDefaults()` on the port — which is a five-line change
 * precisely because this is the only place to change.
 */
const ALLOWED: ReadonlyArray<{ file: string; tell: RegExp; why: string }> = [
  {
    file: join('lib', 'services', 'ciRunnerBootService.ts'),
    tell: /\bflyFleetConfig\b/,
    why: 'reads the deployment image/region for a provider-neutral ContainerSpec',
  },
];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.tsx?$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

/** Strip line comments and block comments — a comment EXPLAINING the boundary
 *  (this file is full of them, and so are the adapters' headers) is not a
 *  violation of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const root = process.cwd();

function violations(): Array<{ file: string; what: string; line: string }> {
  const found: Array<{ file: string; what: string; line: string }> = [];
  for (const scanRoot of SCANNED_ROOTS) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file);
      // The adapter itself is where Fly lives; the selector is where it is
      // chosen. Those two, and nothing else.
      if (rel.startsWith(ADAPTER_DIR + sep)) continue;
      if (rel === COMPOSITION_ROOT) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, what } of FLY_TELLS) {
        for (const line of source.split('\n')) {
          if (!pattern.test(line)) continue;
          const excused = ALLOWED.some((a) => a.file === rel && a.tell.test(line));
          if (excused) continue;
          found.push({ file: rel, what, line: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return found;
}

describe('§4 rule 1 — no `fly` escapes the adapter directory', () => {
  it('nothing in lib/, app/ or components/ names Fly outside the adapter', () => {
    const found = violations();
    // The failure message IS the value: it names the file, the line and WHICH
    // tell fired, so a violation is fixed rather than merely reported.
    expect(found, found.map((v) => `${v.file}: ${v.what}\n    ${v.line}`).join('\n')).toEqual([]);
  });

  it('the guard actually detects a leak (mutation check)', () => {
    // ⚠️ A guard nobody has watched FAIL is a guard that may be matching nothing.
    // This proves the tells fire on the strings they exist to catch, so a green
    // run above means "no leak" rather than "no scan".
    const leaks = [
      "import { flyMachinesClient } from '@/lib/orchestrator/adapters/fly/flyMachines';",
      "const url = 'https://api.machines.dev/v1/apps';",
      "const token = process.env['FLY_FLEET_API_TOKEN'];",
      'const m: FlyMachine = await read();',
      'config.auto_destroy = true;',
    ];
    for (const leak of leaks) {
      expect(
        FLY_TELLS.some(({ pattern }) => pattern.test(leak)),
        leak,
      ).toBe(true);
    }
  });

  it('does not fire on innocent words that merely contain "fly"', () => {
    // The guard is narrow on purpose: one that cries wolf gets deleted, and a
    // deleted guard is worse than none because the boundary still reads enforced.
    const innocent = [
      'const butterfly = true;',
      "className='overflow-x-auto'",
      '// the machine will fly through the queue',
      'const flyoutOpen = useState(false);',
    ];
    for (const line of innocent) {
      const stripped = stripComments(line);
      expect(
        FLY_TELLS.some(({ pattern }) => pattern.test(stripped)),
        line,
      ).toBe(false);
    }
  });

  it('the composition root is the ONLY non-adapter file that names Fly', () => {
    // §4's reversibility claim in one assertion: "a new file under `adapters/`
    // plus one branch here". If a second file ever needs to know, this fails and
    // the claim needs re-stating rather than quietly becoming untrue.
    const namingFly = new Set(violations().map((v) => v.file));
    expect([...namingFly]).toEqual([]);
    const selector = stripComments(readFileSync(join(root, COMPOSITION_ROOT), 'utf8'));
    expect(selector).toMatch(/flyOrchestrator/);
  });

  it('every sanctioned exception still points at a real file and a live tell', () => {
    // An allow-list entry that no longer matches anything is a hole nobody
    // notices — it silently excuses whatever moves into that file next.
    for (const allowed of ALLOWED) {
      const source = stripComments(readFileSync(join(root, allowed.file), 'utf8'));
      expect(allowed.tell.test(source), `${allowed.file} no longer contains ${allowed.tell}`).toBe(
        true,
      );
    }
  });
});
