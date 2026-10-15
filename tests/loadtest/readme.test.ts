import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONS as PREFLIGHT_OPTIONS } from '@/loadtest/preflight/sideEffects';
import { OPTIONS as REPORT_OPTIONS } from '@/loadtest/report/report';
import { OPTIONS as RUN_OPTIONS } from '@/loadtest/run/run';
import { OPTIONS as RESET_OPTIONS } from '@/loadtest/seed/reset';
import { OPTIONS as SEED_OPTIONS } from '@/loadtest/seed/seed';
import { ROW_IDS } from '@/loadtest/staging/sideEffectSwitches';

// THE RUNBOOK GUARD (Story MOTIR-8538 · MOTIR-8680). `loadtest/README.md` documents
// the four load-test CLIs; this keeps it from quietly drifting from them:
//   1. every `pnpm loadtest:*` script it names is a package.json script;
//   2. every `--flag` it passes to a CLI is one that CLI's exported OPTIONS accepts;
//   3. section 9 has exactly one subsection per row id of the switch table.
// (The other direction — every exported flag is documented — is
// tests/loadtest/storyGate.runToReport.test.ts.) The checks are pure functions of
// the README text, the scripts and the option lists, so each failure mode is also
// driven with a stubbed input below.

const ROOT = join(__dirname, '..', '..');

/** Every `flag` string anywhere inside an OPTIONS export. */
function flagsOf(o: unknown): string[] {
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    k === 'flag' && typeof v === 'string' ? [v] : flagsOf(v),
  );
}

/** Each CLI's accepted flags. A script absent here (e.g. `loadtest:secrets-template`) takes none. */
type CliFlags = Record<string, readonly string[]>;

const CLI_FLAGS: CliFlags = {
  'loadtest:preflight': flagsOf(PREFLIGHT_OPTIONS),
  'loadtest:seed': flagsOf(SEED_OPTIONS),
  'loadtest:seed:reset': flagsOf(RESET_OPTIONS),
  'loadtest:run': flagsOf(RUN_OPTIONS),
  'loadtest:report': flagsOf(REPORT_OPTIONS),
};

/**
 * Every `pnpm loadtest:<name>` invocation in the text, with the flags written after
 * it on the same line — up to a closing backtick (inline code) or the line's end.
 */
function invocations(text: string): { script: string; flags: string[] }[] {
  const out: { script: string; flags: string[] }[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/pnpm (loadtest:[a-z][a-z0-9:-]*)([^`\n]*)/g)) {
      const flags = [...m[2]!.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)].map((f) => f[1]!);
      out.push({ script: m[1]!, flags });
    }
  }
  return out;
}

/** The row ids of section 9's `### \`<row id>\`` subsections. */
function sinkSubsections(text: string): string[] {
  const start = text.search(/^## 9\. /m);
  if (start === -1) return [];
  const rest = text.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^### `([a-z0-9-]+)`/gm)].map((m) => m[1]!);
}

/** Everything wrong with the README against these scripts, flags and row ids. */
function readmeProblems(opts: {
  readme: string;
  scripts: Record<string, string>;
  cliFlags: CliFlags;
  rowIds: readonly string[];
}): string[] {
  const problems: string[] = [];
  for (const { script, flags } of invocations(opts.readme)) {
    if (!(script in opts.scripts)) problems.push(`pnpm ${script} is not a package.json script`);
    const accepted = opts.cliFlags[script] ?? [];
    for (const f of flags)
      if (!accepted.includes(f)) problems.push(`pnpm ${script} does not accept ${f}`);
  }
  const subsections = sinkSubsections(opts.readme);
  for (const id of opts.rowIds)
    if (!subsections.includes(id)) problems.push(`section 9 has no subsection for row ${id}`);
  for (const id of subsections)
    if (!opts.rowIds.includes(id)) problems.push(`section 9 subsection ${id} is not a row id`);
  const dupes = subsections.filter((id, i) => subsections.indexOf(id) !== i);
  for (const id of new Set(dupes)) problems.push(`section 9 has ${id} more than once`);
  return [...new Set(problems)];
}

const readme = readFileSync(join(ROOT, 'loadtest/README.md'), 'utf8');
const scripts = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const real = { readme, scripts, cliFlags: CLI_FLAGS, rowIds: ROW_IDS };

describe('loadtest/README.md against the CLIs it documents', () => {
  it('names only real scripts, passes only accepted flags, and has one sink subsection per row', () => {
    expect(readmeProblems(real)).toEqual([]);
  });

  it('documents each of the four CLIs with at least one invocation', () => {
    const named = new Set(invocations(readme).map((i) => i.script));
    for (const cli of ['loadtest:preflight', 'loadtest:seed', 'loadtest:run', 'loadtest:report'])
      expect(named.has(cli), cli).toBe(true);
  });

  it('has the twelve sections in order', () => {
    const numbers = [...readme.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('section 9 holds the nine row ids, in table order', () => {
    expect(sinkSubsections(readme)).toEqual([...ROW_IDS]);
  });
});

describe('the guard fails each way the README can drift', () => {
  it('a renamed script in package.json', () => {
    const { 'loadtest:report': _report, ...rest } = scripts;
    expect(readmeProblems({ ...real, scripts: { ...rest, 'loadtest:render': 'x' } })).toContain(
      'pnpm loadtest:report is not a package.json script',
    );
  });

  it('a renamed flag in a CLI’s option list', () => {
    const cliFlags = {
      ...CLI_FLAGS,
      'loadtest:run': CLI_FLAGS['loadtest:run']!.map((f) => (f === '--baseline' ? '--base' : f)),
    };
    expect(readmeProblems({ ...real, cliFlags })).toContain(
      'pnpm loadtest:run does not accept --baseline',
    );
  });

  it('a flag the README passes that no CLI accepts', () => {
    const text = `${readme}\n\`pnpm loadtest:report <run dir> --open\`\n`;
    expect(readmeProblems({ ...real, readme: text })).toContain(
      'pnpm loadtest:report does not accept --open',
    );
  });

  it('a switch-table row with no subsection', () => {
    expect(readmeProblems({ ...real, rowIds: [...ROW_IDS, 'webhooks'] })).toContain(
      'section 9 has no subsection for row webhooks',
    );
  });

  it('a subsection whose row was removed', () => {
    expect(readmeProblems({ ...real, rowIds: ROW_IDS.filter((r) => r !== 'fleet') })).toContain(
      'section 9 subsection fleet is not a row id',
    );
  });

  it('reads flags only up to the end of inline code', () => {
    expect(
      invocations('run `pnpm loadtest:run --instances 1` with `--whatever` beside it'),
    ).toEqual([{ script: 'loadtest:run', flags: ['--instances'] }]);
  });
});
