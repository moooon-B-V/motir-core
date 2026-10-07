import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Loads and validates a per-language glossary (`messages/glossary/<locale>.json`,
// the shape MOTIR-7744 pins) and renders it as translator instructions (Story
// MOTIR-7730 · MOTIR-7745).

export interface GlossaryTerm {
  translation: string;
  banned?: string[];
  allowedSenses?: string;
  doNotTranslate?: boolean;
  source?: string;
  note?: string;
}

export interface Glossary {
  locale: string;
  register: { formality?: string; quotes?: string; note?: string };
  terms: Record<string, GlossaryTerm>;
}

export class GlossaryShapeError extends Error {
  constructor(
    readonly file: string,
    readonly paths: string[],
  ) {
    super(`${file}: invalid glossary — ${paths.join('; ')}`);
    this.name = 'GlossaryShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate an already-parsed glossary. Throws ONE error naming every bad path. */
export function validateGlossary(raw: unknown, locale: string, file: string): Glossary {
  const bad: string[] = [];
  if (!isRecord(raw)) throw new GlossaryShapeError(file, ['(root): not an object']);
  if (raw['locale'] !== locale)
    bad.push(`locale: expected "${locale}", got ${JSON.stringify(raw['locale'])}`);
  if (!isRecord(raw['register'])) bad.push('register: missing or not an object');
  const terms = raw['terms'];
  if (!isRecord(terms) || Object.keys(terms).length === 0) {
    bad.push('terms: missing, not an object, or empty');
  } else {
    for (const [name, term] of Object.entries(terms)) {
      if (!isRecord(term)) {
        bad.push(`terms.${name}: not an object`);
        continue;
      }
      if (typeof term['translation'] !== 'string' || term['translation'].trim() === '') {
        bad.push(`terms.${name}.translation: missing or empty`);
      }
      const banned = term['banned'];
      if (
        banned !== undefined &&
        !(Array.isArray(banned) && banned.every((b) => typeof b === 'string'))
      ) {
        bad.push(`terms.${name}.banned: not a string array`);
      }
    }
  }
  if (bad.length) throw new GlossaryShapeError(file, bad);
  return raw as unknown as Glossary;
}

export function loadGlossary(locale: string, rootDir: string): Glossary {
  const file = join(rootDir, 'messages', 'glossary', `${locale}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new GlossaryShapeError(file, [`(file): ${(err as Error).message}`]);
  }
  return validateGlossary(raw, locale, file);
}

/** The terms that must survive VERBATIM wherever the English source names them. */
export function doNotTranslateTerms(glossary: Glossary): string[] {
  return Object.entries(glossary.terms)
    .filter(([, t]) => t.doNotTranslate)
    .map(([name]) => name);
}

/** Terms whose recorded translation IS the English term, spelled the same — kept
 *  Latin by decision (Sprint, a Latin "pull request"). Product names are covered
 *  by {@link doNotTranslateTerms}. */
export function keptLatinTerms(glossary: Glossary): string[] {
  return Object.entries(glossary.terms)
    .filter(([name, t]) => !t.doNotTranslate && t.translation === name)
    .map(([name]) => name);
}

export function renderInstructions(glossary: Glossary): string {
  const lines: string[] = [];
  lines.push(
    `Translate each "source" value from English into locale "${glossary.locale}" and put the result under "target" with the same key.`,
  );
  lines.push('');
  lines.push('REGISTER');
  if (glossary.register.formality) lines.push(`- Formality: ${glossary.register.formality}`);
  if (glossary.register.quotes) lines.push(`- Quotation marks: ${glossary.register.quotes}`);
  if (glossary.register.note) lines.push(`- ${glossary.register.note}`);
  lines.push('');
  lines.push('TERMS (English → translation) — use exactly these words');
  for (const [name, term] of Object.entries(glossary.terms)) {
    lines.push(
      `- ${name} → ${term.translation}${term.doNotTranslate ? ' (never translated)' : ''}`,
    );
  }
  const banned = Object.entries(glossary.terms).filter(([, t]) => t.banned?.length);
  if (banned.length) {
    lines.push('');
    lines.push('BANNED WORDS');
    for (const [name, term] of banned) {
      lines.push(
        `- For "${name}" never write: ${term.banned!.join(', ')}.${term.allowedSenses ? ` Allowed senses: ${term.allowedSenses}` : ''}`,
      );
    }
  }
  const dnt = doNotTranslateTerms(glossary);
  lines.push('');
  lines.push(`DO NOT TRANSLATE: ${[...dnt, ...keptLatinTerms(glossary)].join(', ')}`);
  lines.push('');
  lines.push('RULES');
  lines.push(
    '- Keep every {placeholder}, every #, every plural/select option key and every <tag>…</tag> exactly as in the source. Translate only the words.',
  );
  lines.push(
    `- Plural branches follow ${glossary.locale}'s own plural categories (always include "other"); select option keys stay exactly as in the source.`,
  );
  lines.push(
    '- The product noun is "work item", never the language\'s word for "issue" or "card".',
  );
  lines.push(
    '- For an entry listed under "previous", the English source changed since the old translation was made: revise the old translation so it says what the NEW English says.',
  );
  return lines.join('\n');
}
