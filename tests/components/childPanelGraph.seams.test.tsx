// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ChildPanel } from '@/app/(authed)/items/[key]/_components/ChildPanel';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// STORY GATE (MOTIR-2289) for "Child panel — List ↔ Graph" (MOTIR-2284).
//
// MOTIR-2287 and MOTIR-2288 each prove their own half against a stub. This suite
// asserts what sits BETWEEN them — the real panel → adapter → roadmap-client
// chain, driven end to end — plus the architecture guards that no coverage
// percentage can see. It deliberately does NOT re-assert either card's units.

const push = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items/MOTIR-2284',
  useSearchParams: () => params,
}));

const repoFile = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

// A realistic per-level response: the item's children, WITH a blocked_by chain
// between them (the edges are the whole reason the panel exists — a fixture
// without them would pass while proving nothing), plus a container child so a
// drill is reachable.
const CHILDREN_LEVEL = {
  nodes: [
    {
      id: 'c1',
      parentId: 'P9',
      kind: 'subtask',
      identifier: 'MOTIR-2285',
      title: 'Design the switcher',
      status: 'done',
      isDone: true,
      hasChildren: false,
      ready: false,
    },
    {
      id: 'c2',
      parentId: 'P9',
      kind: 'story',
      identifier: 'MOTIR-2288',
      title: 'Build the panel',
      status: 'todo',
      isDone: false,
      hasChildren: true,
      progress: { done: 1, total: 4 },
      ready: true,
    },
  ],
  edges: [{ blockedId: 'c2', blockerId: 'c1' }],
  offLevelBlockers: [],
};

const GRANDCHILDREN_LEVEL = {
  nodes: [
    {
      id: 'g1',
      parentId: 'c2',
      kind: 'subtask',
      identifier: 'MOTIR-2291',
      title: 'A grandchild',
      status: 'todo',
      isDone: false,
      hasChildren: false,
    },
  ],
  edges: [],
  offLevelBlockers: [],
};

// The PROJECT ROOTS — what a rooted mount must never resolve to. Distinguishable
// on sight, so a fallback to `parentId: null` would be visible in the assertions.
const ROOT_LEVEL = {
  nodes: [
    {
      id: 'E1',
      parentId: null,
      kind: 'epic',
      identifier: 'MOTIR-464',
      title: 'A project root epic',
      status: 'in_progress',
      isDone: false,
      hasChildren: true,
    },
  ],
  edges: [],
  offLevelBlockers: [],
};

let urls: string[] = [];

function stubLevels(respond: (url: string) => unknown = () => CHILDREN_LEVEL) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      return { ok: true, json: async () => respond(u) };
    }),
  );
}

