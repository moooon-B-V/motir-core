import type { JSONContent } from '@tiptap/core';
import type { DerivedPageLink } from '../store';

// The links a page body NAMES (Story MOTIR-5747 · MOTIR-7570), the rows
// `docs/decisions/pages.md` §8.1 derives on every body write. Read from the
// ProseMirror JSON the same write just derived — never from the markdown or
// the text — so the rows and the stored body cannot disagree.

/**
 * One link per distinct `(workItemId, source)` the body names, in document
 * order. Today the only producer is the `workItemMention` node (`mention`); a
 * body with none returns `[]`.
 */
export function extractLinks(json: JSONContent): DerivedPageLink[] {
  const links: DerivedPageLink[] = [];
  const seen = new Set<string>();
  const visit = (node: JSONContent): void => {
    if (node.type === 'workItemMention') {
      const id = node.attrs?.id;
      if (typeof id === 'string' && id.length > 0 && !seen.has(`mention:${id}`)) {
        seen.add(`mention:${id}`);
        links.push({ workItemId: id, source: 'mention' });
      }
    }
    node.content?.forEach(visit);
  };
  visit(json);
  return links;
}
