// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  findFirst,
  renderFirstFlush,
  renderTree,
  textOf,
} from '../../helpers/serverPageHarness';

// FAMILY 1 of 5 — PROJECT SETTINGS (Story MOTIR-3440 · Task MOTIR-3568).
//
// `/settings/project/automation` is the family's worked example: the E2E walks
// it (`tests/e2e/acceptance-pages-stream.spec.ts` chapter 1) and MOTIR-3558's
// allocation row 4 is what put the boundary in it.
//
// `tests/navigation/settings-panes-arrival.test.ts` already asserts, from the
// SOURCE, that the gate sits above the boundary and the body inside it. What it
// cannot assert is the consequence: that the header therefore REACHES a reader
// while the six-way fan-out below is still open. That is this file's first test,
// and it is the one thing only a render can see.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { getActiveProject } = vi.hoisted(() => ({ getActiveProject: vi.fn() }));
const { getPermissions } = vi.hoisted(() => ({ getPermissions: vi.fn() }));
const { listRules } = vi.hoisted(() => ({ listRules: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', async () => ({
  ...(await import('../../helpers/serverPageHarness')).navigationHooks(),
  redirect,
}));
vi.mock('next-intl/server', async () => ({
  getTranslations: (await import('../../helpers/serverPageHarness')).serverTranslations,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getPermissions },
}));
vi.mock('@/lib/services/automationRulesService', () => ({
  automationRulesService: { list: listRules },
}));
vi.mock('@/lib/services/workflowsService', () => ({
  workflowsService: { getWorkflow: async () => ({ statuses: [] }) },
}));
vi.mock('@/lib/services/assignableMembersService', () => ({
  assignableMembersService: { list: async () => [] },
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: { listByProject: async () => [] },
}));
vi.mock('@/lib/services/customFieldsService', () => ({
  customFieldsService: { listFields: async () => [] },
}));
vi.mock('@/lib/services/componentsService', () => ({
  componentsService: { listComponents: async () => [] },
}));
vi.mock('@/lib/services/labelsService', () => ({
  labelsService: { resolveByIds: async () => [] },
}));

import ProjectAutomationPage from '@/app/(authed)/settings/project/automation/page';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { EmptyState } from '@/components/ui/EmptyState';

const PROJECT = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { identifier: 'ACME', name: 'Acme', accessLevel: 'open' },
};

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1', name: 'Ada', email: 'ada@example.com' } });
  getActiveProject.mockResolvedValue(PROJECT);
  getPermissions.mockResolvedValue(new Set(['automation:manage']));
  listRules.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/settings/project/automation — the frame reaches the reader BEFORE the pane', () => {
  it('flushes the header and the pane frame while the rule read is still open', async () => {
    // The whole point of MOTIR-3558's allocation: the header is painted from the
    // GATE, and only the six-way fan-out sits behind the boundary. Hold the
    // first read of that fan-out open and the shell React flushes is exactly
    // what a reader on a cold cache gets.
    const rules = deferred<unknown[]>();
    listRules.mockReturnValue(rules.promise);

    const flush = await renderFirstFlush(await ProjectAutomationPage());

    // REAL, from the gate — the title and the subtitle.
    expect(flush.shell).toContain('automation.title');
    expect(flush.shell).toContain('automation.subtitle');
    // …and the FRAME in the pane's place — `PageSkeleton`'s reveal wrapper
    // (MOTIR-3531) carrying `SettingsPaneFrame`'s ghost blocks (MOTIR-3558).
    expect(flush.shell).toContain('data-testid="page-skeleton"');
    expect(flush.shell).toContain('data-testid="settings-pane-frame"');
    expect(flush.shell).toContain('aria-busy="true"');
    // …and NOT the pane. `AutomationSettings`' empty state is its shortest
    // possible body, so its absence is the strongest available negative.
    expect(flush.shell).not.toContain('No rules yet');
    expect(listRules).toHaveBeenCalledTimes(1);

    // Then the body settles and the pane arrives in the SAME response, after
    // the frame rather than instead of it.
    rules.resolve([]);
    const complete = await flush.complete();
    expect(complete).toContain('No rules yet');
    expect(complete.indexOf('settings-pane-frame')).toBeLessThan(complete.indexOf('No rules yet'));
  });

  it('renders the pane below the boundary once the reads resolve', async () => {
    const flush = await renderFirstFlush(await ProjectAutomationPage());
    const complete = await flush.complete();

    // The settled document carries both halves — the header from the gate and
    // the pane from below the boundary.
    expect(complete).toContain('automation.title');
    expect(complete).toContain('No rules yet');
  });
});

describe('/settings/project/automation — the branches no structural test reaches', () => {
  it('redirects a signed-out reader to /sign-in', async () => {
    getSession.mockResolvedValue(null);

    await expect(renderTree(ProjectAutomationPage)).rejects.toThrow('REDIRECT:/sign-in');
    expect(redirect).toHaveBeenCalledWith('/sign-in');
  });

  it('renders the no-project empty state, and never reaches the guard', async () => {
    getActiveProject.mockResolvedValue(null);

    const tree = await renderTree(ProjectAutomationPage);

    expect(findFirst(tree, EmptyState)).toBeDefined();
    expect(findFirst(tree, SettingsPaneFrame)).toBeUndefined();
    expect(getPermissions).not.toHaveBeenCalled();
  });

  it('returns the guard’s refusal INSTEAD of the pane when the key is not held', async () => {
    // The destination guard (MOTIR-2469): hiding the rail row is presentation,
    // and this is the protection. An actor who can browse the project but does
    // not hold `automation:manage` gets the refusal and no boundary at all.
    getPermissions.mockResolvedValue(new Set([]));

    const tree = await renderTree(ProjectAutomationPage);

    expect(findFirst(tree, SettingsPaneFrame)).toBeUndefined();
    expect(textOf(tree)).toContain('noAccess');
    expect(listRules).not.toHaveBeenCalled();
  });
});
