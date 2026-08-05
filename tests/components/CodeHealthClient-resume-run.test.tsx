// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';

// An in-flight audit must SURVIVE the page (MOTIR-2223). `AuditPanel`'s deriving
// copy invites the user to leave — "You can leave this page — the audit keeps
// running" — and the job half was always true. The PAGE half was not: the run
// lived in `useState` and the trigger's returned job ids were discarded, so a
// returning user met State B's PRIMARY "Run the first audit" on a project
// mid-audit, and one click queued the whole MOTIR-2123 fan-out a second time.
//
// What these pin, all against a REMOUNT (a fresh mount seeded exactly as the
// server seeds it — the state the returning user actually gets):
//
//  1. Fired-then-remounted renders the DERIVING state, never State B.
//  2. While the run is unresolved there is NO trigger on screen at all — not a
//     disabled one — so the duplicate-POST window is closed rather than narrowed.
//  3. A terminal job clears its record and re-reads the audit surface once.
//  4. A 404 / rejected status read clears the record and falls back to the
//     shipped pre-audit states, with no error strip.
//  5. `POST /refresh` is still exactly once per click, and the resume path never
//     POSTs at all.
//  6. A browser with no `localStorage` behaves exactly as it did before.

const REPOS = ['moooon/motir-ai', 'moooon/motir-core'];
const RUN_KEY = 'motir:code-health:reaudit-run:proj_1';

const EMPTY_AUDIT = { audit: null, findings: [], total: 0, nextOffset: null, scanner: null };
const LANDED_AUDIT = {
  audit: {
    id: 'audit_2',
    repoKey: REPOS[0],
    createdAt: '2026-08-05T00:00:00.000Z',
    healthSummary: { conformancePct: 80, grade: 'B' },
  },
  findings: [],
  total: 0,
  nextOffset: null,
  scanner: null,
};

const REFRESH_RESULT = {
  repos: [
    { repoKey: REPOS[0], auditJobId: 'job_audit_1', conventionJobId: 'job_conv_1' },
    { repoKey: REPOS[1], auditJobId: 'job_audit_2', conventionJobId: 'job_conv_2' },
  ],
};

interface Call {
  url: string;
  method: string;
}
let calls: Call[] = [];
/** What `GET /api/ai/jobs/:id` answers with. Defaults to an in-flight run. */
let jobReply: (jobId: string) => Promise<Response>;
/** What the audit surface reads back — swapped mid-test to land an audit. */
let auditBody: unknown = EMPTY_AUDIT;
/** What `POST /refresh` answers with — the ids the record is built from. */
let refreshResult: unknown = REFRESH_RESULT;

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}
function notFound(): Response {
  return { ok: false, status: 404, json: async () => ({ code: 'JOB_NOT_FOUND' }) } as Response;
}
const jobStatus = (status: string) => json({ status, result: null });

beforeEach(() => {
  calls = [];
  auditBody = EMPTY_AUDIT;
  refreshResult = REFRESH_RESULT;
  jobReply = () => Promise.resolve(jobStatus('running'));
  localStorage.clear();
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.startsWith('/api/ai/jobs/')) return jobReply(url.slice('/api/ai/jobs/'.length));
    if (url.includes('/convention')) {
      const repoKey = new URL(url, 'http://t').searchParams.get('repoKey') ?? '';
      return Promise.resolve(json({ repoKey, convention: null, versions: [], nextCursor: null }));
    }
    if (url.includes('/audit')) return Promise.resolve(json(auditBody));
    return Promise.resolve(json(refreshResult));
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render() {
  // Seeded exactly as the server seeds it on a fresh navigation: the island gets
  // its props from `page.tsx` and knows nothing else.
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={REPOS}
      initialAudit={null}
      initialConventions={[]}
      loadError={false}
    />,
  );
}

