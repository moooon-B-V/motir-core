import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { v1OperationIds } from '@/lib/api/v1/openapi/registry';

// The CONTRACT-VERSION guard — a new operation cannot ship unnamed (MOTIR-3157).
//
// `docs/decisions/public-api-conventions.md` §8 lists "a new endpoint" first
// among the additive changes, and Amendment 8 turns the bump from documentation
// into an obligation: the number rides `X-Motir-Api-Version` on EVERY v1
// response, and `packages/cli/src/transport.ts` compares it against the version
// its generated client was built for. That comparison is the whole mechanism by
// which a client tells an old server from a new one, and it works by trusting
// that the number moved when the surface grew.
//
// It grew twice without moving. `uploadWorkItemAttachment` (MOTIR-3000, #2145)
// shipped under `1.11.0`; `targetRepositories`' own bump shipped under
// MOTIR-2732 and its log line arrived retroactively (see the `1.11.0` entry).
// Nothing caught either, because `openapi-operations-coverage.test.ts` asserts
// that every declared operation is EMITTED — not that declaring one moved the
// version. So the obligation was prose, and prose is discharged by whoever
// remembers it.
//
// ⚠️ WHAT THIS GUARD CAN AND CANNOT SEE. It compares the OPERATION SET against
// the version log, so it fires on a new endpoint and only on a new endpoint. A
// new response FIELD, a new header, a new enum value — §8's other additive
// limbs — leave the operation set untouched and are still on the author. That
// is a deliberate floor rather than an oversight: an endpoint is the one
// additive change whose arrival is a VALUE this process can read, and a guard
// that covered the rest would have to diff shipped schemas against a snapshot
// nobody would keep current.
//
// ⚠️ AND IT IS A NAMING RULE, NOT A HISTORY CHECK. A test cannot see the
// previous commit, so it cannot know whether the constant moved IN THE SAME PR
// as the operation. What it can require is that the operation be NAMED in an
// entry of the version log — which is unsatisfiable without either bumping the
// constant (the log's last entry is asserted to BE the constant, below) or
// editing a historical entry to claim an operation it never shipped. The second
// is possible and is a loud line in a diff; forgetting is not possible at all,
// which is the whole difference this file makes.

const REPO_ROOT = process.cwd();
const CONTRACT_VERSION_FILE = join('lib', 'api', 'v1', 'contractVersion.ts');

/**
 * The operation set as it stood when this guard was written — every id whose
 * introducing log entry names it by PATH or by field rather than by
 * `operationId`, because the id-naming convention starts here.
 *
 * FROZEN. It grows only when an operation is REMOVED from it, which §8 forbids
 * without a new major, so in practice it never grows at all: a new operation is
 * named in a version entry instead. `uploadWorkItemAttachment` is deliberately
 * ABSENT — it is this card's own subject, and proving it through the log is the
 * point.
 */
const OPERATIONS_PREDATING_THE_GUARD: readonly string[] = [
  'appendPlanTurn',
  'archiveWorkItem',
  'completeSession',
  'completeSprint',
  'countProjectWorkItems',
  'createSprint',
  'createWorkItem',
  'createWorkItemComment',
  'createWorkItemLink',
  'deleteWorkItemLink',
  'getMe',
  'getPlan',
  'getPlanStatus',
  'getProject',
  'getProjectBacklog',
  'getProjectReadySet',
  'getSprint',
  'getWorkItem',
  'getWorkItemActivity',
  'getWorkItemDispatchPrompt',
  'listProjectSprints',
  'listProjectWorkItems',
  'listProjects',
  'listSprintWorkItems',
  'listWorkItemComments',
  'listWorkItemLinks',
  'listWorkItemTransitions',
  'listWorkspaces',
  'moveWorkItemsToBacklog',
  'moveWorkItemsToSprint',
  'openPlanSession',
  'recordWorkItemIntegration',
  'reportWorkItemImplementation',
  'restoreWorkItem',
  'startSprint',
  'submitPlanSession',
  'submitWorkItemExpansion',
  'transitionWorkItem',
  'updateSprint',
  'updateWorkItem',
];

