// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { OrgGeneralCard } from '@/app/(authed)/settings/organization/_components/OrgGeneralCard';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

// MOTIR-2495 — the organization URL is READ-ONLY, not disabled.
//
// The field shipped as `readOnly disabled`, which is two different claims at
// once and the wrong one won: a disabled input is removed from the tab order,
// so the only way to get the slug string was to select it with a mouse. That is
// the more basic defect underneath the contrast one — the org URL is a value
// people COPY. Making it read-only fixes the reachability, and it fixes the
// contrast as a side effect, because the shared `Input` no longer draws the
// field behind an `opacity-50` filter that composited its `motir.co/` affix
// below AA (see input-non-editable-states.test.tsx for the primitive's side).

afterEach(cleanup);

function renderCard() {
  return render(
    <ToastProvider>
      <OrgGeneralCard
        orgId="org1"
        initialName="moooon"
        slug="moooon"
        role="owner"
        workspaceCount={3}
        memberCount={14}
      />
    </ToastProvider>,
  );
}

const urlField = () => screen.getByLabelText('Organization URL') as HTMLInputElement;

describe('the organization URL field', () => {
  it('is keyboard-focusable and selectable', () => {
    renderCard();
    const field = urlField();
    expect(field.disabled).toBe(false);
    // A disabled input carries tabIndex -1 behaviour via the disabled attribute;
    // a read-only one stays in the natural tab order.
    expect(field.getAttribute('tabindex')).toBeNull();
    field.focus();
    expect(document.activeElement).toBe(field);
    field.setSelectionRange(0, field.value.length);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('moooon'.length);
  });

  it('still refuses edits — the slug is not changeable from here', () => {
    renderCard();
    const field = urlField();
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe('moooon');
    // The card holds the slug as a prop with no onChange, so a change event is
    // the strongest edit a controlled read-only field can be handed: the value
    // must survive it.
    fireEvent.change(field, { target: { value: 'someone-elses-org' } });
    expect(urlField().value).toBe('moooon');
  });

  it('renders the motir.co/ prefix with no call-site ink override', () => {
    renderCard();
    // The affix ink is the `Input`'s job now — the read-only state routes it to
    // --el-text-secondary, which clears AA on the read-only fill. A call site
    // picking its own ink is what could not work: opacity halved whatever it
    // chose.
    const affix = screen.getByText('motir.co/');
    expect(affix.className).toBe('');
    expect(affix.parentElement?.className).toContain('text-(--el-text-secondary)');
  });

  it('leaves the organization NAME editable — read-only is the URL only', () => {
    renderCard();
    const name = screen.getByLabelText('Organization name') as HTMLInputElement;
    expect(name.readOnly).toBe(false);
    expect(name.disabled).toBe(false);
    fireEvent.change(name, { target: { value: 'moooon B.V.' } });
    expect((screen.getByLabelText('Organization name') as HTMLInputElement).value).toBe(
      'moooon B.V.',
    );
  });
});
