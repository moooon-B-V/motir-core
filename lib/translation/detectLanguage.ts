import { franc } from 'franc-min';
import type { Locale } from '@/lib/i18n/locales';

// The local language detector (Story MOTIR-7735 · Subtask MOTIR-8115). It runs
// in-process and calls nothing, so deciding whether a field shows Translate
// never costs credit.
//
// It detects PROSE only: code, link targets, image URLs, `motir:` /
// `motir-ref:` chips and bare URLs are stripped first, because a Chinese
// paragraph quoting an English stack trace is Chinese.
//
// CJK is decided by SCRIPT before any statistics: short Chinese and Japanese
// titles are the common case here, and a trigram model needs far more text than
// a title has. Any kana is Japanese; hangul is Korean; Han without kana is
// Chinese. Latin-script text goes to `franc-min`, and only once it carries
// enough prose for a trigram model to mean anything.

/** ISO 639-3 codes `franc-min` answers → the eleven locales. Anything else is `null`. */
export const DETECTOR_CODE_TO_LOCALE: Readonly<Record<string, Locale>> = {
  eng: 'en',
  cmn: 'zh',
  jpn: 'ja',
  kor: 'ko',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  nld: 'nl',
  pol: 'pl',
  por: 'pt',
};

/** The least prose (letters, after stripping) a Latin-script guess is made on. */
export const MIN_LATIN_PROSE_LETTERS = 20;

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;
const LATIN_WORD = /\p{Script=Latin}{2,}/gu;
const LETTER = /\p{L}/gu;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** The prose of a Markdown field: everything a reader reads as language. */
export function proseOf(text: string): string {
  return (
    text
      // Fenced code blocks (``` and ~~~), then inline code.
      .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '\n')
      .replace(/`+[^`\n]*`+/g, ' ')
      // Work-item chips carry another card's title, not this field's prose.
      .replace(/!?\[[^\]\n]*\]\((?:motir|motir-ref):[^)\s]*\)/g, ' ')
      .replace(/\b(?:motir|motir-ref):[^\s)\]]+/g, ' ')
      // Images keep nothing; links keep their label, never their target.
      .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
      .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/^\s*\[[^\]\n]+\]:\s*\S+.*$/gm, ' ')
      // Bare URLs, autolinks, e-mail addresses and HTML tags.
      .replace(/<[^>\n]*>/g, ' ')
      .replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ')
      .replace(/\bwww\.\S+/gi, ' ')
      .replace(/\S+@\S+\.\S+/g, ' ')
      // Markdown punctuation.
      .replace(/[#*_>|~=+\-[\]()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The locale a field's prose is written in, or `null` when it cannot be told:
 * too little prose, nothing but code or URLs, or a language outside the eleven.
 */
export function detectLocale(text: string): Locale | null {
  const prose = proseOf(text);
  const han = count(prose, HAN);
  const kana = count(prose, KANA);
  const hangul = count(prose, HANGUL);
  const cjk = han + kana + hangul;
  // A CJK character carries about a word, so CJK wins when it is at least as
  // much of the text as the Latin words left around it.
  if (cjk >= 2 && cjk >= count(prose, LATIN_WORD)) {
    if (kana > 0) return 'ja';
    if (hangul >= han) return 'ko';
    return 'zh';
  }
  if (count(prose, LETTER) < MIN_LATIN_PROSE_LETTERS) return null;
  return DETECTOR_CODE_TO_LOCALE[franc(prose, { minLength: MIN_LATIN_PROSE_LETTERS })] ?? null;
}
