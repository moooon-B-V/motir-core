import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_SETTINGS_NAV } from '@/lib/settings/workspaceSettingsNav';

// MOTIR-5150 — no shipped string sends a reader to a settings location that no
// longer exists.
//
// ── What went wrong ─────────────────────────────────────────────────────────
// MOTIR-4680 moved the git-connection surface from `/settings/workspace/github`
// to `/settings/organization/git` and DID sweep its referrers — its criteria
// required the redirects and a row in `tests/design-asset-addresses.test.ts` for
// every design asset naming the old address, enumerated from a lane run rather
// than guessed. That is a careful sweep, and it was bounded by the consumer
// kinds an existing guard can see.
//
// USER-FACING PROSE names an address too. Two catalogue strings survived:
//
//     github.development.noMatchesHint  → rendered in the PR picker's empty state
//     github.development.notConnected   → rendered in its error banner
//
// Both read "Settings → Workspace → GitHub". `WORKSPACE_SETTINGS_NAV` has three
// rows — Workspace, Security, Jobs — and no GitHub among them, so the one
// instruction on screen at the moment the reader has just failed led them
// somewhere with nothing in it. Every OTHER string in the catalogue already said
// "Settings → Organisation → Git".
//
// ── Why a GUARD, and why this shape ─────────────────────────────────────────
// The recurring failure is a sweep that is complete against whatever guard it
// consulted and silently incomplete against the product. A guard over the
// catalogues is the consumer kind nothing was watching. Modelled on
// `tests/i18n-no-internal-phase-noun.test.ts` — same structure, same KNOWN
// discipline asserted tight in both directions, same anchor against a vacuous
// scan — rather than a new lane.
//
// ⚠️ THE ASSERTION IS OVER PROSE, NOT OVER PATHS, and that is a deliberate
// departure from the card's own wording. The card asked for a test that "greps
// the catalogue for `/settings/workspace/github`". No catalogue contains any
// `/settings/...` path literal at all — addresses are named there as the
// BREADCRUMB a reader sees — so that grep returns zero today and would return
// zero on the unfixed code as well. A check that cannot go red is not evidence.
// The breadcrumb is the thing the reader follows, so the breadcrumb is what is
// asserted; the positive half below then pins the address to a route that is
// really on disk, which is what the path grep was reaching for.

const ROOT = process.cwd();

/** The dead breadcrumb, in both shipped locales. The tier word and the noun both
 *  moved, so each locale is matched on the pair rather than on either half —
 *  "Workspace" and "GitHub" are each legitimately all over the catalogues. */
const DEAD_ADDRESS: { label: string; re: RegExp }[] = [
  // en — "Settings → Workspace → GitHub", any spacing around the arrows.
  { label: 'Workspace → GitHub', re: /Workspace\s*→\s*GitHub/g },
  // zh — 工作区 → GitHub, whichever quotation marks wrap the breadcrumb.
  { label: '工作区 → GitHub', re: /工作区\s*→\s*GitHub/g },
];

/** Reader-facing catalogues only. Identifiers, comments, ADRs and design assets
 *  legitimately record the old address as history; a catalogue is the one tree
 *  whose every string is read by a user. */
const SCAN = { dir: 'messages', match: (rel: string) => rel.endsWith('.json') };

/**
 * A line inside the scan set where the dead address is genuinely right. Empty,
 * and asserted TIGHT in both directions below — an unlisted hit fails, and a
 * listed row that no longer matches fails too, which is what stops the table
 * decaying into a mute button.
 */
const KNOWN: { file: string; line: number; why: string }[] = [];

interface Finding {
  file: string;
  line: number;
  label: string;
  text: string;
}

/** Every catalogue in scope, as repo-relative paths. */
function scanCatalogs(root = ROOT): string[] {
  const dir = join(root, SCAN.dir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => SCAN.match(name))
    .map((name) => relative(root, join(dir, name)).split(sep).join('/'))
    .sort();
}

function findDeadAddress(root = ROOT): Finding[] {
  const found: Finding[] = [];
  for (const rel of scanCatalogs(root)) {
    let source: string;
    try {
      source = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    source.split('\n').forEach((text, index) => {
      for (const { label, re } of DEAD_ADDRESS) {
        re.lastIndex = 0;
        if (re.test(text)) found.push({ file: rel, line: index + 1, label, text: text.trim() });
      }
    });
  }
  return found;
}

describe('no catalogue string names a settings location that was deleted', () => {
  it('scans a real, non-empty set of catalogues', () => {
    // A scan that silently matches nothing is the most convincing kind of green
    // there is. Anchor it on both shipped locales.
    const files = scanCatalogs();
    expect(files).toContain('messages/en.json');
    expect(files).toContain('messages/zh.json');
  });

  it('finds no string still saying "Settings → Workspace → GitHub"', () => {
    const unlisted = findDeadAddress()
      .filter((f) => !KNOWN.some((k) => k.file === f.file && k.line === f.line))
      .map((f) => `${f.file}:${f.line} — ${f.label} — ${f.text.slice(0, 110)}`);

    expect(
      unlisted,
      'That address was deleted by MOTIR-4680. The git connection lives at ' +
        'Settings → Organisation → Git (`app/(authed)/settings/organization/git`). Repoint the ' +
        'string, or add the line to KNOWN with a reason if it is genuinely right there.',
    ).toEqual([]);
  });

  it('keeps KNOWN honest — every row still matches something', () => {
    const found = findDeadAddress();
    const stale = KNOWN.filter(
      (k) => !found.some((f) => f.file === k.file && f.line === k.line),
    ).map((k) => `${k.file}:${k.line} — ${k.why}`);
    expect(stale, 'a KNOWN row no longer matches — delete it').toEqual([]);
  });
});

describe('the address the repointed strings DO name is real', () => {
  it('the workspace settings rail offers no GitHub row', () => {
    // The reason the old breadcrumb is wrong, asserted rather than recited: this
    // is the rail a reader following "Settings → Workspace → …" actually sees.
    expect(WORKSPACE_SETTINGS_NAV.map((e) => e.id)).not.toContain('github');
    for (const entry of WORKSPACE_SETTINGS_NAV) {
      expect(entry.href).not.toContain('github');
    }
  });

  it('`/settings/organization/git` is a page on disk', () => {
    expect(existsSync(join(ROOT, 'app/(authed)/settings/organization/git/page.tsx'))).toBe(true);
  });

  it('both repointed picker strings name it, in both locales', () => {
    // The two keys the defect was reported on. Pinned POSITIVELY as well as
    // negatively: the grep above goes green on a string that names no address at
    // all, and an empty-state hint with no road out of it is the same dead end.
    const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8'));
    const zh = JSON.parse(readFileSync(join(ROOT, 'messages/zh.json'), 'utf8'));
    for (const key of ['noMatchesHint', 'notConnected'] as const) {
      expect(en.github.development[key], `en ${key}`).toContain('Settings → Organisation → Git');
      expect(zh.github.development[key], `zh ${key}`).toContain('设置 → 组织 → Git');
    }
  });
});
