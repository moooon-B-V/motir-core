// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import type { ReadinessVerdictDto, RelationshipLinkDto, WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The motir-core STORY GATE for HARD and SOFT blocks (Story MOTIR-6354 ·
// MOTIR-6364) — the BANNER half. `readiness-badge-soft.test.tsx` (MOTIR-6377)
// proves the badge against hand-written verdicts; this renders the detail
// page's `RelationshipsPanel` — the same prop mapping the page does — from the
// payload the REAL `get_work_item` returns over real Postgres, so a drift in the
// verdict's field names (`openBlockers` / `blockedByAncestor`) fails here.
//
// The only stubs are App-Router plumbing the panel's client islands import
// (`next/navigation`, and the detail page's Server Actions, never invoked by a
// read-only render) — nothing on the readiness side.

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  createLinkAction: vi.fn(),
  removeLinkAction: vi.fn(),
  listLinkCandidatesAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/PROD-1',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RelationshipsPanel } from '@/app/(authed)/items/[key]/_components/RelationshipsPanel';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(cleanup);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function make(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'subtask',
  title: string,
  parentId?: string,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

interface Payload {
  item: { status: string };
  readiness: ReadinessVerdictDto;
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  workflow: WorkflowDto;
}

async function renderBannerFor(fx: WorkItemFixture, key: string): Promise<HTMLElement> {
  const result: CallToolResult = await runGetWorkItem({ key }, fx.ctx);
  expect(result.isError).not.toBe(true);
  const p = result.structuredContent as unknown as Payload;
  const { container } = render(
    <RelationshipsPanel
      blockedBy={p.blockedBy}
      blocks={p.blocks}
      relatesTo={p.relatesTo}
      duplicates={p.duplicates}
      clones={p.clones}
      readiness={p.readiness}
      currentStatus={p.item.status}
      workflow={p.workflow}
    />,
  );
  const banner = container.querySelector('[data-readiness]');
  expect(banner).not.toBeNull();
  return banner as HTMLElement;
}

describe('SEAM — the banner reads the REAL get_work_item verdict', () => {
  it('S1 (held only by E) renders the SOFT banner naming E; S2 (own open blocker) renders the HARD one', async () => {
    const fx = await makeWorkItemFixture();
    const openEpic = await make(fx, 'epic', 'The unfinished epic');
    const epic = await make(fx, 'epic', 'The blocked epic');
    await block(fx, epic.id, openEpic.id);
    const story = await make(fx, 'story', 'The story under E', epic.id);
    const s1 = await make(fx, 'subtask', 'Soft only', story.id);
    const s2 = await make(fx, 'subtask', 'Own blocker', story.id);
    // Under the unfinished epic, so X sits at S2's depth (MOTIR-6411).
    const otherStory = await make(fx, 'story', 'Another story', openEpic.id);
    const x = await make(fx, 'subtask', 'The other story’s open subtask', otherStory.id);
    await block(fx, s2.id, x.id);

    const soft = await renderBannerFor(fx, s1.identifier);
    expect(soft.getAttribute('data-readiness')).toBe('soft');
    expect(soft.className).toContain('bg-(--el-tint-yellow)');
    screen.getByText('Parent blocked');
    expect(screen.getByRole('link', { name: epic.identifier }).getAttribute('href')).toBe(
      `/items/${epic.identifier}`,
    );
    cleanup();

    const hard = await renderBannerFor(fx, s2.identifier);
    expect(hard.getAttribute('data-readiness')).toBe('hard');
    expect(hard.className).toContain('bg-(--el-tint-peach)');
    screen.getByText('Blocked');
    expect(screen.queryByText('Parent blocked')).toBeNull();
    // HARD wins: the own blocker is named, the ancestor is not.
    const named = Array.from(hard.querySelectorAll('a')).map((a) => a.textContent);
    expect(named).toEqual([x.identifier]);
  });
});
