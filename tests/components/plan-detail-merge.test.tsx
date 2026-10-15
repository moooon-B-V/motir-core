// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';
import { planReview, planReviewItem } from '../helpers/planReview';

// A GENERATING PLAN'S SNAPSHOTS LAND MERGED (Story MOTIR-8539 · Subtask MOTIR-8575).
//
// `PlanDetail` files every poll answer through `mergePlanReview`, so a re-read that
// changed nothing hands the plan tree the same `items` array and leaves the DOM
// alone, and a re-read that changed one proposal touches that proposal only. The
// poll is driven through a fake live source, so each tick is one the test fires.

const mocks = vi.hoisted(() => ({
  view: { value: 'canvas' as 'canvas' | 'list' },
  fetchPlanReview: vi.fn(),
  canvasItems: [] as PlanReviewItemDto[][],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/plans/plan_1',
  useSearchParams: () => new URLSearchParams(`view=${mocks.view.value}`),
}));

vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/planReviewClient')>();
  return { ...actual, fetchPlanReview: mocks.fetchPlanReview };
});

// The canvas is a stub that RECORDS the `items` it is handed on every render — the
// prop the merge exists to keep stable.
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: ({ items }: { items: PlanReviewItemDto[] }) => {
    mocks.canvasItems.push(items);
    return <div data-testid="plan-review-canvas" />;
  },
}));

vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => null,
}));

const { PlanDetail } = await import('@/components/planning/PlanDetail');
const { LiveSignalProvider } = await import('@/lib/live/liveSignal');

const A = planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'Alpha proposal' });
const B = planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'Bravo proposal' });

const generating = (items: PlanReviewItemDto[]): PlanReviewDto =>
  planReview(items, { id: 'plan_1', status: 'generating', plannedAt: null });

/** A fresh copy of the same content — what a re-read hands back. */
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fakePlanSource() {
  const listeners = new Set<LiveSignalListener>();
  let seq = 0;
  const source: LiveSignalSource = {
    subscribe(topic, onSignal) {
      if (topic.kind !== 'plan') return () => {};
      listeners.add(onSignal);
      return () => listeners.delete(onSignal);
    },
    reconnecting: createLiveFlag(false),
  };
  return {
    source,
    async tick() {
      seq += 1;
      const before = mocks.fetchPlanReview.mock.calls.length;
      await act(async () => {
        for (const l of [...listeners]) l({ topic: { kind: 'plan', planId: 'plan_1' }, seq });
      });
      await waitFor(() => expect(mocks.fetchPlanReview.mock.calls.length).toBe(before + 1));
      await act(async () => {});
    },
  };
}

function mount(initial: PlanReviewDto) {
  const fake = fakePlanSource();
  const utils = renderWithIntl(
    <LiveSignalProvider source={fake.source}>
      <PlanDetail initialReview={initial} projectKey="MOTIR" />
    </LiveSignalProvider>,
  );
  return { ...utils, fake };
}

function observe(target: Node) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    records,
    stop: () => {
      records.push(...observer.takeRecords());
      observer.disconnect();
    },
  };
}

beforeEach(() => {
  mocks.view.value = 'canvas';
  mocks.fetchPlanReview.mockReset();
  mocks.canvasItems.length = 0;
});

afterEach(() => cleanup());

describe('PlanDetail files a snapshot merged by identity', () => {
  it('an unchanged snapshot hands the canvas the SAME items array', async () => {
    const initial = generating([A, B]);
    mocks.fetchPlanReview.mockImplementation(async () => copy(initial));
    const { fake } = mount(initial);
    const seeded = mocks.canvasItems.at(-1)!;
    expect(seeded).toBe(initial.items);

    await fake.tick();
    await fake.tick();
    expect(mocks.canvasItems.at(-1)).toBe(seeded);
  });

  it('a snapshot changing one proposal keeps every other proposal object', async () => {
    const initial = generating([A, B]);
    mocks.fetchPlanReview.mockImplementation(async () =>
      generating([copy(A), { ...copy(B), title: 'Bravo, renamed' }]),
    );
    const { fake } = mount(initial);

    await fake.tick();
    const items = mocks.canvasItems.at(-1)!;
    expect(items).not.toBe(initial.items);
    expect(items[0]).toBe(initial.items[0]);
    expect(items[1]!.title).toBe('Bravo, renamed');
  });
});

describe('the proposal list re-renders only what changed', () => {
  it('an unchanged snapshot leaves the list DOM untouched', async () => {
    mocks.view.value = 'list';
    const initial = generating([A, B]);
    mocks.fetchPlanReview.mockImplementation(async () => copy(initial));
    const { fake } = mount(initial);
    const list = await screen.findByTestId('plan-proposal-list');

    const seen = observe(list);
    await fake.tick();
    seen.stop();
    expect(seen.records).toHaveLength(0);
  });

  it('a changed proposal mutates its own row and leaves its sibling mounted and untouched', async () => {
    mocks.view.value = 'list';
    const initial = generating([A, B]);
    mocks.fetchPlanReview.mockImplementation(async () =>
      generating([copy(A), { ...copy(B), title: 'Bravo, renamed' }]),
    );
    const { fake } = mount(initial);
    const list = await screen.findByTestId('plan-proposal-list');
    const alpha = screen.getByText('Alpha proposal').closest('li')!;
    const bravo = screen.getByText('Bravo proposal').closest('li')!;

    const seen = observe(list);
    await fake.tick();
    seen.stop();

    expect(screen.getByText('Bravo, renamed')).toBeTruthy();
    expect(screen.getByText('Alpha proposal').closest('li')).toBe(alpha);
    expect(seen.records.length).toBeGreaterThan(0);
    for (const record of seen.records) {
      expect(alpha.contains(record.target)).toBe(false);
      expect(bravo.contains(record.target)).toBe(true);
    }
  });
});
