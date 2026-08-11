// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { WorkItemTypePicker } from '@/components/issues/WorkItemTypePicker';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import {
  WORK_ITEM_TYPE_GROUP,
  WORK_ITEM_TYPE_META,
  workItemTypeChipBackground,
} from '@/lib/issues/workItemTypeMeta';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

afterEach(() => cleanup());

// MOTIR-2633 — the three type surfaces at the full admitted set, and the two
// invariants that would fail SILENTLY rather than loudly.
//
// Everything here reads the shared map, so "it will just work" is a reasonable
// belief — and the card asks for it to be checked rather than assumed, because
// the two things that can actually break are both invisible in review: a
// Tailwind class that is interpolated (and therefore stripped at build time,
// leaving a colourless glyph in production only), and a group set that is not a
// contiguous run of the canonical order (which would silently reorder the menu
// a person reads under time pressure).

const ADMITTED = ['copy', 'translate', 'verification', 'legal'] as const;

describe('WorkItemTypePicker — the full set, grouped', () => {
  it('offers every member, in the canonical order', () => {
    render(<WorkItemTypePicker value="code" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(WORK_ITEM_TYPES.length);
    expect(options.map((o) => o.textContent?.trim())).toEqual(
      WORK_ITEM_TYPES.map((t) => enMessages.labels.workItemType[t]),
    );
  });

  it('renders a section header per group, and headers are NOT options', () => {
    render(<WorkItemTypePicker value="code" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox'));

    for (const label of Object.values(enMessages.labels.workItemTypeGroup)) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // The header is `role="presentation"`, so it is not in the option set and
    // keyboard navigation cannot land on it.
    expect(screen.getAllByRole('option')).toHaveLength(WORK_ITEM_TYPES.length);
  });

  it('can select one of the admitted members', () => {
    const onChange = vi.fn();
    render(<WorkItemTypePicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: /Translate/ }));
    expect(onChange).toHaveBeenCalledWith('translate');
  });
});

describe('WorkItemTypeChip / Icon — every admitted member renders', () => {
  it.each(ADMITTED)('%s renders its label and its hued glyph', (type) => {
    const { container } = render(<WorkItemTypeChip type={type} />);
    expect(screen.getByText(enMessages.labels.workItemType[type])).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('class')).toContain(
      `text-(--el-type-${type})`,
    );
  });

  it('the chip TINT is built from the type token and the page background', () => {
    // Asserted on `workItemTypeChipBackground` rather than the rendered node:
    // happy-dom's CSSOM does not parse `color-mix()`, so React's style write is
    // dropped and both `style.backgroundColor` and the style ATTRIBUTE read
    // empty in this environment even though the browser renders it correctly.
    // The value is the thing under test, and this is where it is observable.
    for (const type of ADMITTED) {
      const bg = workItemTypeChipBackground(type);
      expect(bg).toContain(`var(--el-type-${type})`);
      expect(bg).toContain('var(--el-page-bg)');
    }
  });

  it.each(ADMITTED)('%s glyph carries its hue class', (type) => {
    const { container } = render(<WorkItemTypeIcon type={type} />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain(
      `text-(--el-type-${type})`,
    );
  });
});

describe('the two invariants that fail silently', () => {
  it('every hueClass is a COMPLETE literal — an interpolated class is stripped at build', () => {
    // The module's own rule. A constructed `text-(--el-type-${type})` is
    // invisible to the Tailwind scanner, so the colour survives review and
    // vanishes in production. Asserting the exact literal is what catches a
    // future refactor that "simplifies" the map into a template string.
    for (const type of WORK_ITEM_TYPES) {
      expect(WORK_ITEM_TYPE_META[type].hueClass).toBe(`text-(--el-type-${type})`);
      expect(WORK_ITEM_TYPE_META[type].hueVar).toBe(`--el-type-${type}`);
    }
  });

  it('the groups are CONTIGUOUS runs of the canonical order', () => {
    // The grouping must be a consequence of the order, not a second ordering:
    // that is what lets the picker add headers without reshuffling the list and
    // lets any consumer ignore `group` and still be correct. Nothing in the type
    // system says a Record has to describe runs, so it is asserted here.
    const seen: string[] = [];
    for (const type of WORK_ITEM_TYPES) {
      const g = WORK_ITEM_TYPE_GROUP[type];
      if (seen[seen.length - 1] !== g) {
        expect(seen, `group '${g}' is interrupted and then resumes`).not.toContain(g);
        seen.push(g);
      }
    }
    expect(seen).toEqual(['build', 'author', 'investigate', 'govern']);
  });
});

describe('catalogue parity', () => {
  it('every type and every group label has an en key AND its zh twin', () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(enMessages.labels.workItemType[type], `en label for ${type}`).toBeTruthy();
      expect(zhMessages.labels.workItemType[type], `zh label for ${type}`).toBeTruthy();
    }
    expect(Object.keys(zhMessages.labels.workItemType)).toEqual(
      Object.keys(enMessages.labels.workItemType),
    );
    expect(Object.keys(zhMessages.labels.workItemTypeGroup)).toEqual(
      Object.keys(enMessages.labels.workItemTypeGroup),
    );
  });

  it('the catalogue keys are the enum, in the canonical order', () => {
    // Order is not load-bearing in JSON, but keeping the catalogue in the same
    // order as the picker is what makes a missing member visible to a human
    // reading the diff — which is the review this card is meant to get.
    expect(Object.keys(enMessages.labels.workItemType)).toEqual([...WORK_ITEM_TYPES]);
  });

  it('no two types share a label in either locale', () => {
    for (const [name, m] of [
      ['en', enMessages],
      ['zh', zhMessages],
    ] as const) {
      const labels = WORK_ITEM_TYPES.map(
        (t) => (m.labels.workItemType as Record<WorkItemTypeDto, string>)[t],
      );
      expect(new Set(labels).size, `${name} has a duplicate type label`).toBe(labels.length);
    }
  });
});