beforeEach(() => {
  push.mockClear();
  urls = [];
  params = new URLSearchParams('children=graph');
  stubLevels();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderGraphPanel() {
  return render(
    <ChildPanel count={2} itemId="P9" itemIdentifier="MOTIR-2284" projectKey="MOTIR">
      <ul data-testid="server-rows" />
    </ChildPanel>,
  );
}

const levelUrls = () => urls.filter((u) => u.includes('/roadmap'));

describe('child-panel graph — the panel ↔ adapter ↔ roadmap-client seam', () => {
  it('carries the item id all the way into the request the client builds', async () => {
    renderGraphPanel();
    await screen.findByText('MOTIR-2285');
    // The whole journey in one assertion: the URL-derived mode → the panel's
    // `subtreeRootId` → the adapter's root-level load → the query string. Each half
    // passes against a stub even when the id is dropped here; this is the seam.
    expect(levelUrls()).toHaveLength(1);
    expect(levelUrls()[0]).toBe('/api/projects/MOTIR/roadmap?parentId=P9');
  });

  it('a rooted mount NEVER resolves a level to the project roots', async () => {
    stubLevels((u) => (u.includes('parentId=') ? CHILDREN_LEVEL : ROOT_LEVEL));
    renderGraphPanel();
    await screen.findByText('MOTIR-2285');
    // No request without a parentId — the fallback that would silently show the
    // whole project instead of this item's children.
    expect(levelUrls().every((u) => u.includes('parentId='))).toBe(true);
    expect(screen.queryByText('MOTIR-464')).toBeNull();
  });

  it('drills below the rooted level with the CHILD id, not the root again', async () => {
    stubLevels((u) => (u.includes('parentId=c2') ? GRANDCHILDREN_LEVEL : CHILDREN_LEVEL));
    renderGraphPanel();
    await screen.findByText('MOTIR-2288');
    fireEvent.keyDown(document.querySelector('[data-node-id="c2"]')!, { key: 'Enter' });
    fireEvent.click(await screen.findByTestId('drill-button'));
    expect(await screen.findByText('MOTIR-2291')).toBeTruthy();
    expect(levelUrls()).toContain('/api/projects/MOTIR/roadmap?parentId=c2');
  });

  it('turns a real response body into DRAWN dependency edges, not just nodes', async () => {
    renderGraphPanel();
    await screen.findByText('MOTIR-2285');
    // The body's blocked_by chain must survive toItem → buildWorkItemLevel → the
    // canvas: one edge path between the two children.
    const edges = document.querySelector('[data-testid="canvas-edges"]');
    expect(edges).not.toBeNull();
    expect(edges!.querySelectorAll('path').length).toBe(CHILDREN_LEVEL.edges.length);
    // …and the level's own signals rode along: the container's progress meter and
    // the ready highlight on the startable child.
    expect(screen.getByTestId('progress-meter')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
  });

  it('a non-OK response degrades to the panel’s own empty state, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    renderGraphPanel();
    // `fetchRoadmapLevel` is best-effort: any failure resolves to an EMPTY level.
    // The section only renders when children EXIST, so an empty first level means
    // the read did not come back — and the panel says so rather than showing the
    // canvas's "nothing on the roadmap yet", which would contradict the count pill.
    expect(await screen.findByText('The graph couldn’t be drawn')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy(); // the count pill still says 2
  });

  it('a THROWN fetch degrades the same way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderGraphPanel();
    expect(await screen.findByText('The graph couldn’t be drawn')).toBeTruthy();
  });
});

describe('child-panel graph — architecture guards', () => {
  // PROTECTS: the reusable canvas foundation (MOTIR-1194) stays consumer-agnostic.
  // Five surfaces mount it; the day it imports one consumer's page components,
  // "shared" has stopped being true.
  it('ProjectRoadmapCanvas imports nothing from the work-item detail page', () => {
    const src = repoFile('components/planning/ProjectRoadmapCanvas.tsx');
    expect(src).not.toContain('app/(authed)');
    expect(src).not.toContain('items/[key]');
  });

  // PROTECTS: the rooting rule cannot be bypassed. The panel must go through the
  // ADAPTER — mounting ProjectRoadmapCanvas directly would let it supply its own
  // loadLevel and quietly lose the root, the origin suppression and the cache key.
  it('the panel mounts the adapter, never the canvas directly', () => {
    const src = repoFile('app/(authed)/items/[key]/_components/ChildPanel.tsx');
    expect(src).toContain("from '@/components/planning/WorkItemRoadmap'");
    expect(src).not.toContain('ProjectRoadmapCanvas');
  });

  // PROTECTS: the subtree root stays an OPT-IN. Every other consumer of the
  // adapter/canvas must keep the shipped project-root behaviour, so this story
  // cannot change what /roadmap, onboarding, plan review or plan change show.
  // The consumer set is DISCOVERED, not listed — a hand-written list goes stale
  // the moment a sixth surface mounts the canvas, and would then guard nothing.
  it('the Children panel is the ONLY surface that passes a subtree root', () => {
    const consumers = execFileSync(
      'git',
      ['grep', '-l', '-E', 'ProjectRoadmapCanvas|WorkItemRoadmap', '--', 'components', 'app'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    // Sanity: the discovery found the surfaces this guard is about, so an empty
    // result can never pass the assertion vacuously.
    expect(consumers).toContain('components/planning/RoadmapView.tsx');
    expect(consumers).toContain('components/onboarding/OnboardingCanvas.tsx');
    expect(consumers.length).toBeGreaterThan(5);
    const rooting = consumers.filter(
      (f) =>
        f !== 'components/planning/WorkItemRoadmap.tsx' && repoFile(f).includes('subtreeRootId'),
    );
    expect(rooting).toEqual(['app/(authed)/items/[key]/_components/ChildPanel.tsx']);
  });

  // PROTECTS: the i18n catalog parity gate for the keys this story added — a zh
  // catalog missing one of them ships an English string into a Chinese page.
  it('every issueViews key exists in BOTH catalogs', () => {
    const en = Object.keys(enMessages.issueViews).sort();
    const zh = Object.keys(zhMessages.issueViews).sort();
    expect(zh).toEqual(en);
    for (const k of [
      'viewGraph',
      'childrenViewLabel',
      'childrenGraphAria',
      'childrenGraphUnavailableTitle',
      'childrenGraphUnavailableDescription',
    ]) {
      expect(en).toContain(k);
    }
  });
});
