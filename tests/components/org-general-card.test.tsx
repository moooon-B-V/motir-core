// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  OrgGeneralCard,
  type OrgGeneralCardProps,
} from '@/app/(authed)/settings/organization/_components/OrgGeneralCard';
import { locales, localeLabel } from '@/lib/i18n/locales';

// The org-settings General card: the organization's NAME, and since MOTIR-8095
// its CONTENT LANGUAGE (`design/org-admin/org-admin--content-language.mock.html`).
//
// The Organization URL row is gone (MOTIR-2548, `docs/decisions/organization-url.md`),
// and this suite asserts the ABSENCE deliberately rather than only asserting that
// the name field is present: a card that rendered the URL row AND the name row
// would satisfy the weaker check.
//
// The content-language cases drive one Save: an unchanged language saves the
// name as before; a changed one opens the confirm FIRST, sends nothing until
// Confirm, and a refused request puts the select back on the stored value.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(props: Partial<OrgGeneralCardProps> = {}) {
  return render(
    <ToastProvider>
      <OrgGeneralCard
        orgId="org1"
        initialName="moooon"
        role="owner"
        workspaceCount={3}
        memberCount={14}
        contentLanguage="en"
        canEdit
        {...props}
      />
    </ToastProvider>,
  );
}

const languageTrigger = () => screen.getByRole('combobox', { name: 'Content language' });

function pick(label: string) {
  fireEvent.click(languageTrigger());
  fireEvent.click(screen.getByRole('option', { name: label }));
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const calls = () => fetchMock.mock.calls.map(([url, init]) => [url, init?.body]);

describe('OrgGeneralCard', () => {
  it('tells the one Owner "You’re the owner" (MOTIR-6313 — never "an owner")', () => {
    renderCard();
    expect(screen.getByText('You’re the owner')).toBeTruthy();
    expect(screen.queryByText('You’re an owner')).toBeNull();
  });

  it('renders the organization NAME as its only text field', () => {
    renderCard();
    const name = screen.getByLabelText('Organization name') as HTMLInputElement;
    expect(name.value).toBe('moooon');
    expect(name.readOnly).toBe(false);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('renders NO Organization URL field, by label or by affix', () => {
    renderCard();
    expect(screen.queryByLabelText('Organization URL')).toBeNull();
    expect(screen.queryByText('Organization URL')).toBeNull();
    expect(screen.queryByText('motir.co/')).toBeNull();
  });

  it('still shows the workspace + member summary and the Save control', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
    expect(screen.getByText(/14/)).toBeTruthy();
  });
});

describe('OrgGeneralCard — Content language (MOTIR-8095)', () => {
  it('offers exactly the eleven locales, each in its own script, with the stored one selected', () => {
    renderCard({ contentLanguage: 'zh' });
    expect(languageTrigger().textContent).toContain('中文');
    fireEvent.click(languageTrigger());
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent?.trim())).toEqual(locales.map((l) => localeLabel[l]));
    expect(screen.getByRole('option', { name: '中文' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a changed language opens the confirm on Save, naming both languages, and sends nothing', () => {
    renderCard();
    pick('日本語');
    save();
    const dialog = screen.getByRole('dialog', { name: 'Change the content language?' });
    expect(within(dialog).getAllByText('English').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('日本語').length).toBeGreaterThan(0);
    expect(
      within(dialog).getByText(/Work that already exists keeps its text and its language/),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Confirm PATCHes the content-language route, then toasts and refreshes', async () => {
    renderCard();
    pick('日本語');
    save();
    fireEvent.click(screen.getByRole('button', { name: 'Change to 日本語' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls()).toEqual([
      ['/api/organizations/org1/content-language', JSON.stringify({ language: 'ja' })],
    ]);
    expect(await screen.findByText('Organization updated')).toBeTruthy();
    expect(languageTrigger().textContent).toContain('日本語');
  });

  it('Confirm also saves a changed name, after the language', async () => {
    renderCard();
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });
    pick('Deutsch');
    save();
    fireEvent.click(screen.getByRole('button', { name: 'Change to Deutsch' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls()).toEqual([
      ['/api/organizations/org1/content-language', JSON.stringify({ language: 'de' })],
      ['/api/organizations/org1', JSON.stringify({ name: 'Acme' })],
    ]);
  });

  it.each([
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    [
      'Escape',
      () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' }),
    ],
  ])('%s closes the confirm, sends nothing and restores the stored value', async (_, dismiss) => {
    renderCard();
    pick('日本語');
    save();
    dismiss();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(languageTrigger().textContent).toContain('English');
  });

  it.each([
    ['a refused request', () => fetchMock.mockResolvedValue(new Response('{}', { status: 403 }))],
    ['a network error', () => fetchMock.mockRejectedValue(new TypeError('offline'))],
  ])('%s reverts the select and shows the error toast', async (_, arrange) => {
    arrange();
    renderCard();
    pick('日本語');
    save();
    fireEvent.click(screen.getByRole('button', { name: 'Change to 日本語' }));
    expect(await screen.findByText('Couldn’t save changes')).toBeTruthy();
    expect(languageTrigger().textContent).toContain('English');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('an unchanged language saves the name alone, with no confirm', async () => {
    renderCard();
    fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Acme' } });
    save();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls()).toEqual([['/api/organizations/org1', JSON.stringify({ name: 'Acme' })]]);
  });

  it('attributes the latest change under the control, and names a departed person', () => {
    const { unmount } = renderCard({
      contentLanguage: 'ja',
      latestContentLanguageChange: {
        fromLanguage: 'en',
        toLanguage: 'ja',
        changedAt: '2026-10-11T09:00:00.000Z',
        changedByLabel: 'Lin Wei',
      },
    });
    expect(screen.getByText(/Changed from English by Lin Wei on/)).toBeTruthy();
    unmount();

    renderCard({
      latestContentLanguageChange: {
        fromLanguage: 'ja',
        toLanguage: 'en',
        changedAt: '2026-10-11T09:00:00.000Z',
        changedByLabel: null,
      },
    });
    expect(screen.getByText(/Changed from 日本語 by a former member on/)).toBeTruthy();
  });

  it('shows no attribution when the language was never changed', () => {
    renderCard();
    expect(screen.queryByText(/Changed from/)).toBeNull();
  });

  it('read-only: the value and helper text, no select and no Save', () => {
    renderCard({ canEdit: false, contentLanguage: 'zh' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByText('中文').getAttribute('lang')).toBe('zh');
    expect(screen.getByText(/write this organization’s new work in/)).toBeTruthy();
  });
});
