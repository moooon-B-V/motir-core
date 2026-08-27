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

describe('ink-contrast scanner — the class and the element can come apart (MOTIR-2489)', () => {
  // Three constructs let a Tailwind class describe an element it is not written
  // on. Each was mis-ruled in the tree the faint sweep went through, and two of
  // the three failed SILENTLY — a green run over a defect. Every case below is
  // the shape of a real site, reduced; the comment names the file it came from.

  describe('a descendant variant addresses a CHILD', () => {
    it('judges the glyph the ink lands on, not the label-rendering ancestor', () => {
      // PublicTabNav.tsx — a false POSITIVE: the `<Link>` renders "Docs", so the
      // carrier read as active text, while the ink only ever painted the glyph.
      expect(
        verdictsFor(
          `<a className="inline-flex gap-2 [&_svg]:text-(--el-text-faint)">
             <svg aria-hidden viewBox="0 0 16 16" />
             Docs
           </a>`,
          'faint',
        ),
      ).toEqual(['decorative']);
    });

    it('refuses the same variant once its target is the thing rendering text', () => {
      const finding = only(
        scan(
          `<div className="[&_.seg-trail]:text-(--el-text-faint)">
             <span className="seg-trail">12</span>
           </div>`,
        ),
      );
      expect(finding).toMatchObject({ verdict: 'violation', element: 'span' });
      // The snippet shows the TARGET, not the carrier: the reader is being asked
      // to check a judgement about the span, so the span is what they must see.
      expect(finding.snippet).toContain('12');
    });

    it('rules the variant unattributable when its selector names nothing in this file', () => {
      // The same PublicTabNav shape with the icon left as a component: `svg` is
      // what the browser sees, not what this file says. Silently judging the
      // carrier here is what produced the false positive above, so the honest
      // answer is that the target is unknown — which FAILS, and asks a person.
      const findings = scan(
        `<Link href="/docs" className="[&_svg]:text-(--el-text-faint)">
           <ChevronRight aria-hidden />
           <span>Docs</span>
         </Link>`,
      );
      const finding = only(findings);
      expect(finding).toMatchObject({ verdict: 'unattributable', element: null });
      expect(finding.reason).toContain('matches no element');
      expect(violations(findings)).toHaveLength(1);
    });

    it('rules a selector past its reading unattributable too, and says which', () => {
      const finding = only(
        scan(`<div className="[&_ul>li:first-child]:text-(--el-text-faint)" />`),
      );
      expect(finding).toMatchObject({ verdict: 'unattributable', element: null });
      expect(finding.reason).toContain('past what this scanner reads');
    });

    it('resolves a CHILD combinator against direct children only', () => {
      expect(
        verdictsFor(
          `<div className="[&>svg]:text-(--el-text-faint)">
             <span><svg aria-hidden /></span>
           </div>`,
          'faint',
        ),
      ).toEqual(['unattributable']);
    });

    it('leaves a STATE variant on the carrier — `hover:` retargets nothing', () => {
      // Only a variant whose `&` is followed by a combinator moves the ink off
      // the element. `hover:` / `[&:hover]` still paint the carrier itself.
      expect(
        verdictsFor(
          `<p className="hover:text-(--el-text-faint)">Updated 3 minutes ago</p>`,
          'faint',
        ),
      ).toEqual(['violation']);
      expect(
        verdictsFor(`<p className="[&:hover]:text-(--el-text-faint)">Updated</p>`, 'faint'),
      ).toEqual(['violation']);
    });
  });

  describe('a conditional `disabled` describes the element only SOMETIMES', () => {
    it('refuses the 1.4.3 exemption for `disabled={a || b}`', () => {
      // Segmented.tsx — a false NEGATIVE: an INACTIVE segment's trailing count
      // painted at ~2.4:1 on the render where the control was not disabled, and
      // the scanner never reported it because the attribute was merely present.
      expect(
        verdictsFor(
          `<button disabled={disabled || opt.disabled} className="text-(--el-text-faint)">{opt.trailing}</button>`,
          'faint',
        ),
      ).toEqual(['violation']);
      expect(
        verdictsFor(
          `<span aria-disabled={isLocked} className="text-(--el-text-faint)">{count}</span>`,
          'faint',
        ),
      ).toEqual(['violation']);
    });

    it('exempts a conditional attribute when the STYLE asks the same question', () => {
      // The counterpart the refusal above needs. `atCap` says nothing to the
      // predicate vocabulary, but the ternary is computed from the very
      // expression `disabled` is, so the ink paints exactly in the inactive
      // render. Three cap-limited buttons in the tree are this shape, and
      // without this arm the widening would report all three as defects.
      const finding = only(
        scan(
          `<button disabled={atCap} className={cn('gap-1.5', atCap ? 'text-(--el-text-faint)' : 'text-(--el-link)')}>{t('add')}</button>`,
        ),
      );
      expect(finding.verdict).toBe('disabled');
      expect(finding.reason).toContain('the same expression `disabled` is computed from');

      // …and its negated mirror, where the ink is in the FALSE branch.
      expect(
        verdictsFor(
          `<button disabled={!hasRows} className={hasRows ? 'text-(--el-link)' : 'text-(--el-text-faint)'}>{t('clear')}</button>`,
          'faint',
        ),
      ).toEqual(['disabled']);
    });

    it('refuses the branch that paints while the control is ENABLED', () => {
      // Same two expressions, opposite branch: this ink is on screen precisely
      // when the button is live. An equality check that ignored which branch
      // the class sits in would clear it.
      expect(
        verdictsFor(
          `<button disabled={atCap} className={atCap ? 'text-(--el-link)' : 'text-(--el-text-faint)'}>{t('add')}</button>`,
          'faint',
        ),
      ).toEqual(['violation']);
    });

    it('still exempts the UNCONDITIONAL forms — the exemption is real where it is stated', () => {
      // The bare attribute and the string form are already covered above; these
      // are the two an expression-blind reading would have swept up with them.
      expect(
        verdictsFor(
          `<button disabled={true} className="text-(--el-text-faint)">Save</button>`,
          'faint',
        ),
      ).toEqual(['disabled']);
      expect(
        verdictsFor(
          `<span aria-disabled={false} className={locked ? 'text-(--el-text-faint)' : 'text-(--el-text)'}>{label}</span>`,
          'faint',
        ),
      ).toEqual(['disabled']); // via the ternary, which says which branch is which
    });
  });

  describe('a `placeholder:` prefix paints a pseudo-element that IS text', () => {
    it('refuses faint placeholder ink on a labelled self-closing control', () => {
      // OnboardingEntrance.tsx — a false NEGATIVE: `rendersText` is false for a
      // self-closing element, so the glyphs-only arm cleared the one string on
      // the surface a person actually reads, at 2.61:1.
      const finding = only(
        scan(
          `<textarea aria-label="Describe your project" className="placeholder:text-(--el-text-faint)" />`,
        ),
      );
      expect(finding).toMatchObject({ verdict: 'violation', element: 'textarea' });
    });

    it('keeps the exemptions that are still true of a placeholder', () => {
      // Disabled is a property of the CONTROL, so it covers the placeholder too.
      expect(
        verdictsFor(
          `<input disabled aria-label="Search" className="placeholder:text-(--el-text-faint)" />`,
          'faint',
        ),
      ).toEqual(['disabled']);
    });

    it('does not let the placeholder rule leak onto the glyphs-only arm', () => {
      // The same control WITHOUT a placeholder variant is still a labelled
      // glyph holder, and still clears — the fix is scoped to the occurrence.
      expect(
        verdictsFor(`<input aria-label="Search" className="text-(--el-text-faint)" />`, 'faint'),
      ).toEqual(['decorative']);
    });
  });

  it('judges each class OCCURRENCE, so two inks in one attribute get two verdicts', () => {
    // The unit of judgement is the token, not the literal: the variants that
    // decide which element the ink lands on live on the token.
    expect(
      verdictsFor(
        `<p className="text-(--el-text-faint) [&_svg]:text-(--el-text-faint)">
           <svg aria-hidden />
           Updated 3 minutes ago
         </p>`,
        'faint',
      ),
    ).toEqual(['violation', 'decorative']);
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

  it('clears the same text on `--el-page-bg`, the OTHER name for that white', () => {
    // MOTIR-2497. `--el-page-bg` and `--el-card` are both
    // `var(--color-background)`, so this fixture and the one above describe two
    // elements painted the identical colour. Before the fix only the `--el-card`
    // spelling ended the walk and this one was reported as ink on a tint.
    expect(
      verdictsFor(
        `<div className="bg-(--el-page-bg) p-3"><span className="text-(--el-text-muted)">12 issues</span></div>`,
        'muted',
      ),
    ).toEqual([]);
  });

  it('clears an element painting its OWN `--el-page-bg` inside a tinted ancestor', () => {
    // The instance the bug was found on: `backlog/_components/CreateIssueRow.tsx`
    // is an input carrying `bg-(--el-page-bg)` on ITSELF, inside a row painted
    // `--el-surface-soft`. Its placeholder sits on white (4.54:1, passing) and
    // the guard reported it at 4.12–4.34:1 on the ancestor's tint.
    expect(
      verdictsFor(
        `<div className="bg-(--el-surface-soft) p-2">
           <input aria-label="Title" className="bg-(--el-page-bg) placeholder:text-(--el-text-muted)" />
         </div>`,
        'muted',
      ),
    ).toEqual([]);
  });

  it('still reports that same ink when the element paints NO background of its own', () => {
    // The other arm, and the one that proves the fix is a surface correction
    // rather than an exemption: remove the input's own white and the ancestor's
    // tint is what the placeholder actually sits on.
    const finding = only(
      scan(
        `<div className="bg-(--el-surface-soft) p-2">
           <input aria-label="Title" className="placeholder:text-(--el-text-muted)" />
         </div>`,
      ),
    );
    expect(finding).toMatchObject({ ink: 'muted', verdict: 'violation', element: 'input' });
    expect(finding.reason).toContain('bg-(--el-surface-soft)');
  });

  it('refuses a safe background that only paints on HOVER', () => {
    // A variant-prefixed white is not the element's resting surface: this
    // button is tinted in every render but one. Reading it as safe would be a
    // false NEGATIVE, which reads as coverage — so the safe arm matches only an
    // UNPREFIXED class, unlike the tinted arm, which over-reports on purpose.
    expect(
      verdictsFor(
        `<button className="bg-(--el-surface) hover:bg-(--el-page-bg) text-(--el-text-muted)">12 issues</button>`,
        'muted',
      ),
    ).toEqual(['violation']);

    // …and with the tint on the ancestor rather than the element itself, so the
    // hover class is the only thing the safe arm could have matched.
    expect(
      verdictsFor(
        `<div className="bg-(--el-muted) p-2">
           <button className="hover:bg-(--el-card) text-(--el-text-muted)">12 issues</button>
         </div>`,
        'muted',
      ),
    ).toEqual(['violation']);
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

describe('ink-contrast scanner — the surface a component INHERITS from its use site (MOTIR-3523)', () => {
  // The blind spot this describes is the one that let a real defect stand on
  // `main` for as long as the file existed: the operator jobs dashboard writes
  // its column labels in a local `Th` and paints the tint on the `<thead>` that
  // USES it, so the ink and the surface never share an ancestor chain. Eight
  // labels sat at 4.17:1 with every guard in the tree green.
  //
  // It is NOT the cross-module boundary `inkContrastLint.test.ts` documents as
  // out of reach. Both halves are in one file and one AST, which is what makes
  // this resolvable at all — and what makes the abstention worth closing.
  //
  // ⚠️ THE ARM IS UNCONDITIONAL (MOTIR-3711). It shipped behind an opt-in
  // `ScanOptions.resolveUseSites` for exactly one pull request, so that the
  // sweep of the population it un-blinds could land WITH the switch rather than
  // after it (MOTIR-2496 is what the other order costs). MOTIR-3711 swept those
  // eight sites and removed the flag; `scanSource` takes no options at all now.
  // What the fixtures below still pin is what the walk DECLINES to resolve —
  // that is the part a later widening would be changing.
  const source = `
    function Th({ children }: { children: ReactNode }) {
      return <th className="px-3 py-2 text-(--el-text-muted)">{children}</th>;
    }

    function RunsTable() {
      return (
        <table>
          <thead className="bg-(--el-surface)">
            <tr><Th>Status</Th></tr>
          </thead>
        </table>
      );
    }
  `;

  it('flags the ink with no option asked for, naming the line that paints it', () => {
    // This assertion is the inverse of the one that stood here while the arm was
    // opt-in ('ABSTAINS by default'), on the same fixture. Kept as an inversion
    // rather than a deletion: the fixture is the shape that hid a real defect,
    // and what changed is only who has to ask for the walk.
    const finding = only(scanSource('fixture.tsx', source));
    expect(finding).toMatchObject({ ink: 'muted', verdict: 'violation', element: 'th' });
    expect(finding.reason).toContain('bg-(--el-surface)');
    // The line the reader has to open is the USE SITE, not the ink — the ink's
    // own line is already in `file:line`, and on its own it looks blameless.
    expect(finding.reason).toContain('use site at line 10');
  });

  it('clears the same component when its use site paints the white card', () => {
    expect(
      scanSource('fixture.tsx', source.replace('bg-(--el-surface)', 'bg-(--el-card)')),
    ).toEqual([]);
  });

  it('flags a component used over a tint at ONE site and white at another', () => {
    // Over-reporting is the tinted arm's standing policy, and here it is not
    // even over-reporting: the label really is unreadable at the tinted site.
    const findings = scanSource(
      'fixture.tsx',
      `
        function Label({ children }: { children: ReactNode }) {
          return <span className="text-(--el-text-muted)">{children}</span>;
        }

        function Panel() {
          return (
            <>
              <div className="bg-(--el-card)"><Label>safe</Label></div>
              <div className="bg-(--el-surface)"><Label>unreadable</Label></div>
            </>
          );
        }
      `,
    );
    expect(findings.map((finding) => finding.verdict)).toEqual(['violation']);
  });

  it('stays silent for a component nothing in this file uses', () => {
    // An EXPORTED component's callers live in other modules, which is the
    // import-graph problem this arm deliberately does not take on. No use site
    // in this file means no surface, and no surface means abstain — never a
    // clean bill of health.
    expect(
      scanSource(
        'fixture.tsx',
        `export function Th({ children }: { children: ReactNode }) {
           return <th className="text-(--el-text-muted)">{children}</th>;
         }`,
      ),
    ).toEqual([]);
  });

  it('does not read a NESTED helper as the component whose use sites count', () => {
    // Only a TOP-LEVEL declaration is resolvable. Walking past `Row` to the
    // `Panel` around it would let PANEL's use sites decide ROW's surface — a
    // surface `Row` may never sit on, reported at a line the reader cannot act
    // on. The innermost enclosing function decides, and a nested one decides to
    // abstain. (`Row` is genuinely over a tint here, and the arm still declines
    // to say so: under-reporting is the price of not mis-attributing. That trade
    // is the one a later widening would be revisiting, and this fixture is where
    // it is recorded. Note what it is NOT evidence of: an abstention emits no
    // finding, so MOTIR-3711's sweep of the tree could not have counted the
    // instances of this shape, and its silence says nothing about how many there
    // are. Measuring them is the first step of any card that wants to change
    // this trade.)
    expect(
      scanSource(
        'fixture.tsx',
        `function Panel() {
           const Row = () => <span className="text-(--el-text-muted)">12 issues</span>;
           return <div className="bg-(--el-surface)"><Row /></div>;
         }`,
      ),
    ).toEqual([]);
  });
});
