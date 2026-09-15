// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { HomeActorContext } from '@/lib/services/homeService';
import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import en from '@/messages/en.json';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { ensureWorkWaitsOn } from '@/tests/helpers/designWaits';
import { truncateAuthTables } from '../../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — DECIDE IT FULL SCREEN (Story MOTIR-5214 · Subtask MOTIR-5226)
// ═══════════════════════════════════════════════════════════════════════════
//
// Three cards shipped this story — the route (MOTIR-5223), the overlay host
// (MOTIR-5224) and the row door (MOTIR-5225) — and each proved its own piece
// against input it built itself. This file stands at the JOINS, where one card's
// real output meets the next card's real consumer:
//
//   1. ROUTE → CLIENT → OVERLAY → FRAME. The browser's `fetch` is answered by the
//      REAL route handler over REAL Postgres, so the overlay's REAL client read
//      parses the route's REAL body. A shipped route and a shipped component do
//      not imply the route RETURNS what the component consumes; this asks.
//   2. DECIDE → ROW. The REAL `decideApprovalGateAction` is pressed through the
//      overlay's frame, and the row underneath and the count the strip reads are
//      asserted in ONE page state.
//   3. SCOPING, over a fixture where the actor's view and the true population
//      DIFFER by construction, with the positive control beside the negative.
//
// …and the GUARDS a percentage cannot see: one close seam, totality over
// `ApprovalGateKind` read FROM the constant, and one decide path. (The permission
// inventory's two directions are `tests/permissions/inventoryCoverage.test.ts`'s,
// and it runs in the docs lane — a spec here that read the document would be
// one a docs-only pull request never runs.)
//
// ⚠️ happy-dom + REAL POSTGRES in one file, deliberately — the seams END at a
// screen (`tests/permissions/customRolesStoryGate.integration.test.tsx` is the
// precedent). The stubs are the ones a Vitest process cannot supply for real:
// the session and active-project resolvers, Next's router and cache, the blob
// store the publish path touches, and the design PORT, which has its own suite
// and would otherwise sandbox-render a mock the seam says nothing about.

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

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/** The address bar: Next syncs `useSearchParams` with `history.pushState`, so a
 *  `shallowPush` here re-renders every reader of the query, as it does for real. */
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let params = new URLSearchParams();
  return {
    pushes: [] as string[],
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
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => ({ push, refresh }),
    usePathname: () => '/workbench',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.params),
    redirect: (to: string) => {
      throw new Error(`redirect → ${to}`);
    },
  };
});
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowPush: (href: string) => {
    nav.pushes.push(href);
    nav.go(href);
  },
  shallowReplace: vi.fn(),
}));

vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''} />
  ),
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { homeService } = await import('@/lib/services/homeService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { ApprovalsList } = await import('@/app/(authed)/workbench/_components/ApprovalsList');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = null;
  activeCtx.current = null;
  nav.pushes.length = 0;
  nav.go('/workbench');
  push.mockReset();
  refresh.mockReset();
  // The browser's `fetch`, answered by the REAL route — never a canned body.
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

type Actor = { id: string; email: string };
const owner = (): Actor => ({ id: fx.owner.id, email: fx.owner.email });

function signIn(actor: Actor, on: WorkItemFixture = fx) {
  session.current = { user: { id: actor.id, email: actor.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: on.project,
  } as ProjectContext;
}

function actorCtx(on: WorkItemFixture = fx): HomeActorContext {
  return { ...on.ctx, projectId: on.projectId };
}

/** A design subtask sitting where a published design waits: In Review. */
async function designCard(): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Decide it full screen' },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Draw the overlay' },
    fx.ctx,
  );
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
}

/** A REAL publish — it raises the card's `awaiting` design gate itself. */
async function publish(card: WorkItem) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}overlay.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}overlay.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  // AMENDMENT 4: a result is the mock plus ONE note file, published only while
  // an open work item is `blocked_by` the card.
  await ensureWorkWaitsOn(card.id, fx);
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: 'design/workbench/overlay.mock.html', pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/workbench/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: 'sha-overlay',
    },
    fx.ctx,
  );
}

const SLOW = { timeout: 15_000 };

