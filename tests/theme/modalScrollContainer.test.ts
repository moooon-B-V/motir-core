import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  MAX_BARE_FIELDS,
  MAX_BARE_LINES,
  MEASURED_MARKER,
  classifyModalSource,
  scanModalSites,
} from './modalScrollContainerScan';

// MOTIR-2491 — the anti-recurrence guard for the `Modal.Body`-bypass class.
//
// A `<Modal>` whose children are a bare `<div>` / `<form>` is a flex item with
// `min-height: auto` inside a panel capped at `max-h-[90vh] overflow-hidden`,
// so on a short viewport its overflow is clipped with no scrollbar and the
// footer — the primary action — is unreachable by any means. Two users hit it,
// four months apart (MOTIR-462, MOTIR-2488); both times the one reported site
// was fixed and the class was not. The primitive's own doc comment warned about
// exactly this, and the third instance shipped anyway — which is why this is a
// CI check and not a fourth paragraph of documentation.
//
// The predicate is about SHAPE, not size (see the scanner's header for why a
// line count would have missed the first instance): a bare `<Modal>` is fine
// only when its height is knowable from the call site — no child component
// rendered from another file, nothing repeated, at most two fields, a bounded
// region. Anything else wraps its content in `Modal.Body`, or carries the
// `modal-scroll-container: measured …` comment recording that it was rendered
// at a short viewport in its tallest reachable state and fit.
//
// ⚠️ The exemption records a MEASUREMENT, not an opinion. Both prior instances
// were invisible to their suites — `toBeVisible()` passes on a clipped element
// — so "I read the JSX and it looks short" is precisely the reasoning this
// guard exists to refuse. `tests/e2e/modal-scroll-container.spec.ts` carries
// the `toBeInViewport()` assertions for the sites the sweep found clipping.

const REPO_ROOT = resolve(__dirname, '..', '..');

/** A viewport no taller than this is what the sweep measured at (MOTIR-2488's recipe). */
const SHORT_VIEWPORT_HEIGHT = 700;

const describeSite = (s: ReturnType<typeof scanModalSites>[number]) =>
  `${s.file}:${s.line} — ${s.reasons.join('; ')}`;

