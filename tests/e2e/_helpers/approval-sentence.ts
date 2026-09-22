import type en from '@/messages/en.json';

// A To-approve / Approvals-room row's SENTENCE as a reader sees it (Story MOTIR-5996 ·
// MOTIR-5999; `design/workbench/design-notes.md` § 28, DECISION 1). The catalogue
// holds it as ONE ICU message with a `<title>` tag around the work item's title —
// *Design for <title>{name}</title>* — so a spec that asserts a row's text reads it
// from the catalogue here, never from a hand-typed string, and the two cannot drift.

type Sentences = typeof en.workbench.approvals.sentence;

/** The sentence a row with this kind and this work-item title reads as, tags removed. */
export function approvalSentence(
  messages: { workbench: { approvals: { sentence: Sentences } } },
  kind: keyof Sentences,
  title: string,
): string {
  return messages.workbench.approvals.sentence[kind]
    .replace(/<\/?title>/g, '')
    .replace('{name}', title);
}
