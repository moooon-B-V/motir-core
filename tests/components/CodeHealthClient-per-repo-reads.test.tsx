// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
import type { ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// ⚠️ THE PLANNING DOORS READ THE ADDRESS (MOTIR-4730). Every surface that mounts
// one — and this tree mounts one — now calls `usePathname` / `useSearchParams`,
// because the workspace opens OVER the page you are on rather than navigating to
// `/planning`. Outside a router context the real hooks return `null` and the
// door throws on its first render.
const nav = vi.hoisted(() => ({
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

// The /code-health island's READS, per repo (MOTIR-2123). Two things this pins:
//
//  1. Every read is repo-SCOPED. Both boundary endpoints `requireQuery` a
//     `repoKey` (motir-ai `src/app.ts`), so an unscoped fetch is a 400 — and a
//     reload after the fan-out must refresh the WHOLE convention set, one
//     request per connected repo, not the first repo's alone.
//  2. The re-audit still POSTs `/refresh` exactly ONCE per click. The fan-out
//     happens server-side, so a poll tick that re-POSTed would queue a fresh
//     pair per repo per tick.

const REPOS = ['moooon/motir-ai', 'moooon/motir-core', 'moooon/motir-gateway'];

function surface(repoKey: string, derived = true): ConventionSurfaceDTO {
  return {
    repoKey,
    convention: derived
      ? {
          id: `conv_${repoKey}`,
          repoKey,
          version: 1,
          contentMd: `# ${repoKey} house rules`,
          provenance: [],
          createdAt: '2026-08-04T00:00:00.000Z',
        }
      : null,
    versions: [],
    nextCursor: null,
  };
}

const EMPTY_AUDIT = { audit: null, findings: [], total: 0, nextOffset: null, scanner: null };

interface Call {
  url: string;
  method: string;
}
let calls: Call[] = [];
let conventionDerived: (repoKey: string) => boolean;

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  conventionDerived = () => true;
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    // A stored run's status read — always terminal, which is what makes
    // `resumeRun()` below a one-mount entry into `reload()`.
    if (url.startsWith('/api/ai/jobs/')) return Promise.resolve(json({ status: 'succeeded' }));
    if (url.includes('/convention')) {
      const repoKey = new URL(url, 'http://t').searchParams.get('repoKey') ?? '';
      return Promise.resolve(json(surface(repoKey, conventionDerived(repoKey))));
    }
    if (url.includes('/audit')) return Promise.resolve(json(EMPTY_AUDIT));
    return Promise.resolve(json({ repos: [] }));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render() {
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={REPOS}
      // No repo has an audit yet — the pre-fan-out state these paths exercise.
      initialAudits={REPOS.map((repoKey) => ({ repoKey, surface: EMPTY_AUDIT }))}
      initialSelectedRepoKey={REPOS[0]!}
      initialSelectedAudit={null}
      initialConventions={[]}
    />,
  );
}

const RUN_KEY = 'motir:code-health:reaudit-run:proj_1';

/**
 * Mount into a landed run, which is how `reload()` is actually reached.
 *
 * These paths used to get there by seeding the island with a whole-surface
 * `loadError` and clicking the strip's Retry — a prop that could never be set
 * (MOTIR-3719) and is now gone. A run fired before the reader left the page and
 * finished while they were away is the real entry, and it is the one MOTIR-2223
 * built: the resume resolves the stored job ids, sees them terminal, and
 * re-reads every surface exactly once. Same function under test, reached the way
 * production reaches it.
 *
 * The call log is CLEARED afterwards, so each assertion below measures the
 * reload's own fan-out and not the status reads that triggered it.
 */
async function resumeRun() {
  localStorage.setItem(
    RUN_KEY,
    JSON.stringify({
      repos: REPOS.map((repoKey) => ({
        repoKey,
        auditJobId: `job_audit_${repoKey}`,
        conventionJobId: `job_conv_${repoKey}`,
      })),
    }),
  );
  render();
  await act(async () => {});
}

describe('CodeHealthClient — per-repo reads (MOTIR-2123)', () => {
  it('reload() refetches the WHOLE convention set — one scoped request per repo', async () => {
    await resumeRun();

    const conventionCalls = calls.filter((c) => c.url.includes('/convention'));
    expect(
      conventionCalls.map((c) => new URL(c.url, 'http://t').searchParams.get('repoKey')),
    ).toEqual(REPOS);
  });

  it('reloads EVERY repo’s audit, each scoped — never an unscoped fetch (MOTIR-2207)', async () => {
    await resumeRun();

    // One summary read PER connected repo: the list needs every repo's
    // `healthSummary` + `total`, so a reload that refreshed only the first
    // repo's audit would leave N−1 rows showing whatever they showed before.
    const auditCalls = calls.filter((c) => c.url.includes('/audit'));
    const scoped = auditCalls.map((c) => new URL(c.url, 'http://t'));
    expect(scoped.map((u) => u.searchParams.get('repoKey')).sort()).toEqual([...REPOS].sort());
    // Read at SUMMARY depth — `findingsLimit=1`, the cheapest limit motir-ai's
    // `parsePositiveInt` accepts (it rejects `0`).
    expect(scoped.every((u) => u.searchParams.get('findingsLimit') === '1')).toBe(true);
    // Both endpoints REQUIRE the param — an unscoped read is a 400, not a
    // first-repo default (motir-ai `requireQuery`).
    const boundaryCalls = calls.filter(
      (c) => c.url.includes('/convention') || c.url.includes('/audit'),
    );
    expect(boundaryCalls.length).toBeGreaterThan(0);
    expect(boundaryCalls.every((c) => c.url.includes('repoKey='))).toBe(true);
  });

  it('renders one convention card per repo after a reload, dropping only the underived ones', async () => {
    conventionDerived = (repoKey) => repoKey !== 'moooon/motir-core';
    await resumeRun();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Convention' }));
    });

    expect(screen.getByText('moooon/motir-ai')).toBeTruthy();
    expect(screen.getByText('moooon/motir-gateway')).toBeTruthy();
    // The repo with nothing derived yet renders no card — and does NOT suppress
    // the two that do have one (the whole point of the per-repo filter).
    expect(screen.queryByText('moooon/motir-core')).toBeNull();
  });

  it('a re-audit POSTs /refresh exactly once, however many times the poll re-reads', async () => {
    vi.useFakeTimers();
    render();

    // State B — repos connected, never audited — is where the first audit runs.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run the first audit' }));
    });
    // Drive several poll ticks (3s each); the audit surface stays empty, so the
    // poll keeps re-READING.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 4);
    });

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const polls = calls.filter((c) => c.url.includes('/audit'));
    expect(polls.length).toBeGreaterThan(1);
    expect(polls.every((c) => c.url.includes(`repoKey=${encodeURIComponent(REPOS[0]!)}`))).toBe(
      true,
    );
  });
});
