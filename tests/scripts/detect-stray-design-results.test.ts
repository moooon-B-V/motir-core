import { describe, expect, it } from 'vitest';
import {
  EXIT_BLIND_READ,
  EXIT_CLEAN,
  EXIT_FLAGGED,
  designFileCount,
  formatResult,
  scan,
} from '../../scripts/detectStrayDesignResults.mjs';

// MOTIR-3227 — the stray-design-result scan, and the reason it needed a test at
// all.
//
// The script's exit code is, in its own header's words, "what lets the
// post-withdrawal re-run be an assertion rather than something somebody reads."
// On 2026-08-20 a production run of it printed `Scanned 0 design_evidence row(s)
// … No stray or over-published design results. ✓` and exited 0 — against 42 live
// rows. `design_evidence` is FORCE ROW LEVEL SECURITY and the pooled
// `DATABASE_URL` resolves to `motir_app`, which has no `rolbypassrls` and sets
// no tenant GUC, so every policy matched nothing. The query did not fail; it
// succeeded over an empty set, and the script's only failure mode was
// `flagged.length > 0`.
//
// So these specs assert the two halves that make the exit code mean something,
// and they are deliberately BOTH here: a guard that only ever exits non-zero
// asserts as little as one that only ever exits zero.

/** A `pg.Client.query`-shaped stub that answers by matching on the SQL. */
const stubQuery =
  (answers: { connection?: unknown; total: number; rows?: unknown[] }) => (sql: string) => {
    if (sql.includes('current_user')) {
      return Promise.resolve({
        rows: [
          answers.connection ?? {
            role: 'motir_app',
            bypasses_rls: false,
            rls_forced: true,
            workspace_id: '',
          },
        ],
      });
    }
    if (sql.includes('count(*)::int AS total')) {
      return Promise.resolve({ rows: [{ total: answers.total }] });
    }
    return Promise.resolve({ rows: answers.rows ?? [] });
  };

/** A GitHub stub: run 1 -> branch `b1` -> PR #10, whose file list we control. */
const stubGh = (files: { filename: string }[], calls?: string[]) => (path: string) => {
  calls?.push(path);
  if (path.includes('/actions/runs/')) return Promise.resolve({ head_branch: 'b1' });
  if (path.includes('/pulls?')) return Promise.resolve([{ number: 10 }]);
  if (path.includes('/pulls/10/files')) {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
    return Promise.resolve(page === 1 ? files : []);
  }
  throw new Error(`unexpected GitHub path: ${path}`);
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cmevidence1',
  identifier: 'MOTIR-1',
  is_current: true,
  ci_run_url: 'https://github.com/moooon-B-V/motir-core/actions/runs/555',
  withdrawn_at: null,
  assets: 3,
  ...over,
});

describe('detect-stray-design-results — the EMPTY population is a broken read', () => {
  it('exits non-zero and names the empty population when the connection sees no rows', async () => {
    const ghCalls: string[] = [];
    const result = await scan({
      query: stubQuery({ total: 0 }),
      gh: stubGh([], ghCalls),
      repo: 'moooon-B-V/motir-core',
    });

    expect(result.blindRead).toBe(true);
    expect(result.exitCode).toBe(EXIT_BLIND_READ);
    expect(result.exitCode).not.toBe(EXIT_CLEAN);

    const output = formatResult(result);
    expect(output).toContain('Scanned 0 of 0 design_evidence row(s)');
    expect(output).toContain(
      'this is not a clean sweep, it is a connection\nthat cannot see the table',
    );
    // It names the connected role and whether that role bypasses RLS — the two
    // facts that tell the reader WHICH of the two empty-population causes it is.
    expect(output).toContain('Connected as motir_app (bypasses RLS: no');
    expect(output).toContain('DATABASE_URL_UNPOOLED');
    // The vacuous run was also the FASTEST one — no rows meant no API calls.
    // Nothing should reach GitHub on this path either, but now it reports so.
    expect(ghCalls).toEqual([]);
  });

  it('still refuses on an empty table read by a role that DOES bypass RLS', async () => {
    const result = await scan({
      query: stubQuery({
        total: 0,
        connection: {
          role: 'neondb_owner',
          bypasses_rls: true,
          rls_forced: true,
          workspace_id: '',
        },
      }),
      gh: stubGh([]),
      repo: 'moooon-B-V/motir-core',
    });

    expect(result.exitCode).toBe(EXIT_BLIND_READ);
    const output = formatResult(result);
    expect(output).toContain('Connected as neondb_owner (bypasses RLS: yes');
    expect(output).toContain('That role DOES bypass RLS, so the table really is empty');
  });
});

