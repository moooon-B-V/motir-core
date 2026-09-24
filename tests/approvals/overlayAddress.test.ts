import { describe, expect, it } from 'vitest';
import { APPROVAL_GATE_HANDLERS, UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import {
  APPROVAL_GATE_KINDS,
  APPROVAL_OVERLAY_PARAM_NAMES,
  parseApprovalOverlay,
  withApprovalOverlay,
  withoutApprovalOverlay,
} from '@/lib/approvals/overlayAddress';

// THE APPROVAL OVERLAY'S ADDRESS (Story MOTIR-5214 · Subtask MOTIR-5224).
//
// The address is a CONTRACT three cards read — the host (this card), the row door
// (MOTIR-5225) and the item page's door (MOTIR-5215) — so the names are asserted
// against `design/workbench/design-notes.md` § 22 verbatim, and the strip is
// asserted to leave every host parameter alone, because *back to exactly where you
// were* is a claim about a filtered, paged page and not only a bare route.

describe('the approval overlay address (MOTIR-5224)', () => {
  it('uses exactly the two names § 22 settles', () => {
    expect(APPROVAL_OVERLAY_PARAM_NAMES).toEqual({ item: 'approval', kind: 'approvalKind' });
  });

  it('lists every gate kind the registry classifies — no more, no fewer', () => {
    // The client module cannot import the registry, so its list is written out;
    // this is what keeps the two from drifting apart.
    const registry = [...Object.keys(APPROVAL_GATE_HANDLERS), ...UNREGISTERED_GATE_KINDS].sort();
    expect([...APPROVAL_GATE_KINDS].sort()).toEqual(registry);
  });

  it('reads CLOSED when `approval` is absent, whatever else the query holds', () => {
    expect(parseApprovalOverlay(new URLSearchParams(''))).toBeNull();
    expect(
      parseApprovalOverlay(new URLSearchParams('approvalKind=design_result&peek=A-1')),
    ).toBeNull();
  });

  it('reads the key and kind of an open address', () => {
    expect(
      parseApprovalOverlay(
        new URLSearchParams('approval=%20MOTIR-12%20&approvalKind=design_result'),
      ),
    ).toEqual({ itemKey: 'MOTIR-12', kind: 'design_result' });
  });

  it('keeps the overlay OPEN on a malformed address, and reports which half is missing', () => {
    // An empty key, an absent kind and a kind outside the enum each open the
    // overlay on "not available" — never a closed overlay, never a guessed kind.
    expect(
      parseApprovalOverlay(new URLSearchParams('approval=&approvalKind=design_result')),
    ).toEqual({
      itemKey: null,
      kind: 'design_result',
    });
    expect(parseApprovalOverlay(new URLSearchParams('approval=MOTIR-12'))).toEqual({
      itemKey: 'MOTIR-12',
      kind: null,
    });
    expect(
      parseApprovalOverlay(new URLSearchParams('approval=MOTIR-12&approvalKind=merge')),
    ).toEqual({
      itemKey: 'MOTIR-12',
      kind: null,
    });
  });

  it('accepts every member of the kind enum', () => {
    for (const kind of APPROVAL_GATE_KINDS) {
      expect(
        parseApprovalOverlay(new URLSearchParams(`approval=MOTIR-1&approvalKind=${kind}`))?.kind,
      ).toBe(kind);
    }
  });

  it('opens over the page it is on, keeping every host parameter and the hash', () => {
    expect(
      withApprovalOverlay('/workbench?tab=approvals&page=2#top', {
        itemKey: 'MOTIR-7',
        kind: 'design_result',
      }),
    ).toBe('/workbench?tab=approvals&page=2&approval=MOTIR-7&approvalKind=design_result#top');
  });

  it('re-targets an already-open address instead of adding a second pair', () => {
    const once = withApprovalOverlay('/items?peek=MOTIR-3', {
      itemKey: 'MOTIR-7',
      kind: 'design_result',
    });
    const twice = withApprovalOverlay(once, { itemKey: 'MOTIR-9', kind: 'pull_request_merge' });
    expect(twice).toBe('/items?peek=MOTIR-3&approval=MOTIR-9&approvalKind=pull_request_merge');
  });

  it('closes by stripping EXACTLY its two parameters', () => {
    expect(
      withoutApprovalOverlay(
        '/workbench?tab=approvals&approval=MOTIR-7&page=2&approvalKind=design_result',
      ),
    ).toBe('/workbench?tab=approvals&page=2');
    // No dangling `?` when the overlay was the whole query.
    expect(
      withoutApprovalOverlay('/items/MOTIR-7?approval=MOTIR-7&approvalKind=design_result'),
    ).toBe('/items/MOTIR-7');
    expect(withoutApprovalOverlay('/dashboard#x')).toBe('/dashboard#x');
  });
});

// THE ADDRESS IS NOT EXTENDED FOR A PLAN GATE (Story MOTIR-6012 · MOTIR-6034; ADR
// `approval-gates.md` §11.5b). `plan_approval` is in the tuple only because the tuple is
// total over the wire enum (`_KindsAreTotal`); a plan gate is decided on the planning
// surface, so the address gains no card-less form — still exactly two parameters, and
// still keyed by a work item's identifier.
describe('the overlay address and the card-less `plan_approval` kind (MOTIR-6034)', () => {
  it('spells the kind (the tuple is total over the enum) and adds no parameter for it', () => {
    expect(APPROVAL_GATE_KINDS).toContain('plan_approval');
    expect(Object.keys(APPROVAL_OVERLAY_PARAM_NAMES)).toEqual(['item', 'kind']);
  });

  it('an address naming the kind still carries a work item key, never a plan', () => {
    expect(withApprovalOverlay('/workbench', { itemKey: 'MOTIR-1', kind: 'plan_approval' })).toBe(
      '/workbench?approval=MOTIR-1&approvalKind=plan_approval',
    );
    expect(
      parseApprovalOverlay(new URLSearchParams('approval=MOTIR-1&approvalKind=plan_approval')),
    ).toEqual({ itemKey: 'MOTIR-1', kind: 'plan_approval' });
  });
});