const jobCalls = () => calls.filter((c) => c.url.startsWith('/api/ai/jobs/'));
const auditCalls = () => calls.filter((c) => c.url.includes('/coding-convention/audit'));
const postCalls = () => calls.filter((c) => c.method === 'POST');

/** State B's primary trigger — the button whose whole meaning is "nothing has
 * happened yet", and the one click that used to duplicate the fan-out. */
const firstAuditButton = () => screen.queryByRole('button', { name: 'Run the first audit' });

describe('CodeHealthClient — an in-flight audit survives the page (MOTIR-2223)', () => {
  it('remounting after a re-audit renders the deriving state, not State B', async () => {
    vi.useFakeTimers();
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run the first audit' }));
    });
    expect(localStorage.getItem(RUN_KEY)).toContain('job_audit_1');

    // The user leaves. Everything held in component state goes with the page.
    cleanup();
    calls = [];

    // ...and comes back, on a project whose audit is still running.
    jobReply = () => Promise.resolve(jobStatus('running'));
    render();
    await act(async () => {});

    expect(screen.getByText('Deriving your first audit…')).toBeTruthy();
    expect(screen.queryByText('No audit for this code yet')).toBeNull();
    expect(firstAuditButton()).toBeNull();
    // Resuming READS the run's status; it never re-fires it.
    expect(postCalls()).toHaveLength(0);
    expect(jobCalls().map((c) => c.url)).toEqual([
      '/api/ai/jobs/job_audit_1',
      '/api/ai/jobs/job_audit_2',
    ]);
  });

  it('renders NO trigger while the run is unresolved — before the first status read answers', async () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    // The status read never settles, so the render below is exactly the moment
    // the page knows a run exists and nothing else about it.
    jobReply = () => new Promise<Response>(() => {});

    render();
    await act(async () => {});

    expect(firstAuditButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.getByText('Deriving your first audit…')).toBeTruthy();
    expect(jobCalls()).toHaveLength(2);
  });

  it('a TERMINAL stored run clears its entry and re-reads the audit surface exactly once', async () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    jobReply = () => Promise.resolve(jobStatus('succeeded'));
    auditBody = LANDED_AUDIT;

    render();
    await act(async () => {});

    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    // Asserted on the URLs actually fetched, not by reading the component: the
    // re-read is one scoped audit request, and it happened once.
    expect(auditCalls()).toHaveLength(1);
    expect(new URL(auditCalls()[0]!.url, 'http://t').searchParams.get('repoKey')).toBe(REPOS[0]);
    // The report the run produced is now on screen, so no pre-audit state at all.
    expect(firstAuditButton()).toBeNull();
    expect(screen.queryByText('Deriving your first audit…')).toBeNull();
  });

  it('a stored run whose status read 404s clears its entry and falls back to the pre-audit states', async () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    jobReply = () => Promise.resolve(notFound());

    render();
    await act(async () => {});

    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    // The trigger is available again — a stale id can never wedge the page.
    expect(firstAuditButton()).toBeTruthy();
    // Nothing landed, so nothing is re-read...
    expect(auditCalls()).toHaveLength(0);
    // ...and a job motir-ai no longer knows is not an error the user did.
    expect(screen.queryByText(/Couldn’t/)).toBeNull();
  });

  it('a stored run whose status read REJECTS clears its entry and shows no error strip', async () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    jobReply = () => Promise.reject(new Error('network down'));

    render();
    await act(async () => {});

    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    expect(firstAuditButton()).toBeTruthy();
    expect(screen.queryByText(/Couldn’t/)).toBeNull();
  });

  // Four shapes of unusable record, one assertion each: none of them may wedge
  // the page, and none may send the mount off reading job ids it does not have.
  it.each([
    ['unparseable JSON', '{ not json'],
    ['a record with no repos array', JSON.stringify({ repos: 'nope' })],
    ['a record whose entries carry no job id', JSON.stringify({ repos: [{ repoKey: 'a/b' }] })],
    ['a record whose job id is not a string', JSON.stringify({ repos: [{ auditJobId: 42 }] })],
  ])('treats %s as no record — the trigger stays available', async (_label, raw) => {
    localStorage.setItem(RUN_KEY, raw);

    render();
    await act(async () => {});

    expect(firstAuditButton()).toBeTruthy();
    expect(jobCalls()).toHaveLength(0);
  });

  it('a status body with no `status` at all is treated as terminal, not as in-flight', async () => {
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    jobReply = () => Promise.resolve(json({ result: null }));

    render();
    await act(async () => {});

    // Unknown is not "still running": guessing in-flight would hide the trigger
    // forever on a record nothing can ever resolve.
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    expect(firstAuditButton()).toBeTruthy();
  });

  it('a refresh answering with no usable job id stores nothing, and still derives', async () => {
    vi.useFakeTimers();
    // Any answer whose ids are absent: there is nothing to resume, so nothing is
    // written — but the run itself is unaffected and the screen is honest.
    refreshResult = { repos: [{ repoKey: null, auditJobId: null, conventionJobId: null }] };
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run the first audit' }));
    });

    expect(postCalls()).toHaveLength(1);
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    expect(screen.getByText('Deriving your first audit…')).toBeTruthy();
  });

  it('a poll read that FAILS is skipped, not fatal — the next tick still lands the audit', async () => {
    vi.useFakeTimers();
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));

    let auditReads = 0;
    const realAuditBody = () => {
      auditReads += 1;
      return auditReads === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : json(auditBody);
    };
    vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('/api/ai/jobs/')) return Promise.resolve(jobStatus('running'));
      if (url.includes('/convention'))
        return Promise.resolve(
          json({ repoKey: '', convention: null, versions: [], nextCursor: null }),
        );
      if (url.includes('/audit')) return Promise.resolve(realAuditBody() as Response);
      return Promise.resolve(json(REFRESH_RESULT));
    });

    render();
    await act(async () => {});
    auditBody = LANDED_AUDIT;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 3);
    });

    expect(auditReads).toBeGreaterThan(1);
    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it('POSTs /refresh exactly once per click, and the resumed run POSTs nothing', async () => {
    vi.useFakeTimers();
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run the first audit' }));
    });
    // Several poll ticks: the surface stays empty, so the run keeps re-READING.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 4);
    });
    expect(postCalls()).toHaveLength(1);

    cleanup();
    calls = [];
    render();
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 4);
    });

    // The resumed run observes; it never re-queues work already in flight.
    expect(postCalls()).toHaveLength(0);
    expect(auditCalls().length).toBeGreaterThan(0);
  });

  it('a resumed run still LANDS — the poll clears the record and re-reads the report', async () => {
    vi.useFakeTimers();
    localStorage.setItem(RUN_KEY, JSON.stringify(REFRESH_RESULT));
    jobReply = () => Promise.resolve(jobStatus('running'));

    render();
    await act(async () => {});
    expect(screen.getByText('Deriving your first audit…')).toBeTruthy();

    auditBody = LANDED_AUDIT;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 2);
    });

    expect(localStorage.getItem(RUN_KEY)).toBeNull();
    expect(screen.queryByText('Deriving your first audit…')).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it('a browser with localStorage unavailable behaves exactly as it did before', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('localStorage disabled');
      },
      setItem: () => {
        throw new Error('localStorage disabled');
      },
      removeItem: () => {
        throw new Error('localStorage disabled');
      },
      clear: () => {},
    };
    vi.stubGlobal('localStorage', throwing);
    vi.useFakeTimers();

    render();
    // State B, with its trigger — unblocked, exactly as before the record existed.
    expect(firstAuditButton()).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run the first audit' }));
    });

    // The run still fires and still derives; only the durability is lost.
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByText('Deriving your first audit…')).toBeTruthy();
  });
});
