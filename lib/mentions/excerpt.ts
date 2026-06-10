// Mention-aware plain-text excerpt (Story 5.1 · Subtask 5.1.6). The mention
// notification email shows a short PLAIN-TEXT excerpt of the body that
// mentioned the recipient — Markdown stripped, and every mention token
// rendered as `@Name`, never the raw `[@Name](mention:<id>)` markup.
//
// The Markdown stripping is delegated to `lib/markdown/excerpt.ts` (the 7.0.3
// helper the ready-surface rows already use — same lightweight regex strip,
// deliberately NOT the full render pipeline). The one mention-specific step is
// the explicit token pre-pass: the generic link rule would also reduce the
// token to its text, but the pre-pass makes the `@Name` contract independent
// of that incidental overlap (and self-documenting at the mentions seam).

import { MENTION_TOKEN_RE } from './parse';
import { markdownToExcerpt } from '@/lib/markdown/excerpt';

/** The email excerpt budget — shorter than a list row's 200 (it sits above a CTA). */
const MENTION_EXCERPT_MAX_CHARS = 160;

/**
 * Build the notification excerpt for a Markdown body: mention tokens become
 * plain `@Name`, the rest of the Markdown is stripped, whitespace collapses,
 * and the result truncates on a word boundary. Returns `null` for an empty
 * (post-strip) body — the template omits the excerpt block entirely.
 */
export function mentionExcerpt(
  bodyMd: string | null | undefined,
  maxChars: number = MENTION_EXCERPT_MAX_CHARS,
): string | null {
  if (!bodyMd) return null;
  const withPlainMentions = bodyMd.replace(MENTION_TOKEN_RE, '@$1');
  return markdownToExcerpt(withPlainMentions, maxChars);
}
