import { createHash } from 'node:crypto';

// THE ONE READER OF A CHOICE'S BODY (Story MOTIR-4914 · Subtask MOTIR-5891; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5887 amendment, points 1–2).
//
// A `type: choice` work item keeps its options in its own `descriptionMd`, in a
// canonical structure the planner's `type-choice` pack teaches and the port
// renders:
//
//   ## Question
//   ## Why this is a choice
//   **Situation:** <contradicts your decision · better than your decision · two workflows>
//   **You said:** <quoted — the first two situations only>
//   <evidence prose>
//   ## Options
//   ### <label>
//   **Best if you want:** <what it is best for>
//   <its WHY>
//   ## What this choice gates
//   <the follow-up work>
//
// This module turns that text into the gate's SUBJECT — or into the closed set of
// reasons it cannot be one. A body that does not parse raises NO gate (point 2),
// so the defect list is what the item page renders instead of a frame.
//
// ⚠️ PURE. No database, no clock, no randomness: the same body always yields the
// same answer and the same `subjectVersion`, which is what makes the version a
// STAMP a stale press can be refused against (MOTIR-5232).

/** The three situations `kind-container.md`'s choice rule names, and nothing else. */
export const CHOICE_SITUATIONS = [
  'contradicts_your_decision',
  'better_than_your_decision',
  'two_workflows',
] as const;
export type ChoiceSituation = (typeof CHOICE_SITUATIONS)[number];

/**
 * The situations that DEBATE a decision the person already made, and so must
 * quote it on a `**You said:**` line (point 1's table). The third resolves a fork
 * in their requirement and has nothing of theirs to quote.
 */
const DEBATES_A_DECISION: ReadonlySet<ChoiceSituation> = new Set([
  'contradicts_your_decision',
  'better_than_your_decision',
]);

/** A defect is ONE of these — the closed set point 2 fixes. */
export type ChoiceDefect =
  | { reason: 'fewer_than_two_options' }
  | { reason: 'option_without_best_for'; label: string }
  | { reason: 'duplicate_option'; label: string }
  | { reason: 'no_follow_up_section' }
  | { reason: 'no_why_section' }
  | { reason: 'unknown_situation'; value: string }
  | { reason: 'no_quoted_decision' };

export type ChoiceDefectReason = ChoiceDefect['reason'];

export interface ChoiceOption {
  /** The kebab slug of the label — what the verb, the stored pick and `outcomeRef` name. */
  id: string;
  label: string;
  /** The `**Best if you want:**` value — the one thing this option does better. */
  bestFor: string;
  /** The option's WHY, as authored Markdown. */
  whyMd: string;
}

export interface ChoiceWhy {
  situation: ChoiceSituation;
  /** The person's own decision, quoted — null for `two_workflows`. */
  youSaid: string | null;
  /** The evidence prose: what research found, or where the requirement forks. */
  evidenceMd: string;
}

export interface ParsedChoice {
  ok: true;
  question: string;
  why: ChoiceWhy;
  options: ChoiceOption[];
  followUpMd: string;
  /** A hash of the Why, Options and follow-up sections — the gate's stamp. */
  subjectVersion: string;
}

export interface DefectiveChoice {
  ok: false;
  /** Every defect found, in a stable order; the first is the one to headline. */
  defects: ChoiceDefect[];
}

export type ChoiceParse = ParsedChoice | DefectiveChoice;

const SECTION = {
  question: 'question',
  why: 'why this is a choice',
  options: 'options',
  gates: 'what this choice gates',
} as const;

const SITUATION_BY_WORDS: Record<string, ChoiceSituation> = {
  'contradicts your decision': 'contradicts_your_decision',
  'better than your decision': 'better_than_your_decision',
  'two workflows': 'two_workflows',
};

