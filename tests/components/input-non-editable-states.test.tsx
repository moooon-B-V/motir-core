// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Input } from '@/components/ui/Input';

// MOTIR-2495 — the shared `Input`'s two NON-EDITABLE states.
//
// The defect these pin: `disabled` was drawn as `opacity-50` on the field
// WRAPPER, and opacity composites the whole subtree against the page. That
// halves the contrast of everything inside — the value, the placeholder, and
// the `addonStart` / `addonEnd` affixes — so no ink choice at a call site could
// clear AA: the org-URL `motir.co/` prefix was already `--el-text-secondary`,
// the darkest caption ink in the palette (6.80:1 on white), and axe still
// measured it below 4.5. 1.4.3 exempts a disabled CONTROL, but the affix is a
// `<span>` beside the input, not the control, so the exemption never reached it.
//
// So the state is now expressed as COLOUR — `--el-input-disabled-*` /
// `--el-input-readonly-bg` — which puts it back inside the token layer the
// colour rule governs: every pair below is AA-checkable and palette-swappable.
// The assertions are on the CLASSES rather than on computed colour because the
// tokens resolve in the browser (the E2E axe sweep of /settings/organization is
// the measurement); what a unit test can hold is that the ink is routed through
// the right token for the right state, and that the opacity filter is gone.

afterEach(cleanup);

/** The field wrapper — the element the state classes land on. */
function wrapper(): HTMLElement {
  const el = document.querySelector('[data-surface="input"]');
  if (!el) throw new Error('no input wrapper rendered');
  return el as HTMLElement;
}

const affix = () => screen.getByText('motir.co/');

describe('Input — the editable baseline', () => {
  it('keeps the page fill, the enabled border and the field-icon affix ink', () => {
    render(<Input label="Organization URL" defaultValue="moooon" addonStart="motir.co/" />);
    expect(wrapper().className).toContain('bg-(--el-page-bg)');
    expect(wrapper().className).toContain('border-(--el-input-border)');
    expect(wrapper().getAttribute('data-state')).toBeNull();
    expect(affix().className).toContain('text-(--el-icon-field)');
    const field = screen.getByLabelText('Organization URL');
    expect(field.className).toContain('text-(--el-text)');
    // --el-text-muted clears AA on the white page by 0.04, so it is legal HERE
    // and only here — the two non-editable fills below take a darker ink.
    expect(field.className).toContain('placeholder:text-(--el-text-muted)');
  });
});

describe('Input — disabled', () => {
  it('renders the state as fill + border + ink, with NO opacity filter', () => {
    render(
      <Input label="Organization URL" defaultValue="moooon" addonStart="motir.co/" disabled />,
    );
    expect(wrapper().className).not.toMatch(/opacity-\d/);
    expect(wrapper().className).toContain('bg-(--el-input-disabled-bg)');
    expect(wrapper().className).toContain('border-(--el-input-disabled-border)');
    expect(wrapper().className).toContain('cursor-not-allowed');
    expect(wrapper().getAttribute('data-state')).toBe('disabled');
  });

  it('routes the value, the placeholder AND both affixes to the disabled ink', () => {
    render(
      <Input
        label="Organization URL"
        placeholder="your-org"
        addonStart="motir.co/"
        addonEnd=".dev"
        disabled
      />,
    );
    const field = screen.getByLabelText('Organization URL');
    expect(field.className).toContain('text-(--el-input-disabled-text)');
    expect(field.className).toContain('placeholder:text-(--el-input-disabled-text)');
    // The affixes are what the bug was measured on — BOTH slots, not just the
    // one the org card happens to use.
    expect(affix().className).toContain('text-(--el-input-disabled-text)');
    expect(screen.getByText('.dev').className).toContain('text-(--el-input-disabled-text)');
  });

  it('stays out of the tab order — a disabled control is not reachable', () => {
    render(<Input label="Organization URL" defaultValue="moooon" disabled />);
    expect((screen.getByLabelText('Organization URL') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Input — read-only', () => {
  it('gets its own fill, but keeps full-strength ink and the enabled border', () => {
    render(
      <Input label="Organization URL" defaultValue="moooon" addonStart="motir.co/" readOnly />,
    );
    expect(wrapper().className).toContain('bg-(--el-input-readonly-bg)');
    // Not the disabled edge: read-only is a live control, and the softer border
    // is one of the three cues that says "inert".
    expect(wrapper().className).toContain('border-(--el-input-border)');
    expect(wrapper().className).not.toContain('cursor-not-allowed');
    expect(wrapper().getAttribute('data-state')).toBe('readonly');
    const field = screen.getByLabelText('Organization URL');
    expect(field.className).toContain('text-(--el-text)');
    // --el-text-secondary, not --el-icon-field: the read-only fill is
    // --color-surface, where the field-icon ink measures 4.17:1.
    expect(affix().className).toContain('text-(--el-text-secondary)');
  });

  it('is focusable and selectable, and its value is still not editable', () => {
    render(<Input label="Organization URL" defaultValue="moooon" readOnly />);
    const field = screen.getByLabelText('Organization URL') as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(true);
    // Reachable from the keyboard — the reason `disabled` was the wrong control
    // for a value people are meant to read and copy.
    field.focus();
    expect(document.activeElement).toBe(field);
    field.setSelectionRange(0, field.value.length);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('moooon'.length);
    expect(field.value).toBe('moooon');
  });
});

describe('Input — both flags', () => {
  it('lets disabled win: it is the stronger claim and the one that removes focus', () => {
    render(
      <Input
        label="Organization URL"
        defaultValue="moooon"
        addonStart="motir.co/"
        readOnly
        disabled
      />,
    );
    expect(wrapper().getAttribute('data-state')).toBe('disabled');
    expect(wrapper().className).toContain('bg-(--el-input-disabled-bg)');
    expect(wrapper().className).not.toContain('bg-(--el-input-readonly-bg)');
    expect(affix().className).toContain('text-(--el-input-disabled-text)');
  });
});