describe('every tall <Modal> call site owns a scroll container (MOTIR-2491)', () => {
  const sites = scanModalSites(REPO_ROOT);

  it('finds the call sites at all (a guard over zero files proves nothing)', () => {
    expect(sites.length).toBeGreaterThan(40);
    // The two sites the prior instances fixed, both by wrapping in Modal.Body.
    expect(
      sites.find((s) => s.file === 'app/(authed)/settings/account/_components/CreateTokenModal.tsx')
        ?.verdict,
    ).toBe('body');
    // The report modal MOTIR-462 wrapped, and — in the same file — the
    // complete-sprint FORM, which the card's file-level enumeration could not
    // see (it skipped every file that already contained `Modal.Body`) and which
    // this card measured instead.
    expect(
      sites
        .filter((s) => s.file === 'app/(authed)/backlog/_components/CompleteSprintDialog.tsx')
        .map((s) => s.verdict),
    ).toEqual(['body', 'measured']);
  });

  it('no bare <Modal> renders content whose height the call site cannot know', () => {
    const violations = sites.filter((s) => s.verdict === 'VIOLATION');
    expect(
      violations.map(describeSite),
      'each of these renders more than a short confirm can hold without a scroll container. ' +
        'Wrap the fields in `Modal.Body` (the pattern in app/(authed)/_components/CreateIssueModal.tsx: ' +
        'the form is the flex column, fields go in Modal.Body, the footer is its sibling inside the form), ' +
        'or — only after rendering it at ≤700px tall in its TALLEST reachable state — record the measurement: ' +
        '{/* modal-scroll-container: measured 1280x700, tallest = <state>, panel <n>px */}. See MOTIR-2491.',
    ).toEqual([]);
  });

  it('every measurement exemption names a short viewport and the tallest state', () => {
    const measured = sites.filter((s) => s.verdict === 'measured');
    for (const s of measured) {
      expect(
        s.measured!.height,
        `${s.file}:${s.line} measured at ${s.measured!.viewport}`,
      ).toBeLessThanOrEqual(SHORT_VIEWPORT_HEIGHT);
      expect(
        s.measured!.state.length,
        `${s.file}:${s.line} names no tallest state`,
      ).toBeGreaterThan(3);
    }
  });

  // ⚠️ Proven by DELIBERATELY introducing the violation — a guard that has never
  // been shown to fail is indistinguishable from no guard. Both prior instances,
  // reduced to their shape.
  describe('fires on the two shapes that shipped', () => {
    it('MOTIR-462: a short region whose whole body is one child component', () => {
      const src = `
        import { Modal } from '@/components/ui/Modal';
        import { Button } from '@/components/ui/Button';
        import { SprintReport } from './SprintReport';
        export function Done({ open, onOpenChange, report }) {
          return (
            <Modal open={open} onOpenChange={onOpenChange} title="Sprint complete" size="lg">
              <SprintReport report={report} />
              <Modal.Footer>
                <Button onClick={() => onOpenChange(false)}>Close</Button>
              </Modal.Footer>
            </Modal>
          );
        }`;
      const [site] = classifyModalSource(src, 'fixture/Done.tsx');
      expect(site?.verdict).toBe('VIOLATION');
      expect(site?.opaque).toEqual(['SprintReport']);
      expect(site?.lines).toBeLessThan(MAX_BARE_LINES);
    });

    it('MOTIR-2488: a form with more fields than a short confirm holds', () => {
      const fields = Array.from(
        { length: MAX_BARE_FIELDS + 1 },
        (_, i) => `<Input label="f${i}" />`,
      ).join('\n');
      const src = `
        import { Modal } from '@/components/ui/Modal';
        import { Input } from '@/components/ui/Input';
        import { Button } from '@/components/ui/Button';
        export function CreateToken({ open, onOpenChange }) {
          return (
            <Modal open={open} onOpenChange={onOpenChange} title="Create token">
              <form className="flex flex-col gap-4">
                ${fields}
                <Modal.Footer>
                  <Button type="submit">Create token</Button>
                </Modal.Footer>
              </form>
            </Modal>
          );
        }`;
      const [site] = classifyModalSource(src, 'fixture/CreateToken.tsx');
      expect(site?.verdict).toBe('VIOLATION');
      expect(site?.fields).toBe(MAX_BARE_FIELDS + 1);
    });

    it('a repeated element is a violation however short the region', () => {
      const src = `
        import { Modal } from '@/components/ui/Modal';
        export function Pick({ rows }) {
          return (
            <Modal open onOpenChange={() => {}} title="Pick">
              <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>
            </Modal>
          );
        }`;
      expect(classifyModalSource(src, 'fixture/Pick.tsx')[0]?.verdict).toBe('VIOLATION');
    });
  });

  describe('does NOT fire on the shapes that are safe', () => {
    it('the same MOTIR-462 shape wrapped in Modal.Body', () => {
      const src = `
        import { Modal } from '@/components/ui/Modal';
        import { SprintReport } from './SprintReport';
        export function Done({ report }) {
          return (
            <Modal open onOpenChange={() => {}} title="Sprint complete" size="lg">
              <Modal.Body><SprintReport report={report} /></Modal.Body>
              <Modal.Footer />
            </Modal>
          );
        }`;
      expect(classifyModalSource(src, 'fixture/Done.tsx')[0]?.verdict).toBe('body');
    });

    it('a short confirm: text, an icon, two buttons, one field', () => {
      const src = `
        import { Modal } from '@/components/ui/Modal';
        import { Input } from '@/components/ui/Input';
        import { Button } from '@/components/ui/Button';
        import { TriangleAlert } from 'lucide-react';
        export function Confirm({ name }) {
          return (
            <Modal open onOpenChange={() => {}} title="Delete?" role="alertdialog">
              <div className="flex gap-3">
                <TriangleAlert className="size-4" />
                <p>This deletes {name}.</p>
              </div>
              <Input label="Type the name" />
              <Modal.Footer>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Delete</Button>
              </Modal.Footer>
            </Modal>
          );
        }`;
      const [site] = classifyModalSource(src, 'fixture/Confirm.tsx');
      expect(site?.verdict).toBe('short');
      expect(site?.opaque).toEqual([]);
    });

    it('a tall shape that carries a measurement is exempt, and the marker is parsed', () => {
      const src = `
        import { Modal } from '@/components/ui/Modal';
        import { AccessCards } from './AccessCards';
        export function Access() {
          return (
            <Modal open onOpenChange={() => {}} title="Access" size="sm">
              {/* modal-scroll-container: measured 1280x700, tallest = both cards, panel 312px */}
              <AccessCards />
              <Modal.Footer />
            </Modal>
          );
        }`;
      const [site] = classifyModalSource(src, 'fixture/Access.tsx');
      expect(site?.verdict).toBe('measured');
      expect(site?.measured).toEqual({
        viewport: '1280x700',
        height: 700,
        state: 'both cards',
        panel: 312,
      });
    });

    it('the marker requires a viewport AND a state — a bare claim is not a measurement', () => {
      expect(MEASURED_MARKER.test('modal-scroll-container: measured, it fits')).toBe(false);
      expect(MEASURED_MARKER.test('modal-scroll-container: measured 1280x700')).toBe(false);
      expect(
        MEASURED_MARKER.test('modal-scroll-container: measured 1280x700, tallest = create mode'),
      ).toBe(true);
    });
  });
});