/** One entry of `V1_CONTRACT_VERSION`'s per-version log. */
interface ContractVersionEntry {
  version: string;
  /** The entry's prose, its continuation lines joined with single spaces. */
  text: string;
}

/**
 * Parse the ` * - `1.2.3` — …` list out of the constant's docstring.
 *
 * Read from the SOURCE rather than from a second exported constant: the log a
 * human writes is the artifact the obligation is discharged in, and a parallel
 * machine-readable copy would just be one more thing to forget to update.
 */
function parseContractVersionLog(source: string): ContractVersionEntry[] {
  const entries: ContractVersionEntry[] = [];
  let open: { version: string; parts: string[] } | undefined;

  const close = () => {
    if (open) entries.push({ version: open.version, text: open.parts.join(' ') });
    open = undefined;
  };

  for (const line of source.split('\n')) {
    const comment = /^\s*\*(.*)$/.exec(line);
    if (!comment) {
      close();
      continue;
    }
    const body = (comment[1] ?? '').replace(/^ /, '').trimEnd();
    const opened = /^- `(\d+\.\d+\.\d+)` — (.+)$/.exec(body);
    if (opened) {
      close();
      open = { version: opened[1] as string, parts: [opened[2] as string] };
      continue;
    }
    // A continuation is indented under its bullet; anything else ends the entry.
    if (open && /^\s+\S/.test(body)) {
      open.parts.push(body.trim());
      continue;
    }
    close();
  }
  close();
  return entries;
}

/** Compare two `MAJOR.MINOR.PATCH` strings numerically. */
function compareContractVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The operations no version entry accounts for — the guard, as a pure function
 * so it can be driven with an operation that is not really there.
 */
function operationsWithNoVersionEntry(
  operationIds: readonly string[],
  frozen: readonly string[],
  log: readonly ContractVersionEntry[],
): string[] {
  return operationIds.filter(
    (id) =>
      !frozen.includes(id) && !log.some((entry) => new RegExp(`\\b${id}\\b`).test(entry.text)),
  );
}

const source = readFileSync(join(REPO_ROOT, CONTRACT_VERSION_FILE), 'utf8');
const log = parseContractVersionLog(source);
const operationIds = v1OperationIds();

