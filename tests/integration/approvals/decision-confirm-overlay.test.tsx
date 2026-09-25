// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import en from '@/messages/en.json';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE CONFIRM PORT IN THE OVERLAY, OVER REAL STATE (Story MOTIR-5871 · Subtask MOTIR-5960).
// The browser's `fetch` is answered by the REAL overlay route and a press goes through
// the REAL server action to the REAL decide door, so this asserts what only the whole
// path can: Confirm moves the decision to Done and the frame shows *Confirmed* without a
// reload; Overturn is refused in place until it has a note, then moves the decision to
// Cancelled and shows the note and the owed re-plan; and a press against a body edited
// under the reader is the stale refusal, whose *Show the current version* re-reads.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let params = new URLSearchParams();
  return {
    get params() {
      return params;
    },
    go(href: string) {
      params = new URL(href, 'http://localhost:3000').searchParams;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    usePathname: () => '/workbench',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.params),
  };
});
const { shallowReplace } = vi.hoisted(() => ({ shallowReplace: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowPush: (href: string) => nav.go(href),
  shallowReplace,
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');

const SLOW = { timeout: 15_000 };
const t = en.approvalGate.decisionConfirm;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: fx.owner.name } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost:3000');
    if (url.pathname !== '/api/work-items/approval-gate') throw new Error(`unexpected ${url}`);
    return gateRoute(new Request(url));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function scene() {
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Exports' },
    fx.ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Postgres export table', parentId: epic.id },
    fx.ctx,
  );
  const body = [
    '## Decision',
    'Exports move to managed object storage.',
    '## What changed',
    '**Change:** less requirement',
    'The approved plan kept exports in Postgres.',
    '## Supersedes',
    story.identifier,
    '## Resulting direction',
    'Every export is written to the bucket.',
  ].join('\n');
  const decision = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      parentId: epic.id,
      title: 'Exports move to a bucket',
      type: 'decision',
      executor: 'human',
      descriptionMd: body,
    },
    fx.ctx,
  );
  return { epic, story, decision, body };
}

async function open(key: string) {
  nav.go(`/workbench?approval=${key}&approvalKind=decision_confirmation`);
  renderWithIntl(<ApprovalOverlay />);
  return screen.findByRole('dialog', { name: `${t.kindLabel} for ${key}` }, SLOW);
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

describe('Confirm, from the overlay', () => {
  it('moves the decision to Done and shows Confirmed without a reload', async () => {
    const { decision, story } = await scene();
    const dialog = await open(decision.identifier);
    expect(within(dialog).getByText('Exports move to managed object storage.')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: new RegExp(story.identifier) })).toBeTruthy();
    expect(within(dialog).getByText(t.record.none)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: t.verb.confirm }));
    fireEvent.click(within(dialog).getByRole('button', { name: t.confirmStep.proceed }));

    await waitFor(async () => expect(await statusOf(decision.id)).toBe('done'), SLOW);
    expect(await within(dialog).findByText(t.band.withoutRecord, {}, SLOW)).toBeTruthy();
    expect(within(dialog).getByText(t.state.confirmed)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: t.verb.confirm })).toBeNull();
  });
});

describe('Overturn, from the overlay', () => {
  it('refuses an empty note in place, then records the note, Cancels and owes the re-plan', async () => {
    const { decision, story, epic } = await scene();
    const dialog = await open(decision.identifier);

    fireEvent.click(within(dialog).getByRole('button', { name: t.verb.overturn }));
    fireEvent.click(within(dialog).getByRole('button', { name: t.overturnStep.proceed }));
    expect(await within(dialog).findByText(t.note.required)).toBeTruthy();
    expect(await statusOf(decision.id)).toBe('in_review');

    fireEvent.change(within(dialog).getByLabelText(t.note.label), {
      target: { value: 'We agreed to keep Postgres.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t.overturnStep.proceed }));

    await waitFor(async () => expect(await statusOf(decision.id)).toBe('cancelled'), SLOW);
    expect(await within(dialog).findByText('“We agreed to keep Postgres.”', {}, SLOW)).toBeTruthy();
    expect(within(dialog).getByText(t.band.replanOwed)).toBeTruthy();
    expect(within(dialog).getAllByText(story.identifier).length).toBeGreaterThan(0);
    // MOTIR-6211: the plain epic entrance is gone — the band ASKS to re-plan THIS decision,
    // seeded, and nothing opens until the reader says yes.
    expect(within(dialog).queryByText(`Exports (${epic.identifier})`)).toBeNull();
    const askTitle = en.approvalGate.replanAsk.title.replace('{key}', decision.identifier);
    expect(within(dialog).getByRole('group', { name: askTitle })).toBeTruthy();
    expect(shallowReplace).not.toHaveBeenCalled();
    // The overturn changed no other work item.
    expect(await statusOf(story.id)).toBe('todo');
    fireEvent.click(within(dialog).getByRole('button', { name: en.approvalGate.replanAsk.yes }));
    const written = new URL(shallowReplace.mock.calls[0]![0] as string, 'http://localhost:3000');
    expect(written.searchParams.get('approval')).toBeNull();
    expect(written.searchParams.get('planFrom')).toBe('refused-gate');
    const gate = await adminDb.approvalGate.findFirstOrThrow({
      where: { workItemId: decision.id, kind: 'decision_confirmation' },
    });
    expect(written.searchParams.get('planGate')).toBe(gate.id);
  });
});

describe('a body edited under the reader', () => {
  it('is the stale refusal, and Show the current version re-reads the frame', async () => {
    const { decision, body } = await scene();
    const dialog = await open(decision.identifier);

    // Outside the four sections: the gate stands, the reader's stamp is stale.
    await workItemsService.updateWorkItem(
      decision.id,
      { descriptionMd: `A closing thought.\n\n${body}` },
      fx.ctx,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: t.verb.confirm }));
    fireEvent.click(within(dialog).getByRole('button', { name: t.confirmStep.proceed }));

    const control = await within(dialog).findByRole(
      'button',
      { name: en.approvalGate.refusal.stale.control },
      SLOW,
    );
    expect(await statusOf(decision.id)).toBe('in_review');
    fireEvent.click(control);
    // The fresh read re-mounts the frame: the refusal goes, the verbs return, and a press
    // against the current stamp now succeeds.
    await waitFor(
      () =>
        expect(
          within(dialog).queryByRole('button', { name: en.approvalGate.refusal.stale.control }),
        ).toBeNull(),
      SLOW,
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: t.verb.confirm }, SLOW));
    fireEvent.click(within(dialog).getByRole('button', { name: t.confirmStep.proceed }));
    await waitFor(async () => expect(await statusOf(decision.id)).toBe('done'), SLOW);
  });
});
