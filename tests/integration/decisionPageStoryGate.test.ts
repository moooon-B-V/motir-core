import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DecisionDocOutcome } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { DecisionPagePublicationDto } from '@/lib/dto/decisionPage';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// STORY MOTIR-5761's VITEST GATE (MOTIR-7441) — an agent's decision is a PAGE, and the
// approved text never changes. Each card shipped its own suite over its own seam; this
// file holds what lives BETWEEN them, on real Postgres through the real doors:
//
//   publish (the MCP tool an agent calls) → gate → approve → freeze → done, with no
//   pull request anywhere; an edit after the publish never reaching the frozen text; a
//   republish after Request changes freezing only the second version; the page winning
//   the subject over a pull request's file while a file-only card behaves as before;
//   the cap and the delete guard leaving a frozen version alone; a human record frozen
//   by Confirm and not by Overturn; a save racing an approve, looped; and the dispatched
//   prompt on both sides of the decision.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { buildMcpServer } = await import('@/lib/mcp/registry');
const { CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { pageDecisionSubjectVersion } = await import('@/lib/approvalGates/decisionSubject');
const { loadDecisionIdentity } = await import('@/lib/approvalGates/decisionApprovalHandler');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { decisionPageService } = await import('@/lib/services/decisionPageService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { pagesService } = await import('@/lib/services/pagesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { decisionPagePublicationRepository } =
  await import('@/lib/repositories/decisionPagePublicationRepository');
const { toDecisionPagePublicationDto } = await import('@/lib/mappers/decisionPageMappers');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

const HUMAN_BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'PROD-1',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

async function create(extra: Record<string, unknown>) {
  seq += 1;
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Item ${seq}`, ...extra },
    fx.ctx,
  );
}

async function agentDecision(extra: Record<string, unknown> = {}) {
  const item = await create({ type: 'decision', executor: 'coding_agent', ...extra });
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: fx.ownerId } });
  return item;
}

async function page(markdown = '# Page model\n\nA tree of pages.', title = 'Page model') {
  return pagesService.createPageFromMarkdown(fx.ctx, { projectId: fx.projectId, title, markdown });
}

async function save(pageId: string, markdown: string) {
  const current = await pagesService.getPageMarkdown(fx.ctx, { projectId: fx.projectId, pageId });
  return pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: current.revision,
  });
}

/** Push the page's versions back an hour, so the next save opens a new version. */
async function age(pageId: string) {
  const back = new Date(Date.now() - 3_600_000);
  await adminDb.pageVersion.updateMany({
    where: { pageId },
    data: { startedAt: back, savedAt: back },
  });
}

/** Publish as an AGENT does: `publish_decision_page` through the MCP server. */
async function publishOverMcp(key: string, pageId: string): Promise<DecisionPagePublicationDto> {
  const server = buildMcpServer(
    () => fx.ctx,
    () => [...CLI_TOKEN_GRANT],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  const res = (await client.callTool({
    name: 'publish_decision_page',
    arguments: { key, pageId },
  })) as CallToolResult;
  await client.close();
  expect(res.isError ?? false).toBe(false);
  return res.structuredContent as unknown as DecisionPagePublicationDto;
}

const awaitingGate = (workItemId: string, kind = 'decision_approval' as const) =>
  adminDb.approvalGate.findFirstOrThrow({ where: { workItemId, kind, state: 'awaiting' } });

const decide = (gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      stamp: DECIDED_WITHOUT_A_READER,
      gateId,
      decision,
      source: 'ui',
      noteMd: decision === 'request_changes' ? 'Say more about the cap.' : null,
    },
    fx.ctx,
  );

const versionRow = (id: string) => adminDb.pageVersion.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** A pull request carrying ONE decision file, linked to the card. */
async function deliverFile(itemId: string) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-gate-${seq}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-gate-${seq}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 100 + seq,
      title: 'Decide',
      state: 'open',
      headRef: `docs/decide-${seq}`,
      baseRef: 'main',
      provider: 'github',
      decisionDocOutcome: 'one' as DecisionDocOutcome,
      decisionDocPath: 'docs/decisions/page-model.md',
      decisionDocBlobSha: 'blob-1',
      decisionDocHeadSha: 'head-1',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: itemId,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
}

// ─── the seam ─────────────────────────────────────────────────────────────────

describe('publish → gate → approve → freeze → done', () => {
  it('an agent publishes over the MCP, a person approves, the version is sealed then frozen and the card is done — no pull request anywhere', async () => {
    const item = await agentDecision();
    const p = await page();

    const publication = await publishOverMcp(item.identifier, p.id);
    expect((await versionRow(publication.versionId)).sealedAt).not.toBeNull();
    expect((await versionRow(publication.versionId)).frozenAt).toBeNull();
    const gate = await awaitingGate(item.id);
    expect(gate.subjectVersion).toBe(pageDecisionSubjectVersion(p.id, publication.versionId));
    expect(publication.gateId).toBe(gate.id);
    expect(['in_review', 'implemented']).toContain(await statusOf(item.id));

    const result = await decide(gate.id, 'approve');

    const frozen = await versionRow(publication.versionId);
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.frozenByGateId).toBe(gate.id);
    expect(result.effect.statusWritten).toBe('done');
    expect(await statusOf(item.id)).toBe('done');
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: item.id } })).toBe(0);
  });

  it('an edit after the publish (same author, inside the window) never reaches the frozen text', async () => {
    const item = await agentDecision();
    const p = await page('# Page model\n\nThe published text.');
    const publication = await decisionPageService.publish(
      { workItemId: item.id, pageId: p.id },
      fx.ctx,
    );
    await save(p.id, '# Page model\n\nAn edit after the publish.');

    await decide((await awaitingGate(item.id)).id, 'approve');

    const frozen = await versionRow(publication.versionId);
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.bodyMarkdown).toContain('The published text.');
    expect(frozen.bodyMarkdown).not.toContain('An edit after the publish.');
    const later = await adminDb.pageVersion.findMany({
      where: { pageId: p.id, number: { gt: frozen.number } },
    });
    expect(later.map((v) => v.bodyMarkdown).join()).toContain('An edit after the publish.');
  });

  it('Request changes, republish, approve: only the SECOND version is frozen; the first stays sealed', async () => {
    const item = await agentDecision();
    const p = await page();
    const first = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);
    await decide((await awaitingGate(item.id)).id, 'request_changes');
    await save(p.id, '# Page model\n\nA tree of pages, with a cap of 100 versions.');
    const second = await decisionPageService.publish({ workItemId: item.id, pageId: p.id }, fx.ctx);

    await decide((await awaitingGate(item.id)).id, 'approve');

    const one = await versionRow(first.versionId);
    const two = await versionRow(second.versionId);
    expect(one.sealedAt).not.toBeNull();
    expect(one.frozenAt).toBeNull();
    expect(two.frozenAt).not.toBeNull();
    expect(await statusOf(item.id)).toBe('done');
  });
});

describe('the subject — page over file, file alone unchanged', () => {
  it('a card with a captured pull-request file AND a publication resolves to the page', async () => {
    const item = await agentDecision();
    await deliverFile(item.id);
    const p = await page();
    const publication = await decisionPageService.publish(
      { workItemId: item.id, pageId: p.id },
      fx.ctx,
    );
    const identity = await withWorkspaceContext(fx.ctx, (tx) => loadDecisionIdentity(item.id, tx));
    expect(identity).toMatchObject({ source: 'page', versionId: publication.versionId });
  });

  it('a card with only the file asks about the file, as MOTIR-4907 shipped', async () => {
    const item = await agentDecision();
    await deliverFile(item.id);
    const identity = await withWorkspaceContext(fx.ctx, (tx) => loadDecisionIdentity(item.id, tx));
    expect(identity).toMatchObject({ resolvable: true });
    expect(identity).not.toMatchObject({ source: 'page' });
  });
});

describe('a frozen version outlives the cap and the delete', () => {
  it('105 saves later the frozen version is still there, and the page cannot be deleted', async () => {
    const item = await agentDecision();
    const p = await page('# Kept\n\nThe approved text.');
    const publication = await decisionPageService.publish(
      { workItemId: item.id, pageId: p.id },
      fx.ctx,
    );
    await decide((await awaitingGate(item.id)).id, 'approve');

    for (let n = 0; n < 105; n += 1) {
      await age(p.id);
      await save(p.id, `# Kept\n\nEdit ${n}.`);
    }

    const frozen = await versionRow(publication.versionId);
    expect(frozen.bodyMarkdown).toContain('The approved text.');
    expect(await adminDb.pageVersion.count({ where: { pageId: p.id } })).toBeLessThanOrEqual(101);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    await expect(
      pagesService.deletePage(fx.ctx, { projectId: fx.projectId, pageId: p.id }),
    ).rejects.toMatchObject({ code: 'PAGE_HOLDS_FROZEN_VERSION' });
    expect(await adminDb.page.count({ where: { id: p.id } })).toBe(1);
  }, 120_000);
});

