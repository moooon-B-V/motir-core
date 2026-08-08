import { describe, expect, it } from 'vitest';
import { scanSource, violations, type InkFinding, type Verdict } from './inkContrastScan';

// The scanner's own fixtures (MOTIR-2459). Every case here is a SYNTHETIC
// source, not a file from the tree, for two reasons: the repo's real sites move
// (MOTIR-2475 and MOTIR-2477 are about to change 262 of them), and a guard
// asserted against the codebase it guards can only ever say "no change", never
// "this is what I decide".
//
// ── Why the negative case is first ──────────────────────────────────────────
// MOTIR-2455 measured `--el-text-faint` at 2.37–2.61:1 — below AA on every
// surface in both themes — and the rule it settled was then written into
// `motir-core/CLAUDE.md` and the token's own comment, where it was broken 262
// more times. So the value of this file is not that the scanner passes clean
// code; it is that it FAILS dirty code, which is the half a lint silently loses
// when its detection quietly stops matching. `refusesFaintOnPlainText` is
// therefore the load-bearing test, and every "clears" case below exists to stop
// it being satisfied by a scanner that flags everything.

function scan(source: string): InkFinding[] {
  return scanSource('fixture.tsx', source);
}

/** The sole finding, asserted to exist — so a case that expects one says so. */
function only(findings: InkFinding[]): InkFinding {
  expect(findings).toHaveLength(1);
  return findings[0]!;
}

/** The verdicts for one ink, in source order — the shape most cases assert on. */
function verdictsFor(source: string, ink: 'faint' | 'muted'): Verdict[] {
  return scan(source)
    .filter((finding) => finding.ink === ink)
    .map((finding) => finding.verdict);
}

