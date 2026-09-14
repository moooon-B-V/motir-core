import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrMergeMode } from '@/generated/prisma/enums';
import { PR_MERGE_MODE_VALUES } from '@/lib/dto/projects';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// CONTRACT GUARDS — Story MOTIR-4880 · MOTIR-5182. The things a coverage figure
// cannot see, asserted every run instead of reviewed once.
//
//   1. The provenance comparison has exactly ONE spelling —
//      `lib/git/hostOwnership.ts`. Two surfaces each spelling "is this owner the
//      provisioning organisation?" is how bug MOTIR-4892 happened.
//   2. `Workspace.subtaskPrMergeMode` has NO application reader. This is the
//      retirement story's (MOTIR-5175) starting evidence: the column can be
//      `@ignore`d because nothing under `lib/`, `app/` or `components/` names it.
//   3. Every lookup keyed off `PrMergeMode` is TOTAL: the app's value list is the
//      generated enum's, and the control's copy carries a label and hint for every
//      member in both locales.
//   4. `en` and `zh` carry identical keys for the control.
//
// Each tree scan carries a self-test on a synthetic line, because a guard nobody
// has seen fail is not evidence.

const ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = ['lib', 'app', 'components'];

function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry)) {
        out.push({ path: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
      }
    }
  };
  for (const r of SOURCE_ROOTS) walk(join(ROOT, r));
  return out;
}

/** Strip `//` line comments and block comments, so prose never trips a guard. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1 · the provenance comparison ──────────────────────────────────────────

const HOST_OWNERSHIP = 'lib/git/hostOwnership.ts';

/**
 * A line that COMPARES something against the provisioning organisation: the
 * provisioning login (or a `hostOwner` holding it) on one side of an equality or
 * a case-folded match. A null check (`provisioningOrgLogin() !== null`) is a
 * capability test, not a provenance comparison, and is allowed.
 */
function provenanceComparisons(source: string): string[] {
  return code(source)
    .split('\n')
    .filter((line) => /provisioningOrgLogin\(\)|\bhostOwner\b|GITHUB_FALLBACK_ORG/.test(line))
    .filter((line) => /===|!==|\blocaleCompare\(|\.toLowerCase\(\)|\.toUpperCase\(\)/.test(line))
    .filter((line) => !/(===|!==)\s*(null|undefined)\b|\b(null|undefined)\s*(===|!==)/.test(line))
    .map((line) => line.trim());
}

describe('the provenance comparison has exactly ONE spelling', () => {
  it('no module outside lib/git/hostOwnership.ts compares an owner against the provisioning organisation', () => {
    const offenders = sourceFiles()
      .filter((f) => f.path !== HOST_OWNERSHIP)
      .flatMap((f) => provenanceComparisons(f.text).map((line) => `${f.path}: ${line}`));
    expect(
      offenders,
      'call isMotirHostedOwner(owner, hostOwner) instead of spelling the comparison again',
    ).toEqual([]);
  });

  it('the one home really does spell it (the scan is not blind)', () => {
    const home = readFileSync(join(ROOT, HOST_OWNERSHIP), 'utf8');
    expect(home).toContain('export function isMotirHostedOwner');
  });

  it('SELF-TEST: a second spelling is caught, a null check and a comment are not', () => {
    expect(
      provenanceComparisons('if (repo.owner.toLowerCase() === hostOwner.toLowerCase()) {'),
    ).toHaveLength(1);
    expect(provenanceComparisons('const hosted = owner === provisioningOrgLogin();')).toHaveLength(
      1,
    );
    expect(provenanceComparisons('return provisioningOrgLogin() !== null;')).toEqual([]);
    expect(provenanceComparisons('// owner === hostOwner is what we do NOT write')).toEqual([]);
  });
});

// ── 2 · the retired column has no reader ───────────────────────────────────

function oldFieldReaders(source: string): string[] {
  return code(source)
    .split('\n')
    .filter((line) => /\bsubtaskPrMergeMode\b|\bsubtask_pr_merge_mode\b/.test(line))
    .map((line) => line.trim());
}

describe('Workspace.subtaskPrMergeMode has no application reader', () => {
  it('nothing under lib/, app/ or components/ names the field', () => {
    const readers = sourceFiles().flatMap((f) =>
      oldFieldReaders(f.text).map((line) => `${f.path}: ${line}`),
    );
    expect(readers).toEqual([]);
  });

  it('SELF-TEST: a read is caught, a comment is not', () => {
    expect(oldFieldReaders('const m = workspace.subtaskPrMergeMode;')).toHaveLength(1);
    expect(oldFieldReaders('// was Workspace.subtaskPrMergeMode (MOTIR-4880)')).toEqual([]);
  });
});

// ── 3 · totality over PrMergeMode ─────────────────────────────────────────

describe('every lookup keyed off PrMergeMode is total', () => {
  const members = Object.values(PrMergeMode).sort();

  it('the enum carries exactly the two live members', () => {
    expect(members).toEqual(['auto', 'manual']);
  });

  it('the app value list is the generated enum, member for member', () => {
    expect([...PR_MERGE_MODE_VALUES].sort()).toEqual(members);
  });

  it.each([
    ['en', en],
    ['zh', zh],
  ])('%s carries a non-empty label and hint for every member', (_locale, catalog) => {
    const node = (catalog as { approvals: { mergeMode: Record<string, unknown> } }).approvals
      .mergeMode;
    for (const member of members) {
      const copy = node[member] as { label?: string; hint?: string } | undefined;
      expect(copy?.label?.trim(), `${member}.label`).toBeTruthy();
      expect(copy?.hint?.trim(), `${member}.hint`).toBeTruthy();
    }
  });

  it('no source module switches on a merge mode without covering every member', () => {
    const partial = sourceFiles().filter((f) => {
      const src = code(f.text);
      const m = src.match(/switch\s*\([^)]*[pP]rMergeMode[^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
      if (!m) return false;
      return members.some((member) => !m[1]!.includes(`'${member}'`));
    });
    expect(partial.map((f) => f.path)).toEqual([]);
  });
});

// ── 4 · locale parity ──────────────────────────────────────────────────────

describe('the control copy ships with identical keys in both locales', () => {
  function keys(node: unknown, prefix = ''): string[] {
    if (typeof node !== 'object' || node === null) return [prefix];
    return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }

  it('approvals.mergeMode in en and zh', () => {
    const pick = (c: unknown) => (c as { approvals: { mergeMode: unknown } }).approvals.mergeMode;
    expect(keys(pick(zh)).sort()).toEqual(keys(pick(en)).sort());
  });
});
