// ════════════════════════════════════════════════════════════════════════════
// ENUMERATE EVERY `submitJob(` CALL SITE IN `lib/` — the shared source-walker
// behind the planning-envelope call-site guards (MOTIR-4343, MOTIR-4736).
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠️ WHY A WALKER AND NOT `tests/helpers/stripSourceComments.ts`. That module is
// this tree's CHEAP comment stripper and says so in its own header: it is two
// regexes, it cannot survive a `/*` inside a string literal, and — decisively for
// this use — it CHANGES THE LENGTH of the source. The scan below finds a call's
// arguments by balancing brackets from a byte offset, so every offset has to
// survive the strip. This walker therefore replaces each comment byte with a
// SPACE rather than deleting it, and tracks string and regex literals so the
// balance stays honest.
//
// ⚠️ AND WHY IT CANNOT BE A `grep`. Every planning call site in this repository
// is wrapped in a long comment explaining the envelope fields — including, at
// several of them, the constants' own names — so a pattern searching the raw call
// text finds the token in the PROSE and passes a site that sends nothing.
//
// ⚠️ AND WHY IT TRACKS REGEX LITERALS, which looks like over-engineering until
// you run it: `lib/` really does contain `/<a\s+[^>]*href=["']([^"']+)["']…/gi`
// (`lib/email.ts`) and backtick-bearing patterns in `lib/markdown/`. A walker that
// read those quotes as string delimiters would desynchronise for the rest of the
// file — and it would do it SILENTLY, in the direction that under-counts: the call
// sites after the mis-parse simply stop being seen, and an absence assertion over a
// population that quietly shrank is exactly the failure these guards are about.
//
// Extracted from `tests/integration/ai/planningSubmitCarriesConsentFlag.test.ts`
// when a SECOND envelope field needed the same population (MOTIR-4736). Two
// copies of a parser whose subtleties are all load-bearing is two places for the
// same silent under-count to be reintroduced.

import { readFileSync } from 'node:fs';

export interface SubmitSite {
  file: string;
  /** The job-kind literal the call names, or null when it is not a literal. */
  kind: string | null;
  /** The call's argument text, comments blanked. */
  args: string;
}

/** Is `/` at `i` the start of a REGEX literal rather than a division operator? */
function startsRegex(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  if (j < 0) return true;
  return '(,=:[!&|?{};+-*%^~<>'.includes(src[j]!);
}

/**
 * Return `src` with every COMMENT replaced by spaces of the same length, leaving
 * string literals, regex literals and every byte offset exactly where they were.
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      blank(start, i);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && startsRegex(src, i)) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Enumerate every `submitJob(` CALL in one source file and return, per call, the
 * kind literal it names and its full (comment-free) argument text.
 *
 * Derived from the call sites themselves — a balanced scan of the comment-blanked
 * source — rather than from any list of the entrances that exist today. That is
 * the whole point of these guards: an entrance nobody has written yet is a call
 * site, so it is in the population by construction.
 */
export function submitSites(file: string, src: string): SubmitSite[] {
  const code = blankComments(src);
  const sites: SubmitSite[] = [];
  const CALL = 'submitJob(';
  let at = code.indexOf(CALL);
  while (at !== -1) {
    // A DECLARATION, not a call — `export async function submitJob(` in the
    // client itself. Its first parameter is a typed `kind`, so it could never be
    // an offender; skipping it keeps the population honest anyway.
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, at - 30), at))) {
      at = code.indexOf(CALL, at + CALL.length);
      continue;
    }
    let i = at + CALL.length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i]!;
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i++;
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2;
            continue;
          }
          if (code[i] === quote) break;
          i++;
        }
      } else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      i++;
    }
    const args = code.slice(at + CALL.length, i - 1);
    const kind = /^\s*'([a-z_]+)'/.exec(args)?.[1] ?? null;
    sites.push({ file, kind, args });
    at = code.indexOf(CALL, i);
  }
  return sites;
}

/**
 * The ONE planning kind on the wire (ADR `session-model.md` §6 step 2 —
 * MOTIR-3943 collapsed the five). A submit naming a RETIRED planning kind is a
 * separate property with its own guard in
 * `tests/integration/ai/storyGate.oneKindOnTheWire.test.ts`; for the call-site
 * guards that import this module, that guard's output is a precondition, so the
 * planning population is exactly this literal.
 */
export const PLANNING_KIND = 'plan';

/**
 * Every `submitJob(` call site under `lib/`, with the walk itself asserted by the
 * caller — a walker that finds nothing passes every absence, which is the
 * tautology these guards exist to avoid being.
 */
export async function allSubmitSitesInLib(): Promise<{ files: string[]; sites: SubmitSite[] }> {
  const { globSync } = await import('node:fs');
  const files = globSync('lib/**/*.ts');
  return { files, sites: files.flatMap((f) => submitSites(f, readFileSync(f, 'utf8'))) };
}

/**
 * The planning submits whose context bag does not name `token` — the offenders,
 * formatted for a failure message.
 *
 * `token` is the COMPUTED KEY form (`[SOME_CONTEXT_FIELD]`) rather than the bare
 * wire string, because that is the discipline the envelope constants state in
 * their own words: there is no shared type across the open-core boundary, so each
 * name is a string agreement between two codebases and a typo on either side is
 * not a type error. A site spelling the literal instead is flagged, correctly.
 */
export function planningSitesMissing(sites: SubmitSite[], token: string): string[] {
  return sites
    .filter((s) => s.kind === PLANNING_KIND && !s.args.includes(token))
    .map((s) => `${s.file}: submitJob('${s.kind}', …) sends no ${token}`);
}
