// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import type { ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';

// THE SEARCH BOX NAMES THE CANVAS IT IS MOUNTED IN (MOTIR-4021, design Part XIII
// §5).
//
// The input's `aria-label` and placeholder were both `roadmap.canvas.search` —
// "Search the roadmap" — on all four searchable mounts, exactly one of which is
// the roadmap. So a reader deciding whether to approve a plan was offered a
// search of the roadmap.
//
// ⚠️ THE MECHANISM IS THE TYPE, not this file. `ProjectRoadmapCanvas`'s props
// make `searchLabel` REQUIRED exactly when `searchable` is true, so a mount that
// turns search on without saying what it searches does not compile — which is
// what the card asks for, and what an optional prop defaulting to the roadmap's
// string could never give. (It earned its keep immediately: it failed six test
// mounts on the first typecheck.) These assertions cover what a type cannot: that
// the label reaches BOTH axes of the rendered input, and that the roadmap's own
// sentence is still there.

afterEach(() => cleanup());

const node = (id: string, label: string): ProjectCanvasNode => ({
  id,
  parentId: null,
  searchText: label,
  crumbLabel: id,
  drillable: false,
  content: <div>{label}</div>,
});

const level: RoadmapLevel = { nodes: [node('A', 'A card')], deps: [] };
const loadLevel = async (): Promise<RoadmapLevel> => level;

describe('the consumer’s word reaches BOTH axes of the input', () => {
  it('is the accessible name AND the placeholder', async () => {
    render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} searchable searchLabel="Search this plan" />,
    );
    // Read by ACCESSIBLE NAME, not by class: the name is what a screen-reader
    // user hears and what the E2E leg asserts, and a class assertion would pass
    // on a box labelled for the wrong surface.
    const input = await screen.findByRole('searchbox', { name: 'Search this plan' });
    expect(input.getAttribute('placeholder')).toBe('Search this plan');
  });

  it('carries a DIFFERENT consumer’s word without the foundation knowing which surface it is on', async () => {
    render(
      <ProjectRoadmapCanvas loadLevel={loadLevel} searchable searchLabel="Search this project" />,
    );
    expect(await screen.findByRole('searchbox', { name: 'Search this project' })).toBeTruthy();
    expect(screen.queryByRole('searchbox', { name: 'Search the roadmap' })).toBeNull();
  });

  it('renders no search box at all when the mount turns search OFF', async () => {
    render(<ProjectRoadmapCanvas loadLevel={loadLevel} />);
    await screen.findByText('A card');
    // The item page's Children panel is that mount, deliberately — and the type's
    // non-searchable arm forbids the label, so it cannot carry a dead string.
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('the roadmap keeps its own sentence', () => {
  // "The roadmap keeps its sentence" is the half a sweep of this shape is most
  // likely to break — the key is the one thing four surfaces used to share, so
  // deleting it is the tempting last step of the change that stops using it.
  const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
  const zh = JSON.parse(readFileSync(join(process.cwd(), 'messages/zh.json'), 'utf8'));

  it('still holds `roadmap.canvas.search`, with its English, in both catalogs', () => {
    expect(en.roadmap.canvas.search).toBe('Search the roadmap');
    expect(typeof zh.roadmap.canvas.search).toBe('string');
    expect(zh.roadmap.canvas.search.length).toBeGreaterThan(0);
  });

  it('gives each of the four other mounts its own key, in BOTH catalogs', () => {
    // ⚠️ `runs.searchLabel` joined on 2026-08-31 (MOTIR-4047). This assertion
    // did NOT go red when the fourth mount landed — it only checks that the
    // keys it lists exist — so it kept passing while describing three quarters
    // of the population. Added here rather than left, because a guard that says
    // "each of the N other mounts" and means "the N I remembered" is the shape
    // it exists to prevent one layer up.
    for (const [enValue, zhValue] of [
      [en.planReview.searchLabel, zh.planReview.searchLabel],
      [en.planningWorkspace.searchLabel, zh.planningWorkspace.searchLabel],
      [en.onboarding.chat.canvas.searchLabel, zh.onboarding.chat.canvas.searchLabel],
      [en.runs.searchLabel, zh.runs.searchLabel],
    ]) {
      expect(typeof enValue).toBe('string');
      expect(enValue.length).toBeGreaterThan(0);
      expect(typeof zhValue).toBe('string');
      expect(zhValue.length).toBeGreaterThan(0);
    }
    expect(en.planReview.searchLabel).toBe('Search this plan');
    expect(en.runs.searchLabel).toBe('Search this run');
  });

  it('leaves the foundation with no reference to the roadmap’s key', () => {
    const canvas = readFileSync(
      join(process.cwd(), 'components/planning/ProjectRoadmapCanvas.tsx'),
      'utf8',
    );
    expect(canvas).not.toContain("t('search')");
  });
});