describe('a human decision with a page record', () => {
  async function human() {
    const item = await create({ type: 'decision', executor: 'human', descriptionMd: HUMAN_BODY });
    const p = await page('# Exports\n\nThe long form.', 'Exports direction');
    const publication = await decisionPageService.publish(
      { workItemId: item.id, pageId: p.id },
      fx.ctx,
    );
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'decision_confirmation' },
      fx.ctx,
    );
    return { item, publication, gateId: read.gate!.id, stamp: read.stamp! };
  }

  it('Confirm freezes the version', async () => {
    const { publication, gateId, stamp } = await human();
    await approvalGatesService.decide({ gateId, decision: 'approve', source: 'ui', stamp }, fx.ctx);
    expect((await versionRow(publication.versionId)).frozenByGateId).toBe(gateId);
  });

  it('Overturn does not', async () => {
    const { publication, gateId, stamp } = await human();
    await approvalGatesService.decide(
      { gateId, decision: 'overturn', source: 'ui', stamp, noteMd: 'Not what we discussed.' },
      fx.ctx,
    );
    const version = await versionRow(publication.versionId);
    expect(version.sealedAt).not.toBeNull();
    expect(version.frozenAt).toBeNull();
  });
});

describe('a save racing an approve', () => {
  it('never extends the frozen version, whichever lands first (50 rounds)', async () => {
    for (let round = 0; round < 50; round += 1) {
      const item = await agentDecision();
      const p = await page(`# Round ${round}\n\napproved text`);
      const publication = await decisionPageService.publish(
        { workItemId: item.id, pageId: p.id },
        fx.ctx,
      );
      const gate = await awaitingGate(item.id);
      const current = await pagesService.getPageMarkdown(fx.ctx, {
        projectId: fx.projectId,
        pageId: p.id,
      });

      await Promise.all([
        decide(gate.id, 'approve'),
        pagesService
          .savePageMarkdown(fx.ctx, {
            projectId: fx.projectId,
            pageId: p.id,
            markdown: `# Round ${round}\n\nracing edit`,
            expectedRevision: current.revision,
          })
          .catch(() => null),
      ]);

      // Sealed at the publish, the version can only be frozen as published: the racing
      // edit starts the next version whichever order the two took.
      const frozen = await versionRow(publication.versionId);
      expect(frozen.frozenAt).not.toBeNull();
      expect(frozen.bodyMarkdown).toContain('approved text');
      expect(frozen.bodyMarkdown).not.toContain('racing edit');
    }
  }, 240_000);
});