describe('the v1 contract version accounts for every operation', () => {
  it('reads a whole log and a whole registry — neither sweep is vacuously empty', () => {
    // Both inputs are DISCOVERED, so a parser that matched nothing (or a
    // registry import that resolved to an empty array) would make the
    // assertions below pass while checking nothing at all.
    expect(log.length).toBeGreaterThan(10);
    expect(log[0]?.version).toBe('1.0.0');
    expect(operationIds.length).toBeGreaterThanOrEqual(40);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('names EVERY operation the frozen set does not cover, in a version entry', () => {
    const unnamed = operationsWithNoVersionEntry(operationIds, OPERATIONS_PREDATING_THE_GUARD, log);
    expect(
      unnamed,
      `these operations are declared but no V1_CONTRACT_VERSION entry names them: ${unnamed.join(', ')}. ` +
        'A new endpoint is an additive change (public-api-conventions.md §8), and Amendment 8 ' +
        'makes the bump obligatory: raise V1_CONTRACT_VERSION to the next MINOR, add a log entry ' +
        'naming the operationId and why it is additive, then run `pnpm generate:cli-api`.',
    ).toEqual([]);
  });

  it('proves `uploadWorkItemAttachment` through the LOG, not through the frozen set', () => {
    // MOTIR-3157's own subject. If it were in the frozen list, deleting its
    // `1.13.0` entry would leave this suite green — which is the shape of a
    // guard that agrees with whatever it finds.
    expect(OPERATIONS_PREDATING_THE_GUARD).not.toContain('uploadWorkItemAttachment');
    expect(operationIds).toContain('uploadWorkItemAttachment');
  });

  it('still finds every frozen operation — a removal is a MAJOR, not a quiet edit', () => {
    // The other direction, and the reason the frozen list is a list rather than
    // a count: §8 forbids removing an operation without a new major, so an id
    // that disappears from the registry must be a deliberate edit HERE, with a
    // reviewer looking at it.
    const gone = OPERATIONS_PREDATING_THE_GUARD.filter((id) => !operationIds.includes(id));
    expect(gone, `frozen operations no longer declared: ${gone.join(', ')}`).toEqual([]);
  });

  it('ends the log at the version the server actually serves', () => {
    // This is what makes the naming rule above cost a BUMP: a new entry can
    // only be the last one, and the last one must be the constant.
    expect(log.at(-1)?.version).toBe(V1_CONTRACT_VERSION);
  });

  it('walks the log strictly upward, so a renumbered entry cannot pass', () => {
    // Two changes in flight both take "the next minor", and whichever merges
    // second renumbers. A version that repeats or goes backwards is that edit
    // half-done.
    for (let i = 1; i < log.length; i += 1) {
      const previous = log[i - 1] as ContractVersionEntry;
      const current = log[i] as ContractVersionEntry;
      expect(
        compareContractVersions(current.version, previous.version),
        `${current.version} does not follow ${previous.version}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('the guard is DRIVEN, not trusted', () => {
  it('REPORTS an operation that arrived with no entry naming it', () => {
    // The failure this file exists for, reproduced against the real log: an
    // operation declared today, under a version log that has never heard of it.
    expect(
      operationsWithNoVersionEntry(
        [...operationIds, 'deleteEntireWorkspace'],
        OPERATIONS_PREDATING_THE_GUARD,
        log,
      ),
    ).toEqual(['deleteEntireWorkspace']);
  });

  it('is not satisfied by a MENTION of a similar name', () => {
    // `\b` matching, driven: an entry about `uploadWorkItemAttachment` does not
    // discharge `uploadWorkItemAttachments`, which is a different operation and
    // would be a different endpoint.
    expect(
      operationsWithNoVersionEntry(
        ['uploadWorkItemAttachments'],
        OPERATIONS_PREDATING_THE_GUARD,
        log,
      ),
    ).toEqual(['uploadWorkItemAttachments']);
  });

  it('accepts an operation the moment an entry names it', () => {
    const named: ContractVersionEntry[] = [
      ...log,
      { version: '9.9.9', text: 'MOTIR-0000 adds `deleteEntireWorkspace`, hypothetically.' },
    ];
    expect(
      operationsWithNoVersionEntry(
        [...operationIds, 'deleteEntireWorkspace'],
        OPERATIONS_PREDATING_THE_GUARD,
        named,
      ),
    ).toEqual([]);
  });

  it('parses a multi-line entry as ONE entry, joined', () => {
    // The log's entries are mostly several lines long, so a parser that kept
    // only the first line would silently stop finding ids named in the rest.
    const parsed = parseContractVersionLog(
      [
        '/**',
        ' * - `1.0.0` — the founding set.',
        ' * - `1.1.0` — MOTIR-1 adds a thing,',
        ' *   and names `someOperationId` on its second line.',
        ' */',
        "export const V1_CONTRACT_VERSION = '1.1.0';",
      ].join('\n'),
    );
    expect(parsed.map((entry) => entry.version)).toEqual(['1.0.0', '1.1.0']);
    expect(parsed[1]?.text).toBe(
      'MOTIR-1 adds a thing, and names `someOperationId` on its second line.',
    );
    expect(operationsWithNoVersionEntry(['someOperationId'], [], parsed)).toEqual([]);
  });

  it('finds the real entry that names this card’s operation, at whatever minor it landed on', () => {
    // Located by CONTENT, never by version: two additive changes in flight both
    // take "the next minor" and the one that merges second renumbers, so a
    // hardcoded `1.13.0` here would be a test that fails on a rebase for no
    // reason a reader could act on.
    const entry = log.find((candidate) => /\buploadWorkItemAttachment\b/.test(candidate.text));
    expect(entry, 'no version entry names uploadWorkItemAttachment').toBeDefined();
    expect(entry?.text).toContain('MOTIR-3157');
  });
});