describe('SEAM 1 · the route’s real answer reaches the frame', () => {
  it('the dialog, the published evidence in the port, and the verbs a decider gets', async () => {
    const card = await designCard();
    const evidence = await publish(card);
    signIn(owner());

    nav.go(`/workbench?tab=approvals&approval=${card.identifier}&approvalKind=design_result`);
    renderWithIntl(<ApprovalOverlay />);

    const dialog = await screen.findByRole(
      'dialog',
      { name: `Design result for ${card.identifier}` },
      SLOW,
    );
    // The port is handed the evidence the PUBLISH wrote — the id travelled
    // service → route → JSON → client → overlay → frame without a fixture.
    expect(within(dialog).getByTestId('design-port').dataset.evidence).toBe(evidence.id);
    expect(within(dialog).getByText('Draw the overlay')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Open work item' }).getAttribute('href')).toBe(
      `/items/${card.identifier}`,
    );
  });
});

describe('SEAM 2 · a decision made in the overlay, seen from the tab', () => {
  it('the row SETTLES and the strip’s count drops — read in ONE page state', async () => {
    const card = await designCard();
    await publish(card);
    signIn(owner());
    const queue = await approvalGatesService.listAwaitingMe(actorCtx(), { page: 1 });
    expect(queue.items).toHaveLength(1);
    // The strip's OWN read — the number the To approve badge renders.
    expect((await homeService.tabCounts(actorCtx())).approvals).toBe(1);
    const gateId = queue.items[0]!.gateId;

    nav.go('/workbench?tab=approvals');
    renderWithIntl(
      <>
        <ApprovalsList
          rows={queue.items}
          label="To approve"
          pagination={{ total: queue.total, page: queue.page, pageSize: queue.pageSize }}
        />
        <ApprovalOverlay />
      </>,
    );

    // The ROW's door — MOTIR-5225's — writes the address MOTIR-5224's host reads.
    fireEvent.click(screen.getByRole('link', { name: new RegExp(`^Review ${card.identifier} `) }));
    expect(nav.pushes).toEqual([
      `/workbench?tab=approvals&approval=${card.identifier}&approvalKind=design_result`,
    ]);
    const dialog = await screen.findByRole(
      'dialog',
      { name: `Design result for ${card.identifier}` },
      SLOW,
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Yes, Approve' }));
    // AUTHORITATIVE: the frame's pill is drawn from the gate the REAL action
    // returned, so it is true only once Postgres recorded the decision.
    await within(dialog).findAllByText(en.approvalGate.state.approved, {}, SLOW);

    // ⚠️ ONE PAGE STATE. Nothing has re-rendered the list from the server (the
    // refresh is a mock), so a settled row here can only be the island hearing
    // the overlay — and the count the strip renders is read at the same moment.
    const row = screen.getByTestId(`approval-row-${gateId}`);
    expect(within(row).getByText(en.approvalGate.state.approved)).toBeTruthy();
    // `hidden`: Radix hides the page behind a modal from the accessibility tree,
    // and a role query that skipped hidden nodes would find no button vacuously.
    expect(within(row).queryByRole('button', { name: 'Review', hidden: true })).toBeNull();
    expect((await homeService.tabCounts(actorCtx())).approvals).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } })).state).toBe(
      'approved',
    );

    // Closing returns to exactly the tab, with its own query intact.
    fireEvent.click(within(dialog).getByRole('button', { name: /^Close/ }));
    expect(nav.pushes.at(-1)).toBe('/workbench?tab=approvals');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SEAM 3 · the overlay is SCOPED — the actor’s view and the population differ', () => {
  it('an outsider’s address opens on NOT AVAILABLE; the same address resolves for its reader', async () => {
    const card = await designCard();
    await publish(card);
    const address = `/workbench?approval=${card.identifier}&approvalKind=design_result`;

    // The TRUE population holds one awaiting gate…
    expect(await adminDb.approvalGate.count({ where: { state: 'awaiting' } })).toBe(1);
    // …and the outsider's view of it is empty.
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const outsider = { id: elsewhere.owner.id, email: elsewhere.owner.email };
    signIn(outsider, elsewhere);
    expect(
      (await approvalGatesService.listAwaitingMe(actorCtx(elsewhere), { page: 1 })).total,
    ).toBe(0);

    nav.go(address);
    renderWithIntl(<ApprovalOverlay />);
    const refused = await screen.findByRole(
      'dialog',
      { name: en.approvalOverlay.notAvailable.title },
      SLOW,
    );
    expect(within(refused).queryByTestId('design-port')).toBeNull();
    // The exit row does not echo the key back beside a refusal.
    expect(within(refused).queryByText(card.identifier)).toBeNull();
    cleanup();

    // POSITIVE CONTROL — without it the refusal above could be a broken seam.
    signIn(owner());
    nav.go(address);
    renderWithIntl(<ApprovalOverlay />);
    expect(
      await screen.findByRole('dialog', { name: `Design result for ${card.identifier}` }, SLOW),
    ).toBeTruthy();
  });
});

