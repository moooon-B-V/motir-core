'use client';

import type { MouseEvent, ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';

// "Back to start" on the how-it-works page (MOTIR-8253) — design-notes.md
// § "Revision 1 (2026-10-12)", "What changed" item 3, marked `data-closes-tab`
// in the mock. The entrance opens this page in a NEW TAB, so going "back" means
// closing this tab: the person returns to the entrance tab with their typed idea
// intact (a tab opened by a `target="_blank"` link is script-closable).
//
// Where the tab CANNOT be closed — a direct visit, a reload that grew the
// history, a browser that refuses — it navigates to its `href` (the entrance).
// The `href` is a real link, so it also works without script; the page always
// stays leavable. `window.close()` gives no result, so whether it worked is read
// from `window.closed` after the call.
//
// A plain `<a>`, not `next/link`: the fallback is a full navigation to a
// different route group entry, and a client-side transition would only race the
// close.

export interface BackToStartLinkProps {
  href: string;
  children: ReactNode;
}

export function BackToStartLink({ href, children }: BackToStartLinkProps) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // A modified click (new tab / window) is the person's own instruction.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.close();
    if (!window.closed) window.location.assign(href);
  }

  return (
    <a
      href={href}
      data-closes-tab=""
      onClick={onClick}
      className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline')}
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      <span>{children}</span>
    </a>
  );
}
