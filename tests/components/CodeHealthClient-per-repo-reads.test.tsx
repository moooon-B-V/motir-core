// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
import type { ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(overrides: { loadError?: string | false } = {}) {
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={REPOS}
      initialAudit={null}
      initialConventions={[]}
      loadError={overrides.loadError ?? false}
    />,
  );
}

async function clickRetry() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });
}

describe('CodeHealthClient — per-repo reads (MOTIR-2123)', () => {
  it('reload() refetches the WHOLE convention set — one scoped request per repo', async () => {
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    await clickRetry();

    const conventionCalls = calls.filter((c) => c.url.includes('/convention'));
    expect(
      conventionCalls.map((c) => new URL(c.url, 'http://t').searchParams.get('repoKey')),
    ).toEqual(REPOS);
  });

  it('scopes the audit read to the repo the page renders — never an unscoped fetch', async () => {
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    await clickRetry();

    const auditCalls = calls.filter((c) => c.url.includes('/audit'));
    expect(auditCalls).toHaveLength(1);
    expect(new URL(auditCalls[0]!.url, 'http://t').searchParams.get('repoKey')).toBe(REPOS[0]);
    // Both endpoints REQUIRE the param — an unscoped read is a 400, not a
    // first-repo default (motir-ai `requireQuery`).
    expect(calls.every((c) => c.url.includes('repoKey='))).toBe(true);
  });

  it('renders one convention card per repo after a reload, dropping only the underived ones', async () => {
    conventionDerived = (repoKey) => repoKey !== 'moooon/motir-core';
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    await clickRetry();

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
