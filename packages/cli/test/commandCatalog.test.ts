import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_CATALOG,
  DEFAULT_SERVER_URL,
  HELP_GROUP,
  type CommandCatalogEntry,
} from '../src/commandCatalog.js';
import { HELP_TOPICS } from '../src/help.js';
import { buildProgram } from '../src/program.js';

// THE AGREEMENT GATE (MOTIR-2324) — the published `/docs/cli` table and the
// binary a reader actually runs describe the SAME command tree.
//
// `commandCatalog.ts` exists so a documentation page can read the CLI's own
// declarations without importing `commander` (ADR
// `docs/decisions/public-api-conventions.md` Amendment 12 Q2). Four of its
// facts — name, argument signature, description, help group — are BUILT FROM
// the record by `program.ts`, so they cannot drift. The fifth, `options`, is
// PINNED: `program.ts` still registers its own flags, and this test is what
// keeps the record honest about them.
//
// So the assertions below run in BOTH directions. A command registered with no
// entry fails; an entry naming no command fails; and a flag on either side that
// the other does not carry fails. Nothing here can pass by omission.
//
// This test lives in the CLI package because it needs the REAL program tree,
// which means importing `commander` — legal here, and the reason
// `tests/api-docs/` does not re-derive it (Amendment 12's consequences).

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The topic pseudo-commands, which are NOT catalog entries — see below. */
const TOPIC_NAMES = HELP_TOPICS.map((topic) => topic.name);

interface RegisteredCommand {
  path: string;
  signature: string;
  description: string;
  helpGroup: string | null;
  options: { flags: string; description: string }[];
}

/** Render commander's registered arguments back to the syntax they were declared with. */
function signatureOf(command: Command): string {
  return command.registeredArguments
    .map((argument) => {
      const inner = `${argument.name()}${argument.variadic ? '...' : ''}`;
      return argument.required ? `<${inner}>` : `[${inner}]`;
    })
    .join(' ');
}

/**
 * Walk the REAL tree `buildProgram()` produces, skipping the HELP TOPICS
 * pseudo-commands.
 *
 * Those are generated one per `HELP_TOPICS` entry by `registerHelpSurface` and
 * already derive from that record; they are topics wearing a command's clothes,
 * and the published table lists commands. The exclusion is COMPUTED from
 * `HELP_TOPICS` rather than written out, so a new topic cannot slip through the
 * gap it opens.
 */
function walkProgram(): RegisteredCommand[] {
  const found: RegisteredCommand[] = [];
  const walk = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      if (prefix === '' && TOPIC_NAMES.includes(command.name())) continue;
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      const group = command.helpGroup();
      found.push({
        path,
        signature: signatureOf(command),
        description: command.description(),
        helpGroup: group === '' ? null : group,
        options: command.options.map((option) => ({
          flags: option.flags,
          description: option.description,
        })),
      });
      walk(command, path);
    }
  };
  walk(buildProgram(), '');
  return found;
}

function entryFor(path: string): CommandCatalogEntry | undefined {
  return COMMAND_CATALOG.find((entry) => entry.path === path);
}

describe('commandCatalog ↔ the real program tree', () => {
  const registered = walkProgram();

  it('walks a tree with commands in it, so an empty walk cannot pass by default', () => {
    // The guard on the guard: every assertion below is a comparison, and two
    // empty lists compare equal. A rename that broke the walk would otherwise
    // turn this whole file into a test that asserts nothing.
    expect(registered.length).toBeGreaterThan(15);
    expect(COMMAND_CATALOG.length).toBe(registered.length);
    expect(TOPIC_NAMES.length).toBeGreaterThan(0);
  });

  it('carries an entry for every REGISTERED command, in the same order', () => {
    // Order is render order (commander groups by first appearance), and the
    // published table renders in catalog order — so the two must agree on it,
    // not merely on membership.
    expect(COMMAND_CATALOG.map((entry) => entry.path)).toEqual(
      registered.map((command) => command.path),
    );
  });

  it('names only commands the program actually REGISTERS', () => {
    const paths = new Set(registered.map((command) => command.path));
    const orphans = COMMAND_CATALOG.filter((entry) => !paths.has(entry.path)).map(
      (entry) => entry.path,
    );
    expect(orphans).toEqual([]);
  });

  it.each(walkProgram().map((command) => [command.path, command] as const))(
    'agrees with the program on `motir %s`',
    (path, command) => {
      const entry = entryFor(path);
      expect(entry, `no catalog entry for "${path}"`).toBeDefined();
      expect(entry!.signature).toBe(command.signature);
      expect(entry!.description).toBe(command.description);
      expect(entry!.helpGroup).toBe(command.helpGroup);
      // Flags are the PINNED half of the record, so they get the exact
      // comparison: order included, descriptions included, no subset match.
      expect(entry!.options.map((option) => ({ ...option }))).toEqual(command.options);
    },
  );

  it('gives every top-level command a help group, and every subcommand none', () => {
    for (const entry of COMMAND_CATALOG) {
      if (entry.path.includes(' ')) expect(entry.helpGroup).toBeNull();
      else expect(Object.values(HELP_GROUP)).toContain(entry.helpGroup);
    }
  });
});

describe('commandCatalog is import-safe and serializable', () => {
  it('imports NOTHING — not a package, not a relative module, not a node: builtin', () => {
    // The property the whole seam rests on: a documentation page under `app/` or
    // `lib/` may import this module, and it must not acquire a dependency graph
    // by doing so. `agentProfiles.ts` — the other permitted crossing — needs
    // `node:path`; this one needs nothing, so the bar here is stricter, not
    // looser (Amendment 12 Q4).
    const source = readFileSync(join(SRC, 'commandCatalog.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^import .*? from '([^']+)';/gm)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual([]);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('exports plain serializable data only — a row may cross to a client component', () => {
    for (const value of [COMMAND_CATALOG, HELP_GROUP, DEFAULT_SERVER_URL]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    for (const entry of COMMAND_CATALOG) {
      for (const value of Object.values(entry)) expect(typeof value).not.toBe('function');
      for (const option of entry.options) {
        for (const value of Object.values(option)) expect(typeof value).toBe('string');
      }
    }
  });

  it('is the SINGLE home for the two constants that moved into it', () => {
    // notes.html #218: a value with two hand-maintained homes is an artifact
    // waiting to contradict itself. `serverResolve.ts` and `help.ts` re-export
    // these; neither re-declares them, and this is what proves it.
    const serverResolve = readFileSync(join(SRC, 'serverResolve.ts'), 'utf8');
    const help = readFileSync(join(SRC, 'help.ts'), 'utf8');
    expect(serverResolve).not.toMatch(/const DEFAULT_SERVER_URL\s*=/);
    expect(help).not.toMatch(/const HELP_GROUP\s*=/);
    expect(DEFAULT_SERVER_URL).toBe('https://app.motir.co');
  });
});
