// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type {
  MigrateIndexRepoStatusDto,
  MigrateIndexStatusDto,
  MigrateLatestImportDto,
} from '@/lib/dto/migrateOnboarding';
import {
  INDEX_DONE_LINGER_MS,
  IndexIndicator,
} from '@/app/(onboarding)/onboarding/migrate/_components/IndexIndicator';
import { summariseIndex } from '@/app/(onboarding)/onboarding/migrate/_components/indexSummary';

// MOTIR-8771 — the onboarding bar's indexing indicator
// (`design/onboarding-migrate/index-nonblocking--delta.mock.html` A–E, J and
// `index-nonblocking--enter-motir.mock.html` C). The status it renders is a
// prop (the wizard's one poll); the retry route is faked at `fetch`.

const m = enMessages.onboardingMigrate;

function status(...repos: [string, MigrateIndexRepoStatusDto | string][]): MigrateIndexStatusDto {
  const rows = repos.map(([repoRef, s]) => ({
    provider: 'github',
    repoRef,
    status: s as MigrateIndexRepoStatusDto,
  }));
  const indexedCount = rows.filter((r) => r.status === 'indexed').length;
  return {
    repos: rows,
    indexedCount,
    failedCount: rows.filter((r) => r.status === 'failed').length,
    total: rows.length,
    hasRunning: rows.some((r) => r.status === 'indexing'),
    allIndexed: rows.length > 0 && indexedCount === rows.length,
  };
}

function render(
  s: MigrateIndexStatusDto | null,
  opts: { latestImport?: MigrateLatestImportDto | null; onRetried?: () => void } = {},
  intl?: { locale: string; messages: Record<string, unknown> },
) {
  const props = {
    runId: 'run-1',
    status: s,
    latestImport: opts.latestImport ?? null,
    onRetried: opts.onRetried ?? (() => {}),
  };
  const result = renderWithIntl(<IndexIndicator {...props} />, intl);
  return {
    ...result,
    rerenderWith: (next: MigrateIndexStatusDto | null) =>
      result.rerender(<IndexIndicator {...props} status={next} />),
  };
}

const chip = () => screen.getByTestId('migrate-index-indicator');

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('summariseIndex', () => {
  it('ranks failed over indexing over queued over done, naming the worst repo and +N', () => {
    expect(
      summariseIndex(status(['a/one', 'indexed'], ['a/two', 'failed'], ['a/three', 'indexing'])),
    ).toMatchObject({ state: 'failed', repoRef: 'a/two', others: 2, failedCount: 1 });
    expect(summariseIndex(status(['a/one', 'queued'], ['a/two', 'indexing']))).toMatchObject({
      state: 'indexing',
      repoRef: 'a/two',
      others: 1,
    });
    expect(summariseIndex(status(['a/one', 'indexed'], ['a/two', 'queued']))).toMatchObject({
      state: 'queued',
      repoRef: 'a/two',
    });
    expect(summariseIndex(status(['a/one', 'indexed']))).toMatchObject({
      state: 'done',
      others: 0,
    });
  });

  it('ranks an unknown value after every known one and reads nothing as null', () => {
    expect(summariseIndex(status(['a/odd', 'mystery'], ['a/two', 'queued']))).toMatchObject({
      state: 'queued',
      repoRef: 'a/two',
    });
    expect(summariseIndex(null)).toBeNull();
    expect(summariseIndex(status())).toBeNull();
  });
});

describe('the chip', () => {
  it('names one repository and its state, and reads nothing before the first status', () => {
    const { rerenderWith } = render(null);
    expect(screen.queryByTestId('migrate-index-indicator')).toBeNull();
    rerenderWith(status(['acme/widgets', 'indexing']));
    expect(chip().textContent).toContain('Indexing widgets');
    expect(chip().textContent).toContain('In progress');
    rerenderWith(status(['acme/widgets', 'queued']));
    expect(chip().textContent).toContain('Queued');
  });

  it('counts several repositories, and a failure wins the tail', () => {
    const { rerenderWith } = render(
      status(['a/one', 'indexed'], ['a/two', 'indexing'], ['a/three', 'queued']),
    );
    expect(chip().textContent).toContain('Indexing 3 repositories');
    expect(chip().textContent).toContain('1 of 3 done');
    rerenderWith(status(['a/one', 'indexed'], ['a/two', 'failed'], ['a/three', 'queued']));
    expect(chip().getAttribute('data-state-summary')).toBe('failed');
    expect(chip().textContent).toContain('1 failed');
  });

  it('says done once after it saw work, then leaves the bar', () => {
    vi.useFakeTimers();
    const { rerenderWith } = render(status(['acme/widgets', 'indexing']));
    rerenderWith(status(['acme/widgets', 'indexed']));
    expect(chip().textContent).toContain('Indexed widgets');
    act(() => {
      vi.advanceTimersByTime(INDEX_DONE_LINGER_MS);
    });
    expect(screen.queryByTestId('migrate-index-indicator')).toBeNull();
  });

  it('is never drawn for a project that was already indexed when it mounted', () => {
    render(status(['acme/widgets', 'indexed']));
    expect(screen.queryByTestId('migrate-index-indicator')).toBeNull();
  });

  it('stays while an import runs even when the index is done', () => {
    render(status(['acme/widgets', 'indexed']), {
      latestImport: { source: 'jira', status: 'running', processedCount: 40 },
    });
    expect(chip()).toBeTruthy();
  });
});