describe('detect-stray-design-results — the NON-EMPTY population still reports honestly', () => {
  it('exits 0 on a clean sweep and prints the scanned count AND the denominator', async () => {
    const result = await scan({
      query: stubQuery({
        total: 3, // three rows exist; one of them is withdrawn
        rows: [row(), row({ id: 'cmevidence2', identifier: 'MOTIR-2' })],
      }),
      // Three files under design/ against each row's three assets: a publish
      // that is a subset of what its pull request authored.
      gh: stubGh([
        { filename: 'design/work-items/detail.png' },
        { filename: 'design/work-items/detail.mock.html' },
        { filename: 'design/work-items/design-notes.md' },
        { filename: 'lib/x.ts' },
      ]),
      repo: 'moooon-B-V/motir-core',
    });

    expect(result.blindRead).toBe(false);
    expect(result.exitCode).toBe(EXIT_CLEAN);

    const output = formatResult(result);
    // `0 of 0` is what the guard above catches; `2 of 3` is what makes it legible.
    expect(output).toContain(
      'Scanned 2 of 3 design_evidence row(s) against moooon-B-V/motir-core (1 excluded as withdrawn)',
    );
    expect(output).toContain('No stray or over-published design results. ✓');
  });

  it('exits 1 and lists the row when the publishing pull request authored no design', async () => {
    const result = await scan({
      query: stubQuery({ total: 1, rows: [row({ assets: 101 })] }),
      gh: stubGh([{ filename: 'lib/services/x.ts' }]), // zero files under design/
      repo: 'moooon-B-V/motir-core',
    });

    expect(result.exitCode).toBe(EXIT_FLAGGED);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].verdict).toBe('STRAY');

    const output = formatResult(result);
    expect(output).toContain('Scanned 1 of 1 design_evidence row(s)');
    expect(output).toContain('STRAY');
    expect(output).toContain('PR #10');
  });

  it('exits 1 on an over-publish (more assets than the pull request authored)', async () => {
    const result = await scan({
      query: stubQuery({ total: 1, rows: [row({ assets: 5 })] }),
      gh: stubGh([
        { filename: 'design/a.png' },
        { filename: 'design/b.png' },
        { filename: 'lib/x.ts' },
      ]),
      repo: 'moooon-B-V/motir-core',
    });

    expect(result.exitCode).toBe(EXIT_FLAGGED);
    expect(result.flagged[0].verdict).toBe('OVER-PUBLISH');
  });
});

describe('detect-stray-design-results — the file count follows pagination', () => {
  // MOTIR-3220, one hop over: `gh pr view --json files` caps at 100 and the cap
  // became a finding. This counts through the paginated REST list, so a pull
  // request with more than 100 files must not stop at the first page.
  it('counts design files past the first page of 100', async () => {
    const pageOf = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.png` }));

    const gh = (path: string) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
      if (page === 1) return Promise.resolve(pageOf(100, 'design/p1-'));
      if (page === 2) return Promise.resolve(pageOf(38, 'design/p2-'));
      return Promise.resolve([]);
    };

    await expect(designFileCount(gh, 'moooon-B-V/motir-core', 2161)).resolves.toBe(138);
  });
});
