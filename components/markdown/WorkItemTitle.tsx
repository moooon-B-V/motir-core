'use client';

import { Fragment, type ReactNode } from 'react';
import { RelationshipPeekLink } from '@/app/(authed)/items/[key]/_components/RelationshipPeekLink';
import { buildWorkItemKeyRe } from '@/lib/mentions/workItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// Title-linkify (Story 5.8 · Subtask 5.8.6), per
// design/work-items/internal-links.mock.html panel 4. A work-item TITLE is a
// plain-text input (no editor, so no `@` picker), so a reference there is a BARE
// `MOTIR-N` key the author typed. On display — the detail header H1 and the
// quick-view peek header — that bare key linkifies: a live target's key reads in
// the link colour + mono and opens the quick-view PEEK on click (reusing
// `RelationshipPeekLink`, the same glance the body chip + relationship rows use);
// a deleted / inaccessible key degrades gracefully to plain text (never a broken
// link). Only THIS project's prefix matches (cross-project bare keys stay text),
// mirroring `parseWorkItemKeys`.
//
// Tokens: `.title-link` styling is element-semantic — link colour via --el-link,
// mono + 0.86em so the key doesn't fight the heading weight (the design spec).

export function WorkItemTitle({
  title,
  projectIdentifier,
  workItemRefs,
}: {
  title: string;
  /** This project's identifier prefix (e.g. `MOTIR`) — the bare-key match scope. */
  projectIdentifier: string;
  workItemRefs?: WorkItemRefMap;
}) {
  const refs = workItemRefs ?? {};
  const re = buildWorkItemKeyRe(projectIdentifier);
  const prefix = projectIdentifier.toUpperCase();

  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of title.matchAll(re)) {
    const start = match.index ?? 0;
    const key = `${prefix}-${match[1] as string}`;
    const summary = refs[key];
    if (start > last) parts.push(<Fragment key={`t${i}`}>{title.slice(last, start)}</Fragment>);
    // Linkify only a live / archived (accessible) target — a deleted /
    // inaccessible key stays plain text (graceful degradation, no broken link).
    if (summary && summary.accessible) {
      parts.push(
        <RelationshipPeekLink
          key={`k${i}`}
          identifier={summary.identifier}
          className="font-mono text-[0.86em] text-(--el-link) hover:underline"
        >
          {match[0]}
        </RelationshipPeekLink>,
      );
    } else {
      parts.push(<Fragment key={`k${i}`}>{match[0]}</Fragment>);
    }
    last = start + match[0].length;
    i += 1;
  }
  if (last < title.length) parts.push(<Fragment key="tail">{title.slice(last)}</Fragment>);

  // No bare key matched → the title is rendered verbatim (single text node).
  return <>{parts.length > 0 ? parts : title}</>;
}
