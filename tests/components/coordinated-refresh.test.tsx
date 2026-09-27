// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';

// ONE `router.refresh()` IN FLIGHT AT A TIME (bug MOTIR-6640).
//
// Two refreshes overlapping after an approve made Next fall back to a full
// document load, which wiped the planning overlay's decided plan. The
// coordinator's whole guarantee is about TIME: a request made while a refresh
// is pending must not start a second one, and must still be honoured once the
// first has committed. A mock refresh that returns synchronously cannot show
// either half, because nothing is ever pending. So the mock here does what the
// real one does to React: it schedules an update that SUSPENDS until the test
// resolves it, which is exactly how `useTransition` holds `isPending` across a
// real refresh.

let resolveRead: (() => void) | null = null;
let pendingRead: Promise<void> | null = null;
let readDone = false;
let bumpServerRead: (() => void) | null = null;

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const { CoordinatedRefreshProvider, useCoordinatedRefresh, REFRESH_SETTLE_CEILING_MS } =
  await import('@/lib/navigation/coordinatedRefresh');

/** A refresh that stays in flight until {@link settle} is called. */
function slowRefresh() {
  readDone = false;
  pendingRead = new Promise<void>((resolve) => {
    resolveRead = () => {
      readDone = true;
      resolve();
    };
  });
  bumpServerRead?.();
}

async function settle() {
  await act(async () => {
    resolveRead?.();
    await pendingRead;
  });
}

/** Stands in for the server-rendered page a refresh re-reads. */
function ServerRead() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    bumpServerRead = () => setGeneration((g) => g + 1);
  }, []);
  // Suspends by THROWING the read, not with `use()`: under act, React did not
  // resume a transition suspended through `use()` on a promise created outside
  // render, so `isPending` never cleared and the test measured the harness.
  if (generation > 0 && pendingRead && !readDone) throw pendingRead;
  return <span>read {generation}</span>;
}

let request: () => void = () => {};
function Requester() {
  const coordinated = useCoordinatedRefresh();
  useEffect(() => {
    request = coordinated;
  }, [coordinated]);
  return null;
}

function mount(children: ReactNode = null) {
  return render(
    <CoordinatedRefreshProvider>
      <Suspense fallback={<span>loading</span>}>
        <ServerRead />
      </Suspense>
      <Requester />
      {children}
    </CoordinatedRefreshProvider>,
  );
}

afterEach(() => {
  cleanup();
  refresh.mockReset();
  resolveRead = null;
  pendingRead = null;
  readDone = false;
  bumpServerRead = null;
  vi.restoreAllMocks();
});

describe('CoordinatedRefreshProvider', () => {
  it('refreshes at once when nothing is in flight', () => {
    refresh.mockImplementation(slowRefresh);
    mount();

    act(() => request());

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('holds requests made during a pending refresh and runs ONE follow-up after it commits', async () => {
    refresh.mockImplementation(slowRefresh);
    mount();

    act(() => request());
    // The approve's refresh and the live nudge, plus one more for good measure:
    // none of them may overlap the refresh already in flight.
    act(() => request());
    act(() => request());
    expect(refresh).toHaveBeenCalledTimes(1);

    await settle();
    // Nothing dropped: the held requests are honoured by exactly one refresh,
    // because one re-read of the page covers every write they asked about.
    expect(refresh).toHaveBeenCalledTimes(2);

    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('runs no follow-up when nothing asked while the refresh was pending', async () => {
    refresh.mockImplementation(slowRefresh);
    mount();

    act(() => request());
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    // And the slot is free again: the next request runs straight away.
    act(() => request());
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('treats a refresh pending past the ceiling as settled, so a stuck one cannot hold the page', () => {
    refresh.mockImplementation(slowRefresh);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mount();

    act(() => request());
    now.mockReturnValue(1_000_000 + REFRESH_SETTLE_CEILING_MS);
    act(() => request());

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('falls back to a plain refresh with no provider mounted', () => {
    render(<Requester />);

    act(() => request());
    act(() => request());

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
