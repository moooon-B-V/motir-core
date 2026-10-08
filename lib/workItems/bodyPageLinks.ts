import type { Prisma } from '@/generated/prisma/client';
import { parsePageTokenIds } from '@/lib/mentions/pageRefs';
import { diffItemDerivedLinks, type ItemDerivedPageLink } from '@/lib/pages/derivedLinks';
import { pageRepository } from '@/lib/repositories/pageRepository';
import {
  pageWorkItemLinkRepository,
  type ItemDerivedPageLinkSourceValue,
} from '@/lib/repositories/pageWorkItemLinkRepository';

// The work item's page tags → `page_work_item_link` rows (Story MOTIR-7694 ·
// MOTIR-7696, `docs/decisions/pages.md` §8.1). A `[<title>](motir-page:<id>)`
// token in the Description derives a `description` row, one in the Explanation
// an `explanation` row — rewritten as a DIFF on every create and update that
// carries either body, inside that save's transaction, so the tag and its row
// commit or roll back together. It is the mirror of the page save's
// `replaceDerivedLinks` (`lib/pages/pageStoreAdapter.ts`), keyed on the work
// item instead of the page.
//
// Composed here, beside `normalizeBodyRefs`, because `workItemsService` is the
// one writer every door shares (the web form, REST and MCP), and the rule —
// which ids count, which source each field owns — is the same for all of them.
//
// ⚠️ ONLY THE SUPPLIED FIELDS ARE DIFFED. A save that carries only the
// Explanation leaves every `description` row as it is: an omitted field is not
// an empty one.
//
// ⚠️ A page-derived (`mention` / `embed`) or `manual` row is never read or
// written here — the repository's item-derived methods name only their own two
// sources.

/** The bodies a save carries — `undefined` means the field was not supplied. */
export interface BodyPageLinkFields {
  descriptionMd?: string | null;
  explanationMd?: string | null;
}

/** The work item the rows belong to. */
export interface BodyPageLinkItem {
  id: string;
  workspaceId: string;
  projectId: string;
}

/** What a sync changed — the counts, for the caller's tests and logs. */
export interface BodyPageLinkSyncResult {
  deleted: number;
  inserted: number;
}

const NOTHING: BodyPageLinkSyncResult = { deleted: 0, inserted: 0 };

/**
 * Bring the item's `description` / `explanation` link rows in step with the
 * `motir-page:` tokens in the supplied bodies. Only ids that name a page of the
 * item's own project are kept — archived pages included (a restore brings the
 * link back), a foreign or unknown id skipped silently rather than failing the
 * save on the same-project trigger. A kept row keeps its first creator.
 */
export async function syncBodyPageLinks(
  item: BodyPageLinkItem,
  fields: BodyPageLinkFields,
  actorId: string,
  tx: Prisma.TransactionClient,
): Promise<BodyPageLinkSyncResult> {
  const sources = new Set<ItemDerivedPageLinkSourceValue>();
  const named: ItemDerivedPageLink[] = [];
  if (fields.descriptionMd !== undefined) {
    sources.add('description');
    for (const pageId of parsePageTokenIds(fields.descriptionMd)) {
      named.push({ pageId, source: 'description' });
    }
  }
  if (fields.explanationMd !== undefined) {
    sources.add('explanation');
    for (const pageId of parsePageTokenIds(fields.explanationMd)) {
      named.push({ pageId, source: 'explanation' });
    }
  }
  if (sources.size === 0) return NOTHING;

  const stored = await pageWorkItemLinkRepository.findItemDerivedByWorkItem(item.id, tx);
  // A body with no tag and no stored row — the overwhelming majority of saves —
  // costs one indexed read and nothing else.
  if (named.length === 0 && stored.length === 0) return NOTHING;

  const inProject = new Set(
    await pageRepository.findIdsInProject(
      [...new Set(named.map((link) => link.pageId))],
      item.projectId,
      tx,
    ),
  );
  const diff = diffItemDerivedLinks(
    stored,
    named.filter((link) => inProject.has(link.pageId)),
    sources,
  );
  const deleted = await pageWorkItemLinkRepository.deleteItemDerivedByIds(
    item.id,
    diff.deleteIds,
    tx,
  );
  const inserted = await pageWorkItemLinkRepository.createDerived(
    diff.insert.map((link) => ({
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      pageId: link.pageId,
      workItemId: item.id,
      source: link.source,
      createdById: actorId,
    })),
    tx,
  );
  return { deleted, inserted };
}
