'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { usePeekOpen } from '../../_components/IssueQuickView';

// A relationships-panel row link (8.8.31). It keeps the real anchor to the
// linked item's detail page — so the href stays shareable/accessible and
// ⌘/ctrl/middle-click still opens it in a new tab natively — but intercepts a
// PLAIN primary click (and keyboard Enter, which fires an unmodified click on an
// anchor) to open the linked item in the SHARED quick-view PEEK modal instead of
// navigating away from the item the user is reading. The peek is `?peek=<id>`-
// driven (usePeekOpen, shallow-routed); the IssueQuickViewController mounted on
// the detail/edit pages renders it. RemoveLinkButton stays a SIBLING outside this
// anchor (an interactive control can't nest in an anchor — listbox-row-actions
// a11y), so this component only owns the navigable link.
export function RelationshipPeekLink({
  identifier,
  className,
  children,
}: {
  identifier: string;
  className?: string;
  children: ReactNode;
}) {
  const openPeek = usePeekOpen();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modifier / secondary clicks natively (open in a new
    // tab/window); only an unmodified primary click opens the peek.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openPeek(identifier);
  };
  return (
    <Link href={`/items/${identifier}`} onClick={onClick} className={className}>
      {children}
    </Link>
  );
}
