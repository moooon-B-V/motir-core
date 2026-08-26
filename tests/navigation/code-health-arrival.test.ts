import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3446 — `/code-health` was measured and correctly gets no functional
// diff. These assertions defend that outcome, because "no diff" is the one
// result a later sweep will helpfully undo.
//
// The page matches `await` eleven times, which sorts it second-worst in the app.
// Three of those are the gate, three are genuinely dependent (each consumes the
// previous step's output), and five ARE the concurrent fan-out machinery. The
// classification is recorded in the page's own header comment so the next reader
// meets it before starting; these tests pin the two things that comment claims.

const ROOT = join(__dirname, '..', '..');
const PAGE = join(ROOT, 'app', '(authed)', 'code-health', 'page.tsx');
const src = readFileSync(PAGE, 'utf8');

describe('/code-health keeps its concurrent fan-outs (MOTIR-3446)', () => {
  it('still fans the per-repo work out through allSettledOrThrow, at all three sites', () => {
    // MOTIR-3077 repaired these: under a bare `Promise.all` a rejected audit arm
    // abandoned both the other repos' audits and every convention read, leaving
    // a backend `idle in transaction`. Replacing one of them with `Promise.all`
    // would reintroduce that, and it would look like a simplification.
    const sites = src.match(/await allSettledOrThrow\(/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('never reaches for a bare Promise.all over the per-repo reads', () => {
    expect(src).not.toContain('await Promise.all(');
  });
});

describe('/code-health takes no route boundary (MOTIR-3446)', () => {
  // Rule 5 of design/shell/design-notes.md § WHICH SURFACES EARN A FRAME. The
  // page does not call notFound(), so this is a preference rather than a
  // prohibition — but it is still one mechanism, not two.
  it('has no loading.tsx', () => {
    expect(existsSync(join(ROOT, 'app', '(authed)', 'code-health', 'loading.tsx'))).toBe(false);
  });

  it('adds no in-page boundary while its island has no drawn pending state', () => {
    expect(src).not.toContain('<Suspense');
  });
});

describe('the measurement is recorded where the next sweep will read it (MOTIR-3446)', () => {
  // The card's FIRST deliverable is the measurement, and a pull-request body is
  // not somewhere a future reader looks. This asserts the classification stayed
  // with the code it describes.
  it('the page carries the await classification', () => {
    expect(src).toContain('THE AWAIT COUNT IS A TRIGGER, NOT THE FINDING');
    expect(src).toContain('GENUINELY DEPENDENT');
    expect(src).toContain('ALREADY CONCURRENT');
  });
});
