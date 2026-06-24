import { describe, it, expect } from 'vitest';
import {
  resolvePlanningMode,
  planningWorkspaceHref,
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
