import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE PICKER'S COPY AGREES WITH THE DESIGN OF RECORD — MOTIR-5152.
//
// `design/github/design-notes.md` §5c specifies the Development panel's typed-error
// banner verbatim, and `messages/{en,zh}.json` ships it. Between MOTIR-4672 (which
// re-pointed the asset, merged 2026-09-05) and this card the two DISAGREED about the
// tenant: the asset said *organisation*, the catalogue said *workspace*. That was not
// drift — MOTIR-5150 kept *workspace* deliberately, because the shipped gate really did
// check a workspace, and filed MOTIR-5152 to move both together. Widening the gate is
// what made the design's sentence the true one.
//
// ⚠️ IT LIVES IN THE DESIGN LANE, AND THAT IS THE WHOLE POINT OF SPLITTING IT OUT.
// These assertions were written inside `tests/github/prLinkOrganisationTenancy.test.ts`,
// which is DB-backed — real Postgres, real webhook ingestion. `vitest.design.config.ts`
// promises a lane that needs no database, and `tests/ci-design-guards-lane.test.ts`
// enforces BOTH halves: every spec reading the design tree must be in the lane, and the
// lane must stay database-free. A DB-backed spec that reads `design/**` can satisfy
// neither, so the read moves here instead of being excluded — because a `design/*` PR
// editing §5c is exactly the pull request that must not skip this check, and it is the
// one that skips every app lane.
//
// (The sibling precedent is `design-lesson-phase-chips` (MOTIR-5107), which reads the
// lesson board and `messages/en.json` together for the same reason.)

const ROOT = process.cwd();

const notes = readFileSync(join(ROOT, 'design/github/design-notes.md'), 'utf8');
const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(join(ROOT, 'messages/zh.json'), 'utf8'));

describe('`github.development.notConnected` names the tenant the gate actually checks', () => {
  it('says ORGANISATION in both catalogues', () => {
    expect(en.github.development.notConnected).toContain('this organisation');
    expect(en.github.development.notConnected).not.toContain('this workspace');
    expect(zh.github.development.notConnected).toContain('此组织');
    expect(zh.github.development.notConnected).not.toContain('此工作区');
  });

  it('keeps the ADDRESS `tests/i18n-settings-address.test.ts` rules on', () => {
    // That guard (MOTIR-5150) asserts the destination, and gains nothing from the
    // tenant change — but the tenant edit must not disturb it, so it is pinned
    // beside the edit rather than only in the file that owns it.
    expect(en.github.development.notConnected).toContain('Settings → Organisation → Git');
    expect(zh.github.development.notConnected).toContain('设置 → 组织 → Git');
  });

  it('matches the sentence the design asset specifies, verbatim', () => {
    // Not a paraphrase check: §5c carries the string itself, so the catalogue and
    // the design are compared directly. This is what makes them stop disagreeing
    // rather than agreeing by coincidence.
    //
    // Whitespace is collapsed on BOTH sides because the asset is prose wrapped at
    // 80 columns — the sentence spans two lines there and one here, and a line
    // break is not a disagreement about copy.
    const collapse = (s: string) => s.replace(/\s+/g, ' ');
    expect(collapse(notes)).toContain(collapse(en.github.development.notConnected));
  });

  it('reads the section it claims to — so the assertions above are not vacuous', () => {
    // Without this, a rename or a re-slice of the asset would make every
    // `toContain` above pass against a file that no longer specifies this panel.
    expect(notes).toContain('**States (5c):**');
    expect(notes).toContain('`development.notConnected`');
  });
});
