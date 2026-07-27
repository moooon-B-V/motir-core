import { describe, it, expect } from 'vitest';
import {
  resolvePlanningMode,
  planningWorkspaceHref,
  parsePlanningLaunch,
  parsePlanningMode,
  parsePlanningOrigin,
  planningLaunchBackHref,
  DEFAULT_PLANNING_MODE,
  PLANNING_WORKSPACE_PATH,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';

// The "Plan with AI" launcher's context→mode resolution (MOTIR-1299). The pure
// core is the launcher's testable contract (the AC: "Unit tests for the
// context→mode resolution"); the per-surface mounting is covered by each
// surface's E2E.

describe('resolvePlanningMode', () => {
  it('maps a project surface WITH a plan to re-plan/augment (7.11)', () => {
    expect(resolvePlanningMode({ kind: 'project', hasPlan: true })).toBe('replan');
  });

  it('maps a project surface with NO plan yet to generation (7.4)', () => {
    expect(resolvePlanningMode({ kind: 'project', hasPlan: false })).toBe('generation');
  });

  it('maps a project surface with an UNKNOWN plan state to the coarse project mode', () => {
    // The global header pill's case — it does not pay a per-render plan lookup;
    // the workspace seeds generation-vs-augment from the live tree.
    expect(resolvePlanningMode({ kind: 'project' })).toBe('project');
  });

  it('maps a specific work item to contextual planning (7.12)', () => {
    expect(resolvePlanningMode({ kind: 'work-item', itemKey: 'MOTIR-42' })).toBe('contextual');
  });

  it('maps the roadmap surface to roadmap-read (7.19)', () => {
    expect(resolvePlanningMode({ kind: 'roadmap' })).toBe('roadmap');
  });
});

describe('planningWorkspaceHref', () => {
  it('targets the shipped planning-workspace entry path', () => {
    const href = planningWorkspaceHref({ kind: 'project' });
    expect(href.startsWith(`${PLANNING_WORKSPACE_PATH}?`)).toBe(true);
  });

  it('carries the resolved mode and the originating surface as query params', () => {
    const url = new URL(planningWorkspaceHref({ kind: 'project', hasPlan: true }), 'https://x');
    expect(url.searchParams.get('mode')).toBe('replan');
    expect(url.searchParams.get('from')).toBe('project');
  });

  it('carries the work-item key for a contextual launch', () => {
    const url = new URL(
      planningWorkspaceHref({ kind: 'work-item', itemKey: 'MOTIR-7' }),
      'https://x',
    );
    expect(url.searchParams.get('mode')).toBe('contextual');
    expect(url.searchParams.get('from')).toBe('work-item');
    expect(url.searchParams.get('item')).toBe('MOTIR-7');
  });

  it('does not leak an item param for a non-item launch', () => {
    const url = new URL(planningWorkspaceHref({ kind: 'roadmap' }), 'https://x');
    expect(url.searchParams.has('item')).toBe(false);
    expect(url.searchParams.get('mode')).toBe('roadmap');
  });

  it('url-encodes the context safely', () => {
    // A defensive check that the builder uses URLSearchParams encoding rather
    // than string concatenation.
    const ctx: PlanningLaunchContext = { kind: 'work-item', itemKey: 'a b&c' };
    const href = planningWorkspaceHref(ctx);
    expect(href).not.toContain('a b&c');
    const url = new URL(href, 'https://x');
    expect(url.searchParams.get('item')).toBe('a b&c');
  });
});

// ─── The host side (MOTIR-1729) — reading the context back off the URL ────────

/** Parse the query the builder just wrote — the round trip both halves must hold. */
function parseHref(context: PlanningLaunchContext) {
  const url = new URL(planningWorkspaceHref(context), 'https://x');
  return parsePlanningLaunch(Object.fromEntries(url.searchParams.entries()));
}

describe('the entry path targets the established-project host', () => {
  it('is the planning workspace route, NOT the onboarding entrance', () => {
    // The dead end this subtask closes: `/onboarding` redirects an onboarded
    // project to /roadmap, so the launcher round-tripped and never opened.
    expect(PLANNING_WORKSPACE_PATH).toBe('/planning');
    expect(PLANNING_WORKSPACE_PATH).not.toBe('/onboarding');
  });
});

describe('parsePlanningLaunch — the inverse of planningWorkspaceHref', () => {
  it('round-trips a project launch WITH a plan (the established-project door)', () => {
    expect(parseHref({ kind: 'project', hasPlan: true })).toEqual({
      mode: 'replan',
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
  });

  it('round-trips a coarse project launch (mode unresolved at the call site)', () => {
    expect(parseHref({ kind: 'project' })).toEqual({
      mode: 'project',
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
  });

  it('round-trips a work-item launch, carrying the target key', () => {
    expect(parseHref({ kind: 'work-item', itemKey: 'MOTIR-7' })).toEqual({
      mode: 'contextual',
      from: 'work-item',
      itemKey: 'MOTIR-7',
      repoKey: null,
    });
  });

  it('round-trips a roadmap launch', () => {
    expect(parseHref({ kind: 'roadmap' })).toEqual({
      mode: 'roadmap',
      from: 'roadmap',
      itemKey: null,
      repoKey: null,
    });
  });

  it('round-trips a convention-refine launch, carrying the repo key', () => {
    expect(parseHref({ kind: 'convention-refine', repoKey: 'moooon/motir-core' })).toEqual({
      mode: 'contextual',
      from: 'convention-refine',
      itemKey: null,
      repoKey: 'moooon/motir-core',
    });
  });
});

describe('parsePlanningLaunch — a hand-edited or absent query never errors', () => {
  it('falls back to the project-scoped default when the query is empty', () => {
    expect(parsePlanningLaunch({})).toEqual({
      mode: DEFAULT_PLANNING_MODE,
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
    expect(DEFAULT_PLANNING_MODE).toBe('project');
  });

  it('falls back for an unknown mode / origin rather than throwing', () => {
    expect(parsePlanningMode('teleport')).toBe('project');
    expect(parsePlanningMode(undefined)).toBe('project');
    expect(parsePlanningMode('')).toBe('project');
    expect(parsePlanningOrigin('elsewhere')).toBe('project');
    expect(parsePlanningLaunch({ mode: 'teleport', from: 'elsewhere' })).toEqual({
      mode: 'project',
      from: 'project',
      itemKey: null,
      repoKey: null,
    });
  });

  it('takes the first value when a param is repeated', () => {
    expect(parsePlanningLaunch({ mode: ['roadmap', 'generation'] }).mode).toBe('roadmap');
  });

  it('drops a target the origin did not write (no smuggling into another mode)', () => {
    const launch = parsePlanningLaunch({ mode: 'roadmap', from: 'roadmap', item: 'MOTIR-7' });
    expect(launch.itemKey).toBeNull();
    expect(parsePlanningLaunch({ from: 'work-item', repo: 'x' }).repoKey).toBeNull();
  });
});

describe('planningLaunchBackHref — Close returns to the originating surface', () => {
  it('returns to the work item for a contextual launch', () => {
    expect(planningLaunchBackHref(parseHref({ kind: 'work-item', itemKey: 'MOTIR-7' }))).toBe(
      '/items/MOTIR-7',
    );
  });

  it('encodes the item key it puts in the path', () => {
    expect(planningLaunchBackHref(parseHref({ kind: 'work-item', itemKey: 'a b&c' }))).toBe(
      '/items/a%20b%26c',
    );
  });

  it('returns to code health for a convention-refine launch', () => {
    expect(planningLaunchBackHref(parseHref({ kind: 'convention-refine', repoKey: 'r' }))).toBe(
      '/code-health',
    );
  });

  it('returns to the roadmap for the roadmap and project origins', () => {
    expect(planningLaunchBackHref(parseHref({ kind: 'roadmap' }))).toBe('/roadmap');
    expect(planningLaunchBackHref(parseHref({ kind: 'project', hasPlan: true }))).toBe('/roadmap');
  });

  it('falls back to the roadmap when a work-item launch lost its key', () => {
    expect(planningLaunchBackHref(parsePlanningLaunch({ from: 'work-item' }))).toBe('/roadmap');
  });
});