/** Normalise line endings and trailing whitespace, so a CRLF body hashes like an LF one. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** Split at headings of exactly `level` hashes; the text before the first is dropped. */
function sectionsAt(text: string, level: 2 | 3): Array<{ heading: string; body: string }> {
  const marker = level === 2 ? /^##(?!#)\s*(.*)$/ : /^###(?!#)\s*(.*)$/;
  const out: Array<{ heading: string; body: string[] }> = [];
  for (const line of text.split('\n')) {
    const match = marker.exec(line);
    const current = out[out.length - 1];
    if (match) out.push({ heading: (match[1] ?? '').trim(), body: [] });
    else if (current) current.body.push(line);
  }
  return out.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/** `**Key:** value` on its own line — the value, and the body with that line removed. */
function takeKeyLine(body: string, key: string): { value: string | null; rest: string } {
  const pattern = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.*)$`, 'i');
  const lines = body.split('\n');
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  const match = index === -1 ? null : pattern.exec((lines[index] ?? '').trim());
  if (!match) return { value: null, rest: body };
  const value = (match[1] ?? '').trim();
  lines.splice(index, 1);
  return { value, rest: lines.join('\n').trim() };
}

/** The option id: the label's kebab slug, keeping letters of any script. */
export function choiceOptionId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function stripQuotes(value: string): string {
  return value.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
}

/**
 * Parse a choice work item's `descriptionMd` into its subject, or into the
 * reasons it cannot be one.
 */
export function parseChoiceOptions(descriptionMd: string | null | undefined): ChoiceParse {
  const text = normalise(descriptionMd ?? '');
  const byHeading = new Map<string, string>();
  for (const { heading, body } of sectionsAt(text, 2)) {
    const key = heading.toLowerCase();
    if (!byHeading.has(key)) byHeading.set(key, body);
  }

  const defects: ChoiceDefect[] = [];

  // ── Why this is a choice ──
  let why: ChoiceWhy | null = null;
  const whyBody = byHeading.get(SECTION.why);
  const situationLine = whyBody === undefined ? null : takeKeyLine(whyBody, 'Situation');
  if (whyBody === undefined || situationLine === null || situationLine.value === null) {
    defects.push({ reason: 'no_why_section' });
  } else {
    const words = situationLine.value.toLowerCase().replace(/\s+/g, ' ').trim();
    const situation =
      SITUATION_BY_WORDS[words] ??
      (CHOICE_SITUATIONS as readonly string[]).find((id) => id === words.replace(/ /g, '_'));
    if (situation === undefined) {
      defects.push({ reason: 'unknown_situation', value: situationLine.value });
    } else {
      const said = takeKeyLine(situationLine.rest, 'You said');
      const youSaid = said.value === null ? null : stripQuotes(said.value) || null;
      const debates = DEBATES_A_DECISION.has(situation as ChoiceSituation);
      if (debates && youSaid === null) defects.push({ reason: 'no_quoted_decision' });
      why = {
        situation: situation as ChoiceSituation,
        youSaid: debates ? youSaid : null,
        evidenceMd: said.rest,
      };
    }
  }

  // ── Options ──
  const options: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const { heading, body } of sectionsAt(byHeading.get(SECTION.options) ?? '', 3)) {
    const label = heading;
    if (label === '') continue;
    const bestFor = takeKeyLine(body, 'Best if you want');
    const id = choiceOptionId(label);
    if (seen.has(id)) {
      defects.push({ reason: 'duplicate_option', label });
      continue;
    }
    seen.add(id);
    if (bestFor.value === null || bestFor.value === '') {
      defects.push({ reason: 'option_without_best_for', label });
    }
    options.push({ id, label, bestFor: bestFor.value ?? '', whyMd: bestFor.rest });
  }
  if (options.length < 2) defects.unshift({ reason: 'fewer_than_two_options' });

  // ── What this choice gates ──
  const followUpMd = byHeading.get(SECTION.gates) ?? '';
  if (followUpMd === '') defects.push({ reason: 'no_follow_up_section' });

  if (defects.length > 0 || why === null) return { ok: false, defects };

  return {
    ok: true,
    question: byHeading.get(SECTION.question) ?? '',
    why,
    options,
    followUpMd,
    subjectVersion: choiceSubjectVersion(
      byHeading.get(SECTION.why) ?? '',
      byHeading.get(SECTION.options) ?? '',
      followUpMd,
    ),
  };
}

/**
 * The stamp: a hash of the three sections a decision is made over. The question's
 * wording and anything outside the sections do not move it, so a typo fix does
 * not retire a pending decision; a change to the options, to why they are being
 * asked, or to what they gate does.
 */
function choiceSubjectVersion(whyMd: string, optionsMd: string, followUpMd: string): string {
  return createHash('sha256')
    .update(['why', whyMd, 'options', optionsMd, 'gates', followUpMd].join('\u0000'))
    .digest('hex');
}
