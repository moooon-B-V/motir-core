// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { VisitorLinkCard } from '@/app/(authed)/settings/project/public/_components/VisitorLinkCard';

// The Visitor link card (Story MOTIR-6170 · MOTIR-6649) — panel 11 of
// `design/projects/public-page--visitor-link.mock.html`. Its two states are a
// function of the one prop the server hands it: an address while the project is
// Public, `null` otherwise. The cloud-off state is not the card's: off-cloud the
// whole room 404s before anything renders (`tests/settings/publicPageRoom.test.ts`).

const copy = enMessages.settings.publicPage.visitorLink;
const URL = 'https://app.motir.co/p/PROD/board';

function mount(visitorUrl: string | null, messages: Record<string, unknown> = enMessages) {
  return renderWithIntl(
    <ToastProvider>
      <VisitorLinkCard visitorUrl={visitorUrl} projectName="Prodect" />
    </ToastProvider>,
    { messages, locale: messages === zhMessages ? 'zh' : 'en' },
  );
}

afterEach(() => cleanup());

describe('while the project is Public', () => {
  it('shows the exact link, the hint, and names the project in the subtitle', () => {
    mount(URL);
    expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy();
    expect(screen.getByTestId('visitor-link-url').textContent).toBe(URL);
    expect(screen.getByText(copy.hint)).toBeTruthy();
    expect(screen.getByText('Prodect').tagName).toBe('STRONG');
    expect(screen.queryByTestId('visitor-link-not-public')).toBeNull();
  });

  it('Copy writes that exact string and confirms with the toast', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount(URL);
    fireEvent.click(screen.getByRole('button', { name: copy.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
    expect(await screen.findByText(copy.copied)).toBeTruthy();
  });

  it('Open goes to the link in a new tab', () => {
    mount(URL);
    const open = screen.getByRole('link', { name: copy.open });
    expect(open.getAttribute('href')).toBe(URL);
    expect(open.getAttribute('target')).toBe('_blank');
  });
});

describe('while the project is not Public', () => {
  it('shows no address — only the notice pointing at Members & access', () => {
    mount(null);
    expect(screen.queryByTestId('visitor-link-url')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.copy })).toBeNull();
    expect(screen.queryByRole('link', { name: copy.open })).toBeNull();
    const notice = screen.getByTestId('visitor-link-not-public');
    expect(notice.textContent).toContain(copy.notPublic.lead);
    expect(screen.getByRole('link', { name: 'Members & access' }).getAttribute('href')).toBe(
      '/settings/project/members',
    );
  });
});

describe('both catalogs', () => {
  it('render the card in zh with its own copy', () => {
    mount(URL, zhMessages);
    const zh = zhMessages.settings.publicPage.visitorLink;
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy();
    expect(screen.getByRole('button', { name: zh.copy })).toBeTruthy();
    expect(screen.getByRole('link', { name: zh.open })).toBeTruthy();
  });

  it('carry the same keys', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' ? keys(v).map((s) => `${k}.${s}`) : [k],
      );
    expect(keys(zhMessages.settings.publicPage.visitorLink).sort()).toEqual(keys(copy).sort());
  });
});