describe('the detail', () => {
  it('opens with one row per repository, and Esc and Close shut it', async () => {
    render(status(['acme/web', 'indexed'], ['acme/api', 'indexing']));
    fireEvent.click(chip());
    const detail = await screen.findByTestId('migrate-index-detail');
    expect(chip().getAttribute('aria-expanded')).toBe('true');
    const rows = within(detail).getAllByTestId('migrate-index-detail-repo');
    expect(rows.map((r) => [r.getAttribute('data-repo-ref'), r.textContent])).toEqual([
      ['acme/web', expect.stringContaining('Indexed')],
      ['acme/api', expect.stringContaining('In progress')],
    ]);
    expect(within(detail).getByText(m.indexing.detailBody)).toBeTruthy();

    fireEvent.keyDown(detail, { key: 'Escape' });
    expect(screen.queryByTestId('migrate-index-detail')).toBeNull();

    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('button', { name: m.indexing.close }));
    expect(screen.queryByTestId('migrate-index-detail')).toBeNull();
  });

  it('lists a running work-items import with its count', async () => {
    render(status(['acme/web', 'indexing']), {
      latestImport: { source: 'linear', status: 'running', processedCount: 12 },
    });
    fireEvent.click(chip());
    const row = await screen.findByTestId('migrate-index-detail-import');
    expect(screen.getByText(m.indexing.importHeading)).toBeTruthy();
    expect(row.textContent).toContain('Linear');
    expect(row.textContent).toContain('12 so far');
  });

  it('shows no import group when the latest import is finished', async () => {
    render(status(['acme/web', 'indexing']), {
      latestImport: { source: 'linear', status: 'succeeded', processedCount: 12 },
    });
    fireEvent.click(chip());
    await screen.findByTestId('migrate-index-detail');
    expect(screen.queryByTestId('migrate-index-detail-import')).toBeNull();
  });
});

describe('retry', () => {
  async function openFailed(onRetried = vi.fn()) {
    render(status(['acme/web', 'failed']), { onRetried });
    fireEvent.click(chip());
    await screen.findByTestId('migrate-index-detail');
    expect(screen.getByText(m.indexing.rowFailed)).toBeTruthy();
    return { onRetried, tryAgain: () => screen.getByRole('button', { name: /Try again/ }) };
  }

  it('POSTs once, is busy in flight, and reads queued on 200', async () => {
    let release!: (r: Response) => void;
    const calls = fakeFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const { onRetried, tryAgain } = await openFailed();
    fireEvent.click(tryAgain());
    const busy = screen.getByRole('button', { name: /Trying again/ });
    expect(busy.hasAttribute('disabled')).toBe(true);
    fireEvent.click(busy);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![0]).toBe('/api/onboarding/migrate/run-1/index-retry');
    expect(JSON.parse(String(calls.mock.calls[0]![1]!.body))).toEqual({ repoRef: 'acme/web' });

    await act(async () => release(json({ repoRef: 'acme/web', status: 'queued' })));
    const row = screen.getByTestId('migrate-index-detail-repo');
    expect(row.getAttribute('data-status')).toBe('queued');
    expect(onRetried).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, m.indexing.refusedNotConnected],
    [422, m.indexing.refusedTooLarge],
    [500, m.indexing.retryError],
  ])('a %s answer shows its sentence and re-enables Try again', async (code, sentence) => {
    fakeFetch(() => json({ code: 'X' }, code));
    const { onRetried, tryAgain } = await openFailed();
    await act(async () => {
      fireEvent.click(tryAgain());
    });
    expect((await screen.findByRole('alert')).textContent).toContain(sentence);
    expect(tryAgain().hasAttribute('disabled')).toBe(false);
    expect(onRetried).not.toHaveBeenCalled();
  });

  it('a network failure shows the generic sentence', async () => {
    fakeFetch(() => Promise.reject(new Error('offline')));
    const { tryAgain } = await openFailed();
    await act(async () => {
      fireEvent.click(tryAgain());
    });
    expect((await screen.findByRole('alert')).textContent).toContain(m.indexing.retryError);
  });
});

describe('Chinese', () => {
  it('renders the chip, the detail and the failed row in Chinese', async () => {
    render(
      status(['acme/web', 'failed'], ['acme/api', 'indexing']),
      {
        latestImport: { source: 'jira', status: 'running', processedCount: 3 },
      },
      { locale: 'zh', messages: zhMessages },
    );
    expect(chip().textContent).toContain('正在索引 2 个仓库');
    expect(chip().textContent).toContain('1 个失败');
    fireEvent.click(chip());
    const detail = await screen.findByTestId('migrate-index-detail');
    expect(detail.textContent).toContain(zhMessages.onboardingMigrate.indexing.rowFailed);
    expect(detail.textContent).toContain('工作项导入');
    expect(detail.textContent).toContain('已处理 3 个');
    expect(detail.textContent).not.toContain('onboardingMigrate.');
  });
});
