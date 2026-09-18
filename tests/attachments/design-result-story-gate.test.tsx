// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — A DESIGN RESULT SHOWS ONLY WHAT TO REVIEW
// (Story MOTIR-5488 · Subtask MOTIR-5499)
// ═══════════════════════════════════════════════════════════════════════════
//
// Each code card of this story proved its own piece against input it built
// itself. This file stands at the JOINS, over real Postgres:
//
//   1. PUBLISH → READ → PANEL. A real tool publish, read back through the two
//      service reads the item page and the approval gate route serve, rendered by
//      the real `DesignResultPanel` — the frame and the note link must come from
//      the published rows, never from a hand-built DTO.
//   2. ONE GATING ANSWER, TWO READERS. The publish refusal (MOTIR-5491) and the
//      dispatch prompt's publish step (MOTIR-5495) read "does anything wait on
//      this design" — they must agree on the same fixture.
//   3. THE RACE. A dependent closed after the pre-upload check but before the
//      publish commits yields the refusal, never a gate.
//   4. ONE GATE PER CARD WITH A PULL REQUEST (Q8, MOTIR-5534 + MOTIR-5498).
//   5. GUARDS A PERCENTAGE CANNOT SEE — `image` refused through every door.
//
// The object store is the ONE mocked external, mocked as a STORE (the same fake
// `design-publish-integration.test.ts` documents), plus the frame's probe `fetch`.

const store = new Map<string, { contentType: string; size: number }>();
/** Runs inside the store's PUT — after the pre-upload check, before the publish tx. */
const race = { hook: null as null | (() => Promise<void>) };

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
    if (race.hook) {
      const hook = race.hook;
      race.hook = null;
      await hook();
    }
    const dot = pathname.lastIndexOf('.');
    const suffix = randomBytes(5).toString('hex');
    const written =
      dot <= pathname.lastIndexOf('/')
        ? `${pathname}-${suffix}`
        : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
    store.set(written, { contentType, size: body.byteLength });
    return { pathname: written };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { runPublishDesignResult, runCreateDesignUpload } =
  await import('@/lib/mcp/tools/publishDesignResult');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { grantForLegacyScopes } = await import('../helpers/tokenGrant');
const { linkPr } = await import('../helpers/prLink');
const { makeWorkWaitOn } = await import('../helpers/designWaits');
const { hasOpenPullRequest } = await import('@/components/github/DevelopmentSection');
const { DesignResultPanel } =
  await import('@/app/(authed)/items/[key]/_components/DesignResultPanel');
const { POST: MINT } = await import('@/app/api/work-items/[id]/design-evidence/upload-token/route');
const { POST: REGISTER } = await import('@/app/api/work-items/[id]/design-evidence/route');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  race.hook = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 })),
  );
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "approval_gate", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

const MOCK = {
  kind: 'mock' as const,
  sourcePath: 'design/work-items/rail--what-to-review.mock.html',
  contentType: 'text/html',
  contentBase64: b64('<!doctype html><title>rail</title><p>rail</p>'),
};
const NOTE = {
  kind: 'note_file' as const,
  sourcePath: 'design/work-items/design-notes.md',
  contentType: 'text/markdown',
  contentBase64: b64('## The rail\n\nThe note, published as a file.\n'),
};

/** A design subtask under a story — the kind-parent matrix is a DB trigger. */
async function designCard(title = 'Design — the rail') {
  const story = await createTestWorkItem(fx, { kind: 'story', title: `Story for ${title}` });
  return createTestWorkItem(fx, { kind: 'subtask', title, parentId: story.id });
}

const publish = (key: string) =>
  runPublishDesignResult(
    { key, assets: [MOCK, NOTE], commitSha: 'c0389f2', producedByKey: key },
    fx.ctx,
  );

const designGates = (workItemId: string) =>
  adminDb.approvalGate.findMany({ where: { workItemId, kind: 'design_result' } });

