import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The three ERROR-LINK server actions (Story MOTIR-4932 · Subtask MOTIR-5731):
// each resolves the session and active project like the pull-request link
// actions, calls ONE service method, revalidates the item on a write, and turns
// every typed refusal into a CODE — never copy, which the Errors section owns.

const sessionState: { user: { id: string; email: string; name: string } | null } = { user: null };

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () =>
    sessionState.user ? { user: sessionState.user, session: { token: 't' } } : null,
  ),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers()),
}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { fakeMonitorProvider, fakeMonitorState, resetFakeMonitorProvider } =
  await import('@/lib/monitors/providers/fake');
const { sentryMonitorProvider } = await import('@/lib/monitors/providers/sentry');
const { registerMonitorProvider } = await import('@/lib/monitors/registry');
const { searchMonitorIssuesAction, linkMonitorIssueAction, unlinkMonitorIssueAction } =
  await import('@/app/(authed)/items/[key]/actions');
const { card, memberWithPermissions, monitorLinkScenario } = await import('./_monitorLinkFixtures');

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  revalidatePath.mockClear();
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  sessionState.user = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function seedIssue(externalId: string): void {
  fakeMonitorState().issues = [
    {
      externalId,
      title: `Error ${externalId}`,
      culprit: null,
      level: 'error',
      eventCount: 5,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      permalink: null,
      assignee: null,
      externalProjectId: 'fake-web',
    },
  ];
}

async function signedIn() {
  const s = await monitorLinkScenario('Actions');
  sessionState.user = { id: s.fx.owner.id, email: s.fx.owner.email, name: s.fx.owner.name };
  return s;
}

describe('the error-link actions', () => {
  it('search → link → already_linked → move → unlink, each as a code, revalidating on writes', async () => {
    const s = await signedIn();
    const a = await card(s.fx, 'A');
    const b = await card(s.fx, 'B');
    seedIssue('act');

    const search = await searchMonitorIssuesAction({ workItemId: a.id, query: 'error' });
    expect(search).toMatchObject({ ok: true, result: { noConnection: false } });
    if (!search.ok) throw new Error('unreachable');
    expect(search.result.candidates.map((c) => c.externalIssueId)).toEqual(['act']);

    const base = { connectionId: s.webConnectionId, externalIssueId: 'act' };
    expect(
      await linkMonitorIssueAction({
        ...base,
        workItemId: a.id,
        identifier: a.identifier,
        move: false,
      }),
    ).toEqual({ ok: true, outcome: 'linked' });
    expect(revalidatePath).toHaveBeenLastCalledWith(`/items/${a.identifier}`);

    expect(
      await linkMonitorIssueAction({
        ...base,
        workItemId: b.id,
        identifier: b.identifier,
        move: false,
      }),
    ).toEqual({ ok: false, code: 'already_linked', holderIdentifier: a.identifier });

    expect(
      await linkMonitorIssueAction({
        ...base,
        workItemId: b.id,
        identifier: b.identifier,
        move: true,
      }),
    ).toEqual({ ok: true, outcome: 'moved' });

    const row = await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'act' } });
    // A's page is stale: its unlink addresses a row B now holds.
    expect(
      await unlinkMonitorIssueAction({
        workItemId: a.id,
        identifier: a.identifier,
        monitorIssueId: row.id,
      }),
    ).toEqual({ ok: false, code: 'not_found' });
    revalidatePath.mockClear();
    expect(
      await unlinkMonitorIssueAction({
        workItemId: b.id,
        identifier: b.identifier,
        monitorIssueId: row.id,
      }),
    ).toEqual({ ok: true, removed: true });
    expect(revalidatePath).toHaveBeenCalledWith(`/items/${b.identifier}`);
    revalidatePath.mockClear();
    expect(
      await unlinkMonitorIssueAction({
        workItemId: b.id,
        identifier: b.identifier,
        monitorIssueId: row.id,
      }),
    ).toEqual({ ok: true, removed: false });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a gone issue is issue_gone; a refused provider read is provider_failed with its words', async () => {
    const s = await signedIn();
    const a = await card(s.fx);
    seedIssue('g');
    const input = {
      workItemId: a.id,
      identifier: a.identifier,
      connectionId: s.webConnectionId,
      externalIssueId: 'g',
      move: false,
    };

    fakeMonitorState().deletedIssues.add('g');
    expect(await linkMonitorIssueAction(input)).toEqual({ ok: false, code: 'issue_gone' });

    fakeMonitorState().deletedIssues.clear();
    fakeMonitorState().failNextStatus.set('getIssue', { status: 500, reason: 'Internal Error' });
    expect(await linkMonitorIssueAction(input)).toEqual({
      ok: false,
      code: 'provider_failed',
      reason: 'Internal Error',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('an item-read-only actor is forbidden on all three; an unknown card is not_found', async () => {
    const s = await signedIn();
    const a = await card(s.fx);
    const reader = await memberWithPermissions(s.fx, ['project:browse'], 'reader@ex.com');
    const readerUser = await adminDb.user.findUniqueOrThrow({ where: { id: reader.userId } });
    sessionState.user = { id: readerUser.id, email: readerUser.email, name: readerUser.name };

    expect(await searchMonitorIssuesAction({ workItemId: a.id, query: '' })).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(
      await linkMonitorIssueAction({
        workItemId: a.id,
        identifier: a.identifier,
        connectionId: s.webConnectionId,
        externalIssueId: 'x',
        move: false,
      }),
    ).toEqual({ ok: false, code: 'forbidden' });
    expect(
      await unlinkMonitorIssueAction({
        workItemId: a.id,
        identifier: a.identifier,
        monitorIssueId: 'nope',
      }),
    ).toEqual({ ok: false, code: 'forbidden' });

    expect(await searchMonitorIssuesAction({ workItemId: 'no-such-item', query: '' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});