describe('ink-contrast scanner — `--el-text-faint` on active text', () => {
  it('refusesFaintOnPlainText: flags faint ink on a paragraph of real copy', () => {
    // THE NEGATIVE CASE. If this ever passes, the guard has stopped working and
    // every "clears" test below would still be green.
    const findings = scan(`
      export function Caption() {
        return <p className="text-xs text-(--el-text-faint)">Updated 3 minutes ago</p>;
      }
    `);

    const finding = only(findings);
    expect(finding).toMatchObject({ ink: 'faint', verdict: 'violation', element: 'p' });
    expect(finding.reason).toContain('clears AA on no surface');
    expect(finding.snippet).toContain('Updated 3 minutes ago');
    expect(violations(findings)).toHaveLength(1);
  });

  it('reports the line the class sits on, so the sweeps can be driven off the output', () => {
    const findings = scan(
      [
        'export function A() {',
        '  return (',
        '    <span',
        '      className="text-(--el-text-faint)"',
        '    >x</span>',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(findings[0]).toMatchObject({ file: 'fixture.tsx', line: 4 });
  });

  it('clears an aria-hidden glyph — the meaning lives in a label, not in the pixels', () => {
    expect(
      verdictsFor(
        `<ChevronRight aria-hidden className="text-(--el-text-faint) h-4 w-4" />`,
        'faint',
      ),
    ).toEqual(['decorative']);
  });

  it('clears a LABELLED role="img" and refuses an UNLABELLED one', () => {
    expect(
      verdictsFor(
        `<span role="img" aria-label="Not held" className="text-(--el-text-faint)">—</span>`,
        'faint',
      ),
    ).toEqual(['decorative']);

    // Nothing else states what this glyph means, so its ink has to be readable.
    expect(
      verdictsFor(`<span role="img" className="text-(--el-text-faint)">!</span>`, 'faint'),
    ).toEqual(['violation']);
  });

  it('clears a labelled control whose content is glyphs only', () => {
    // The ink paints an icon that is already aria-hidden; the button's own name
    // carries the meaning. 1.4.3 has no text here to measure.
    expect(
      verdictsFor(
        `<button type="button" aria-label="Reorder column" className="text-(--el-text-faint)">
           <GripVertical aria-hidden />
         </button>`,
        'faint',
      ),
    ).toEqual(['decorative']);
  });

  it('refuses that same control once it renders text of its own', () => {
    expect(
      verdictsFor(
        `<button type="button" aria-label="Reorder column" className="text-(--el-text-faint)">
           <GripVertical aria-hidden />
           Reorder
         </button>`,
        'faint',
      ),
    ).toEqual(['violation']);
  });

  it('clears a disabled element — WCAG 1.4.3 exempts inactive text', () => {
    expect(
      verdictsFor(`<button disabled className="text-(--el-text-faint)">Save</button>`, 'faint'),
    ).toEqual(['disabled']);
    expect(
      verdictsFor(
        `<span aria-disabled="true" className="text-(--el-text-faint)">Save</span>`,
        'faint',
      ),
    ).toEqual(['disabled']);
  });

  it('clears the `disabled ? faint : ink` ternary — the exemption written as a style', () => {
    expect(
      verdictsFor(
        `<span className={disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}>{label}</span>`,
        'faint',
      ),
    ).toEqual(['disabled']);

    // …and the same shape with the predicate the other way round.
    expect(
      verdictsFor(
        `<span className={isEnabled ? 'text-(--el-text)' : 'text-(--el-text-faint)'}>{label}</span>`,
        'faint',
      ),
    ).toEqual(['disabled']);
  });

  it('does NOT accept any ternary as a disability claim', () => {
    // `read` is a display state, not an inactive control: the text is still
    // live copy a person has to read.
    expect(
      verdictsFor(
        `<span className={read ? 'text-(--el-text-faint)' : 'text-(--el-text)'}>{title}</span>`,
        'faint',
      ),
    ).toEqual(['violation']);
  });

  it('sees through a `cn()` call to the element the class lands on', () => {
    expect(
      verdictsFor(
        `<span className={cn('truncate text-xs', 'text-(--el-text-faint)')}>{title}</span>`,
        'faint',
      ),
    ).toEqual(['violation']);
    expect(
      verdictsFor(
        `<Icon aria-hidden className={cn('size-4', 'text-(--el-text-faint)')} />`,
        'faint',
      ),
    ).toEqual(['decorative']);
  });

  it('rules a class CONSTANT unattributable, and counts that as a failure', () => {
    // "I cannot see what this is" is not a pass. The same stance
    // `tests/work-items/activity-registry-totality.test.ts` takes on a computed
    // diff key: an unanalyzable site is a gap to resolve, not a clean result.
    const findings = scan(`const WITHHELD = 'text-(--el-text-faint)';`);
    expect(only(findings)).toMatchObject({ verdict: 'unattributable', element: null });
    expect(violations(findings)).toHaveLength(1);
  });
});

describe('ink-contrast scanner — `--el-text-muted` and the surface under it', () => {
  it('flags muted text over each tinted surface it fails on', () => {
    for (const surface of ['bg-(--el-surface)', 'bg-(--el-surface-soft)', 'bg-(--el-muted)']) {
      const findings = scan(
        `<div className="${surface} p-3"><span className="text-(--el-text-muted)">12 issues</span></div>`,
      );
      const finding = only(findings);
      expect(finding, surface).toMatchObject({
        ink: 'muted',
        verdict: 'violation',
        element: 'span',
      });
      expect(finding.reason).toContain(surface);
    }
  });

  it('clears the same text on the white card, where it measures 4.54:1', () => {
    expect(
      verdictsFor(
        `<div className="bg-(--el-card) p-3"><span className="text-(--el-text-muted)">12 issues</span></div>`,
        'muted',
      ),
    ).toEqual([]);
  });

  it('takes the NEAREST surface, so a card inside a tinted panel still clears', () => {
    expect(
      verdictsFor(
        `<section className="bg-(--el-surface)">
           <div className="bg-(--el-card) p-3">
             <span className="text-(--el-text-muted)">12 issues</span>
           </div>
         </section>`,
        'muted',
      ),
    ).toEqual([]);
  });

  it('clears a glyph and a disabled control over a tinted surface — 1.4.3 measures neither', () => {
    expect(
      verdictsFor(
        `<div className="bg-(--el-surface)"><Mail aria-hidden className="text-(--el-text-muted) h-4 w-4" /></div>`,
        'muted',
      ),
    ).toEqual([]);
    expect(
      verdictsFor(
        `<div className="bg-(--el-surface)"><button disabled className="text-(--el-text-muted)">Save</button></div>`,
        'muted',
      ),
    ).toEqual([]);
  });

  it('ABSTAINS when no ancestor in this file paints a background — the documented blind spot', () => {
    // The background here is painted by whatever mounts this component. The
    // scanner cannot follow that, and says nothing rather than guessing. This is
    // the limit MOTIR-2477 inherits and is required to state in its own PR.
    expect(
      verdictsFor(`<span className="text-(--el-text-muted)">12 issues</span>`, 'muted'),
    ).toEqual([]);
  });
});

describe('ink-contrast scanner — the inks it is not about', () => {
  it('says nothing about `--el-text-secondary`, which clears AA on all four surfaces', () => {
    expect(
      scan(
        `<div className="bg-(--el-surface)"><span className="text-(--el-text-secondary)">12 issues</span></div>`,
      ),
    ).toEqual([]);
  });

  it('reports both inks from one file, each with its own reason', () => {
    const findings = scan(
      `<div className="bg-(--el-surface) p-3">
         <p className="text-(--el-text-faint)">Updated 3 minutes ago</p>
         <span className="text-(--el-text-muted)">12 issues</span>
       </div>`,
    );
    expect(findings.map((finding) => finding.ink)).toEqual(['faint', 'muted']);
    expect(violations(findings)).toHaveLength(2);
  });
});