describe('GUARD · TOTAL over `ApprovalGateKind`, enumerated FROM the constant', () => {
  // Registering a kind moves it out of `UNREGISTERED_GATE_KINDS`, so this loop
  // changes by itself — it fails a test rather than changing behaviour silently.
  expect(UNREGISTERED_GATE_KINDS.length).toBeGreaterThan(0);

  for (const kind of UNREGISTERED_GATE_KINDS) {
    it(`${kind}: the route answers and the overlay draws "not built yet", with no frame`, async () => {
      const card = await designCard();
      await withWorkspaceContext(fx.ctx, (tx) =>
        approvalGateRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: card.id,
            kind: kind as 'design_result',
            subjectId: `subject-of-${kind}`,
          },
          tx,
        ),
      );
      signIn(owner());

      nav.go(`/workbench?approval=${card.identifier}&approvalKind=${kind}`);
      renderWithIntl(<ApprovalOverlay />);

      const dialog = await screen.findByRole(
        'dialog',
        { name: `${en.workbench.approvals.kind[kind]} for ${card.identifier}` },
        SLOW,
      );
      expect(within(dialog).getByText(en.workbench.approvals.notRenderable)).toBeTruthy();
      expect(within(dialog).queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Approve' })).toBeNull();
    });
  }
});

// ── The STRUCTURAL guards ──────────────────────────────────────────────────

const ROOT = process.cwd();

/** A file with its comments stripped — each guard asserts an ABSENCE, and these
 *  files discuss the very thing at length in prose
 *  (`tests/approval-gate-one-language.test.ts` records the same trap). */
function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

const OVERLAY = 'components/approvals/ApprovalOverlay.tsx';

describe('GUARD · ONE close seam', () => {
  // Esc, the scrim, the exit row's Close and the not-available arm's Close all
  // reach `requestClose`; Back needs no call, because the address it lands on is
  // already closed. One function is the ONE place a later pending-work guard —
  // the shape MOTIR-4731 built for the planning overlay — has to intercept.
  const code = codeOf(OVERLAY);

  it('writes the closed address in exactly one place, and that place is `requestClose`', () => {
    expect(code.match(/shallowPush\(/g)).toHaveLength(1);
    expect(code.match(/withoutApprovalOverlay\(/g)).toHaveLength(1);
    const start = code.indexOf('const requestClose = useCallback(');
    expect(start).toBeGreaterThan(-1);
    expect(code.slice(start, code.indexOf('}, [', start))).toMatch(
      /shallowPush\(\s*withoutApprovalOverlay\(/,
    );
  });

  it('routes the dialog’s own dismissals, the exit row and the refusal’s button to it', () => {
    expect(code).toMatch(/onOpenChange=\{\(next\) => \{\s*if \(!next\) requestClose\(\);\s*\}\}/);
    expect(code).toContain('onClose={requestClose}');
    expect(code).toContain('onClick={requestClose}');
  });

  it('has no second way to leave the address — no replace, no history walk', () => {
    expect(code).not.toMatch(/shallowReplace|router\.(back|replace)\(|history\.(back|go)\(/);
  });
});

describe('GUARD · ONE decide path — no second approve control', () => {
  it('the decide action is called from the overlay, and nowhere else — the item page hands it over (MOTIR-5229)', () => {
    const callers = ['app', 'components', 'lib']
      .flatMap(sourceFiles)
      .filter((f) => codeOf(f).includes('decideApprovalGateAction('))
      .filter((f) => !f.endsWith('approvalGateActions.ts'))
      .sort();
    expect(callers).toEqual([OVERLAY]);
  });

  it('the Approvals list composes no frame of its own any more', () => {
    const list = codeOf('app/(authed)/workbench/_components/ApprovalsList.tsx');
    expect(list).not.toContain('ApprovalGateControl');
    expect(list).not.toContain('decideApprovalGateAction');
  });
});