// ── 1 ────────────────────────────────────────────────────────────────────────
describe('publish → read → panel', () => {
  it('the panel renders the PUBLISHED rows — the frame and the note link — and nothing inline', async () => {
    const card = await designCard();
    await makeWorkWaitOn(card.id, fx);
    const result = await publish(card.identifier);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    // The item page's read.
    const current = await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx);
    // The approval gate route's read — by the gate's own subject.
    const [gate] = await designGates(card.id);
    expect(gate?.state).toBe('awaiting');
    const subject = await designEvidenceService.getForGateSubject(
      { workItemId: card.id, subjectId: gate!.subjectId },
      fx.ctx,
    );

    for (const evidence of [current, subject.evidence]) {
      expect(evidence).not.toBeNull();
      const mock = evidence!.assets.find((a) => a.kind === 'mock')!;
      const note = evidence!.assets.find((a) => a.kind === 'note_file')!;

      const { container, unmount } = render(<DesignResultPanel evidence={evidence} isDesignCard />);
      await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
      expect(container.querySelector('iframe')!.getAttribute('src')).toBe(mock.url);
      expect(screen.getByRole('link', { name: /Open note/ }).getAttribute('href')).toBe(note.url);
      expect(screen.getByText(NOTE.sourcePath)).toBeTruthy();
      // No inline Markdown and no image thumbnail for a new result.
      expect(container.querySelector('.motir-prose')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(screen.queryByText('Earlier format')).toBeNull();
      unmount();
    }
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────
describe('one gating answer, two readers', () => {
  /** A design card with dependents todo (in ANOTHER story), done and cancelled. */
  async function fixture() {
    const card = await designCard();
    const otherStory = await createTestWorkItem(fx, { kind: 'story', title: 'Another story' });
    const todo = await makeWorkWaitOn(card.id, fx, {
      title: 'Build it',
      kind: 'subtask',
      parentId: otherStory.id,
    });
    const done = await makeWorkWaitOn(card.id, fx, { title: 'Shipped' });
    const cancelled = await makeWorkWaitOn(card.id, fx, { title: 'Dropped' });
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
    await adminDb.workItem.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } });
    await adminDb.workItem.update({ where: { id: card.id }, data: { type: 'design' } });
    return { card, todo, done, cancelled };
  }

  async function readers(card: { id: string; identifier: string }) {
    const prompt = (
      await dispatchPromptService.getDispatchPrompt(fx.projectId, card.identifier, fx.ctx)
    ).prompt;
    const published = await publish(card.identifier);
    return { prompt, published };
  }

  it('ONE dependent open — the prompt names it and says publish; the publish is accepted', async () => {
    const { card, todo, done, cancelled } = await fixture();
    const { prompt, published } = await readers(card);

    expect(prompt).toContain(`${todo.key} is blocked_by this card`);
    expect(prompt).not.toContain(done.key);
    expect(prompt).not.toContain(cancelled.key);
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('EVERY dependent closed — the prompt says do not publish; the publish is refused', async () => {
    const { card, todo } = await fixture();
    await adminDb.workItem.update({ where: { id: todo.id }, data: { status: 'done' } });
    const { prompt, published } = await readers(card);

    expect(prompt).toContain('Do NOT publish a design result');
    expect(published.isError).toBe(true);
    expect(JSON.stringify(published)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(0);
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────
describe('the race — a dependent closes while the publish is in flight', () => {
  it('yields the refusal from inside the publish transaction, and no gate', async () => {
    const card = await designCard();
    const dependent = await makeWorkWaitOn(card.id, fx);
    // The pre-upload check has passed by the time the bytes are written; close
    // the only dependent in its own committed transaction right then.
    race.hook = async () => {
      await adminDb.workItem.update({ where: { id: dependent.id }, data: { status: 'done' } });
    };

    const result = await publish(card.identifier);

    expect(race.hook, 'the hook must have run inside the upload').toBeNull();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(0);
    expect(await designGates(card.id)).toHaveLength(0);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────
// ⚠️ REVERSED — Bug MOTIR-5652 · Subtask MOTIR-5662 (AMENDMENT 6 Q1), reversing
// AMENDMENT 4 Q8 / MOTIR-5534. A design card with an open delivering pull request
// raises its design gate again, and that gate is the PRIMARY: the result still
// renders inside the Development block, with the pull requests beneath it as what
// approving will merge. The peek assertions are UNCHANGED — the composition is what
// Q8 got right, and the suppressed question is what it got wrong.
describe('two gates per card, with a pull request (AMENDMENT 6 Q1)', () => {
  async function connect(repos: string[]) {
    await githubInstallationService.persistInstallation({
      workspaceId: fx.workspaceId,
      installation: {
        installationId: `inst-${fx.workspaceId}`,
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: repos.map((name, i) => ({
        providerRepoId: `${fx.workspaceId}-${i}`,
        owner: 'moooon',
        name,
        defaultBranch: 'main',
        archived: false,
      })),
    });
  }

  const link = (workItemId: string, name: string, number: number) =>
    linkPr(
      {
        workItemId,
        projectId: fx.projectId,
        owner: 'moooon',
        name,
        number,
        headRef: `design/${number}`,
      },
      fx.ctx,
    );

  async function readPeek(card: { identifier: string }) {
    return workItemsService.getQuickView(
      fx.projectId,
      card.identifier,
      fx.project.accessLevel,
      fx.ctx,
      'en',
    );
  }

  it('an OPEN linked pull request: the publish raises the design gate, and the result goes to the Development block', async () => {
    await connect(['motir-core']);
    const card = await designCard();
    await makeWorkWaitOn(card.id, fx);
    await link(card.id, 'motir-core', 41);

    expect((await publish(card.identifier)).isError).toBeFalsy();

    expect((await designGates(card.id)).map((g) => g.state)).toEqual(['awaiting']);
    const peek = await readPeek(card);
    expect(hasOpenPullRequest(peek.pullRequests, peek.deliveries)).toBe(true);
    expect(peek.designEvidence?.assets.map((a) => a.kind)).toEqual(['mock', 'note_file']);
  });

  it('TWO linked pull requests in two repositories, one open and one merged: the design gate too', async () => {
    await connect(['motir-core', 'motir-gateway']);
    const card = await designCard();
    await makeWorkWaitOn(card.id, fx);
    await link(card.id, 'motir-core', 42);
    const merged = await link(card.id, 'motir-gateway', 7);
    await adminDb.githubPullRequest.update({
      where: { id: merged.link.id },
      data: { state: 'closed', merged: true },
    });

    expect((await publish(card.identifier)).isError).toBeFalsy();

    expect((await designGates(card.id)).map((g) => g.state)).toEqual(['awaiting']);
    const peek = await readPeek(card);
    expect(peek.pullRequests.map((pr) => pr.state).sort()).toEqual(['merged', 'open']);
    expect(peek.designEvidence).not.toBeNull();
  });

  it('a pull request linked AFTER the publish LEAVES the awaiting design gate standing', async () => {
    await connect(['motir-core']);
    const card = await designCard();
    await makeWorkWaitOn(card.id, fx);
    expect((await publish(card.identifier)).isError).toBeFalsy();
    const [before] = await designGates(card.id);
    expect(before?.state).toBe('awaiting');

    await link(card.id, 'motir-core', 43);

    // A link is evidence the design gate is ABOUT, not an answer to it
    // (`retireDesignGateForOpenPullRequest` is retired outright, MOTIR-5662).
    const [after] = await designGates(card.id);
    expect(after?.state).toBe('awaiting');
  });

  it('with NO open delivery — none linked, or only a merged one — the publish raises one gate', async () => {
    await connect(['motir-core']);
    const bare = await designCard('Design — no pull request');
    await makeWorkWaitOn(bare.id, fx);
    const shipped = await designCard('Design — merged pull request');
    await makeWorkWaitOn(shipped.id, fx);
    const merged = await link(shipped.id, 'motir-core', 44);
    await adminDb.githubPullRequest.update({
      where: { id: merged.link.id },
      data: { state: 'closed', merged: true },
    });

    for (const card of [bare, shipped]) {
      expect((await publish(card.identifier)).isError).toBeFalsy();
      const gates = await designGates(card.id);
      expect(gates.map((g) => g.state)).toEqual(['awaiting']);
      const peek = await readPeek(card);
      expect(hasOpenPullRequest(peek.pullRequests, peek.deliveries)).toBe(false);
      expect(peek.designEvidence).toBeNull();
    }
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────
describe('`image` is refused through EVERY door that can carry it', () => {
  it('publish_design_result · create_design_upload · the HTTP register · the HTTP upload-token', async () => {
    const card = await designCard();
    await makeWorkWaitOn(card.id, fx);
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'ci',
      fixedGrant: grantForLegacyScopes(['integration']),
    });
    const post = (path: string, body: unknown) =>
      new Request(`http://localhost/api/work-items/${card.identifier}/design-evidence${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const params = { params: Promise.resolve({ id: card.identifier }) };
    const imagePath = `${designPrefix(fx.workspaceId, card.id)}p.png`;
    store.set(imagePath, { contentType: 'image/png', size: 64 });

    const IMAGE = {
      kind: 'image' as const,
      sourcePath: 'design/work-items/p.png',
      contentType: 'image/png',
    };

    const doors: Record<string, () => Promise<string>> = {
      publish_design_result: async () =>
        JSON.stringify(
          await runPublishDesignResult(
            {
              key: card.identifier,
              assets: [MOCK, { ...IMAGE, contentBase64: b64('png') }, NOTE],
            },
            fx.ctx,
          ),
        ),
      create_design_upload: async () =>
        JSON.stringify(
          await runCreateDesignUpload({ key: card.identifier, files: [IMAGE] }, fx.ctx),
        ),
      'POST /design-evidence': async () => {
        const res = await REGISTER(
          post('', {
            assets: [{ kind: 'image', sourcePath: IMAGE.sourcePath, pathname: imagePath }],
          }),
          params,
        );
        expect(res.status).toBe(422);
        return JSON.stringify(await res.json());
      },
      'POST /design-evidence/upload-token': async () => {
        const res = await MINT(post('/upload-token', { files: [IMAGE] }), params);
        expect(res.status).toBe(422);
        return JSON.stringify(await res.json());
      },
    };

    for (const [door, call] of Object.entries(doors)) {
      expect(await call(), door).toContain('DESIGN_EVIDENCE_IMAGE_RETIRED');
    }
    expect(await adminDb.designEvidence.count()).toBe(0);
  });
});
