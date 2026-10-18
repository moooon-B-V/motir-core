import { createHash } from 'node:crypto';
import { parse } from 'yaml';

// WHAT ABOUT A REPOSITORY'S WORKFLOWS DECIDES THE FLEET INVENTORY'S VERDICTS?
// (MOTIR-8870)
//
// `fleetJobInventory.json` records, per job, whether the runner image can run it.
// Those verdicts depend on a job's runner, the reusable workflow it calls, the
// actions it uses and the executables its `run:` bodies invoke. They do NOT depend
// on a new step that uses tools the repository already used, on a changed
// argument, or on a shifted line. The readiness check used to call the inventory
// stale on ANY newer workflow commit, so every harmless edit blocked the switch
// until somebody re-measured by hand (motir-ai#768, motir-ai#776).
//
// This module is the "what matters" half of that check: a digest of exactly those
// inputs. The inventory records it at measure time and readiness recomputes it at
// the repository's head; equal digests mean no verdict can have moved.
//
// ⚠️ The sets are REPOSITORY-WIDE, not per job. A tool a job gains that another
// job already used cannot be seen here. That is the deliberate trade: the check
// must be cheap to keep honest, and a missed case costs a job that fails on the
// fleet and is switched off by the rule the ON window already has. A NEW tool,
// action or runner anywhere in the repository always moves the digest.

export interface WorkflowSourceFile {
  /** Repository-relative, e.g. `.github/workflows/ci.yml`. */
  path: string;
  text: string;
}

/** The workflow files and composite actions the digest reads. */
export function isFingerprintedPath(path: string): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return true;
  return /^\.github\/actions\/.+\/action\.ya?ml$/.test(path);
}

const SHELL_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/**
 * The executables a `run:` body invokes: the first word of each simple command,
 * after leading `NAME=value` assignments. Comments, here-document bodies and
 * shell keywords are skipped. Deliberately coarse — it over-reports (an `echo`
 * counts) and never under-reports a real executable at the head of a command.
 */
export function commandWords(script: string): string[] {
  const words = new Set<string>();
  let heredocEnd: string | null = null;
  const joined = script.replace(/\\\r?\n/g, ' ');
  for (const rawLine of joined.split(/\r?\n/)) {
    if (heredocEnd !== null) {
      if (rawLine.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const here = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (here) heredocEnd = here[2] ?? null;
    for (const part of line.split(/&&|\|\||;|\||\$\(|`|\(|\)/)) {
      const tokens = part.trim().split(/\s+/);
      let i = 0;
      // A keyword that introduces a command (`if gh …`, `then make`) is not the
      // command: look past it, and past assignments, to the executable.
      while (
        i < tokens.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || SHELL_WORDS.has(tokens[i]!))
      ) {
        i++;
      }
      const word = tokens[i];
      if (!word || SHELL_WORDS.has(word) || word.startsWith('#') || word.startsWith('-')) continue;
      if (word.startsWith('>') || word.startsWith('<') || /^\d?[<>]/.test(word)) continue;
      const bare = word.replace(/^['"]+|['"]+$/g, '');
      if (bare !== '') words.add(bare);
    }
  }
  return [...words];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function actionName(ref: string): string {
  // `owner/repo@v4` and `owner/repo/path@v4` are the same action at any version;
  // a local `./.github/actions/x` has no `@`.
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

function stepsOf(container: unknown): Array<Record<string, unknown>> {
  const steps = asRecord(container)?.['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.map(asRecord).filter((s): s is Record<string, unknown> => s !== null);
}

/** Canonical JSON: object keys sorted, so the digest never depends on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const rec = asRecord(value);
  if (rec) {
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface WorkflowStructure {
  /** `path#jobId` → the job's `runs-on` and the reusable workflow it calls. */
  jobs: Record<string, { runsOn: unknown; calls: string | null }>;
  /** Every action reference without its version, across the repository. */
  actions: string[];
  /** Every executable a `run:` body invokes, across the repository. */
  commands: string[];
  /** Every non-default `shell:` named. */
  shells: string[];
}

/** Parse the files and extract what the verdicts depend on. A file that is not
 *  valid YAML throws: the caller treats that as "cannot tell", never "unchanged". */
export function workflowStructure(files: WorkflowSourceFile[]): WorkflowStructure {
  const jobs: WorkflowStructure['jobs'] = {};
  const actions = new Set<string>();
  const commands = new Set<string>();
  const shells = new Set<string>();

  const readSteps = (container: unknown) => {
    for (const step of stepsOf(container)) {
      if (typeof step['uses'] === 'string') actions.add(actionName(step['uses']));
      if (typeof step['run'] === 'string')
        for (const w of commandWords(step['run'])) commands.add(w);
      if (typeof step['shell'] === 'string') shells.add(step['shell']);
    }
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const doc = asRecord(parse(file.text));
    if (!doc) continue;
    if (file.path.startsWith('.github/actions/')) {
      readSteps(asRecord(doc['runs']));
      continue;
    }
    const defaults = asRecord(asRecord(doc['defaults'])?.['run']);
    if (typeof defaults?.['shell'] === 'string') shells.add(defaults['shell']);
    for (const [jobId, raw] of Object.entries(asRecord(doc['jobs']) ?? {})) {
      const job = asRecord(raw);
      if (!job) continue;
      const jobDefaults = asRecord(asRecord(job['defaults'])?.['run']);
      if (typeof jobDefaults?.['shell'] === 'string') shells.add(jobDefaults['shell']);
      jobs[`${file.path}#${jobId}`] = {
        runsOn: job['runs-on'] ?? null,
        calls: typeof job['uses'] === 'string' ? actionName(job['uses']) : null,
      };
      readSteps(job);
    }
  }

  return {
    jobs,
    actions: [...actions].sort(),
    commands: [...commands].sort(),
    shells: [...shells].sort(),
  };
}

/** The digest the inventory records and readiness recomputes. */
export function workflowFingerprint(files: WorkflowSourceFile[]): string {
  return createHash('sha256')
    .update(canonical(workflowStructure(files.filter((f) => isFingerprintedPath(f.path)))))
    .digest('hex');
}
