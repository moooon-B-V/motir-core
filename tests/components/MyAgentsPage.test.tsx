// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// THE MY AGENTS PAGE (Story MOTIR-6860 · MOTIR-6874; MOTIR-7062 — the lane
// measures the route now). The Server Component in the shape of
// `tests/planning/plansSessionListPage.test.tsx`: mock the request boundary (the
// session, the active project, the permission read, the translations, the
// lifecycle service), `await MyAgentsPage()`, and assert on the element tree —
// the gate BEFORE the frame, which agent `?agent=` reopens, the wait the
// <Suspense> shows, and that a failed first read is its own face (`initial: null`),
// never the empty list.

const { getSession, getActiveProject, getPermissions, list, isCloudBilling } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveProject: vi.fn(),
  getPermissions: vi.fn(),
  list: vi.fn(),
  isCloudBilling: vi.fn(),
}));

const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('next-intl/server', () => ({
  // The key, with any values it was given — enough to see WHICH words were asked for.
  getTranslations: async (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/projects', () => ({ getActiveProject }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { getPermissions },
}));
vi.mock('@/lib/billing/availability', () => ({ isCloudBilling }));
vi.mock('@/lib/services/agentInstanceLifecycleService', () => ({
  agentInstanceLifecycleService: { list },
}));

import MyAgentsPage from '@/app/(authed)/my-agents/page';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import { MyAgentsSkeleton } from '@/app/(authed)/my-agents/_components/MyAgentsSkeleton';
import { OFFERED_AGENT_PROFILES } from '@/lib/agentInstances/profiles';
import {
  INSTANCE_MAX_PER_USER,
  INSTANCE_STORAGE_CREDITS_PER_DAY,
} from '@/lib/agentInstances/config';
import { MY_AGENTS_LIST_LIMIT } from '@/lib/agentInstances/presentation';

const ACTIVE = {
  userId: 'u1',
  workspaceId: 'ws1',
  projectId: 'p1',
  project: { id: 'p1', identifier: 'MOTIR', name: 'motir' },
};

const LISTED = { instances: [], total: 0, planLapse: null };

const render = (agent?: string | string[]) =>
  MyAgentsPage({ searchParams: Promise.resolve(agent === undefined ? {} : { agent }) });

/** The page's <Suspense>, and the room its data child resolves to. */
async function resolve(tree: ReactElement) {
  expect(tree.type).toBe(Suspense);
  const suspense = tree as ReactElement<{ fallback: ReactElement; children: ReactElement }>;
  const data = suspense.props.children as ReactElement<Record<string, unknown>>;
  const component = data.type as (props: Record<string, unknown>) => Promise<ReactNode>;
  const room = (await component(data.props)) as ReactElement<Record<string, unknown>>;
  expect(room.type).toBe(MyAgentsRoom);
  return { fallback: suspense.props.fallback, room };
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
  getActiveProject.mockResolvedValue(ACTIVE);
  getPermissions.mockResolvedValue(new Set(['project:browse', 'instance:use']));
  list.mockResolvedValue(LISTED);
  isCloudBilling.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('/my-agents — the gate first, then the frame', () => {
  it('a reader without `instance:use` gets notFound, and the list is never read', async () => {
    getPermissions.mockResolvedValue(new Set(['project:browse']));
    await expect(render()).rejects.toThrow('NOT_FOUND');
    expect(getPermissions).toHaveBeenCalledWith('p1', { userId: 'u1', workspaceId: 'ws1' });
    expect(list).not.toHaveBeenCalled();
  });

  it('no session goes to sign-in before any permission read', async () => {
    getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('REDIRECT:/sign-in');
    expect(getPermissions).not.toHaveBeenCalled();
  });
});

describe('/my-agents — the room over the reader’s own list', () => {
  it('reads the first page of the reader’s agents on the active project and hands the room its facts', async () => {
    const { room } = await resolve(await render());
    expect(list).toHaveBeenCalledWith(
      'MOTIR',
      { take: MY_AGENTS_LIST_LIMIT, skip: 0 },
      { userId: 'u1', workspaceId: 'ws1' },
    );
    expect(room.props).toEqual({
      projectKey: 'MOTIR',
      projectName: 'motir',
      initial: LISTED,
      profiles: OFFERED_AGENT_PROFILES.map((p) => ({ id: p.id, name: p.name })),
      maxPerUser: INSTANCE_MAX_PER_USER,
      storageCreditsPerDay: INSTANCE_STORAGE_CREDITS_PER_DAY,
      openAgentId: null,
    });
  });

  it('a self-hosted build charges no storage, so the room is given no rate', async () => {
    isCloudBilling.mockReturnValue(false);
    const { room } = await resolve(await render());
    expect(room.props['storageCreditsPerDay']).toBeNull();
  });

  it('`?agent=<id>` reopens that agent’s panel; an empty or repeated value opens none', async () => {
    expect((await resolve(await render('a1'))).room.props['openAgentId']).toBe('a1');
    expect((await resolve(await render(''))).room.props['openAgentId']).toBeNull();
    expect((await resolve(await render(['a1', 'a2']))).room.props['openAgentId']).toBeNull();
  });

  it('a failed first read is its own face — `initial: null`, never the empty list — and is logged without the payload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    list.mockRejectedValueOnce(new Error('db down'));
    expect((await resolve(await render())).room.props['initial']).toBeNull();
    expect(error).toHaveBeenCalledWith('[my-agents] the first read failed', {
      projectKey: 'MOTIR',
      detail: 'db down',
    });

    list.mockRejectedValueOnce('timeout');
    expect((await resolve(await render())).room.props['initial']).toBeNull();
    expect(error).toHaveBeenLastCalledWith('[my-agents] the first read failed', {
      projectKey: 'MOTIR',
      detail: 'timeout',
    });
  });
});

describe('/my-agents — the wait (panel 7)', () => {
  it('the Suspense fallback is the skeleton: the page header in the page’s words, then pulsing lines', async () => {
    const { fallback } = await resolve(await render());
    expect(fallback.type).toBe(MyAgentsSkeleton);
    expect(fallback.props).toEqual({
      title: 'myAgents.title',
      subtitle: 'myAgents.subtitle:{"project":"motir"}',
      newAgent: 'myAgents.newAgent',
    });

    const html = renderToStaticMarkup(fallback);
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<h1[^>]*>myAgents\.title<\/h1>/);
    expect(html).toContain('myAgents.subtitle:{&quot;project&quot;:&quot;motir&quot;}');
    // The New agent button is drawn, not offered: nothing to click while it waits.
    expect(html).not.toContain('<button');
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>.*myAgents\.newAgent<\/span>/);
    expect(html.match(/animate-pulse/g)).toHaveLength(3);
  });
});