describe('the dispatched prompt', () => {
  it('a decision card is told to publish a page, with no pull request; a card under its epic cites the frozen version', async () => {
    const epic = await create({ kind: 'epic', title: 'Pages' });
    const card = await agentDecision({ parentId: epic.id, title: 'Pick the store' });

    const decisionPrompt = (
      await dispatchPromptService.getDispatchPrompt(fx.projectId, card.identifier, fx.ctx)
    ).prompt;
    expect(decisionPrompt).toContain('publish_decision_page');
    expect(decisionPrompt).not.toMatch(/GIT WORKFLOW/);

    const p = await page('# Pick the store\n\nYjs.', 'Pick the store');
    const publication = await decisionPageService.publish(
      { workItemId: card.id, pageId: p.id },
      fx.ctx,
    );
    await decide((await awaitingGate(card.id)).id, 'approve');
    await save(p.id, '# Pick the store\n\nEdited after approval.');
    const work = await create({
      parentId: epic.id,
      title: 'Build it',
      type: 'code',
      executor: 'coding_agent',
    });

    const workPrompt = (
      await dispatchPromptService.getDispatchPrompt(fx.projectId, work.identifier, fx.ctx)
    ).prompt;
    expect(workPrompt).toContain(
      `get_page { projectKey: "PROD", pageId: "${p.id}", version: ${publication.versionNumber} }`,
    );
    expect(workPrompt).not.toContain('Edited after approval.');
  });
});

describe('the edges a reader meets', () => {
  it('an untitled page publishes over the MCP and is named Untitled in the result', async () => {
    const item = await agentDecision();
    const p = await page('# Body\n\nText.', '');
    const server = buildMcpServer(
      () => fx.ctx,
      () => [...CLI_TOKEN_GRANT],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'story-gate', version: '0.0.0' });
    await client.connect(clientTransport);
    const call = () =>
      client.callTool({
        name: 'publish_decision_page',
        arguments: { key: item.identifier, pageId: p.id },
      }) as Promise<CallToolResult>;
    const textOf = (res: CallToolResult) =>
      (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(textOf(await call())).toContain('of "Untitled"');
    // The replay says so, and names the page the same way.
    expect(textOf(await call())).toMatch(/already version 1 of "Untitled".*nothing changed/);
    await client.close();
  });

  it('a publisher the name read missed is an empty name, never undefined', () => {
    const at = new Date('2026-10-03T00:00:00.000Z');
    const dto = toDecisionPagePublicationDto(
      {
        id: 'pub',
        workItemId: 'wi',
        pageId: 'pg',
        pageVersionId: 'pv',
        publishedById: 'usr',
        publishedAt: at,
      },
      {
        workItemKey: 'PROD-1',
        pageTitle: 'T',
        versionNumber: 1,
        sealedAt: at,
        publishedByName: undefined,
        gateId: null,
        replayed: false,
      },
    );
    expect(dto.publishedByName).toBe('');
  });

  it('the batched reads answer nothing for nothing, without a query', async () => {
    await withWorkspaceContext(fx.ctx, async (tx) => {
      expect(await decisionPagePublicationRepository.latestForWorkItems([], tx)).toEqual([]);
      expect(await decisionPagePublicationRepository.decisionTagsForVersions([], tx)).toEqual([]);
    });
  });
});
