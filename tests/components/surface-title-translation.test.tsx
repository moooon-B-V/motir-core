// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitle,
  SurfaceTitleTranslationProvider,
  SurfaceTitlesNotice,
  useSurfaceTitleResolver,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';

// THE TITLE SURFACES UNDER AUTO-TRANSLATE (Story MOTIR-7738 · MOTIR-8833; design
// MOTIR-8824): one request per batch of titles, a mark on a differing title, ONE
// Show original switch, ONE no-credit notice, and nothing at all with the switch off.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ctx(over: Partial<AutoTranslateContextDTO> = {}): AutoTranslateContextDTO {
  return {
    autoTranslateWorkContent: true,
    targetLanguage: 'ko',
    credit: 'ok',
    canAddCredit: false,
    ...over,
  };
}

const ROWS = [
  { id: 'a', title: 'Build the export' },
  { id: 'b', title: '이미 한국어' },
];

function answer(titles: unknown[] = [], over: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ targetLanguage: 'ko', enabled: true, truncated: false, titles, ...over }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
const ready = (id: string, text: string) => ({
  workItemId: id,
  fieldRef: `${id}:title`,
  status: 'ready',
  text,
  sourceLanguage: 'en',
});

function Surface({
  rows = ROWS,
  context,
}: {
  rows?: typeof ROWS;
  context: AutoTranslateContextDTO | null;
}) {
  return (
    <SurfaceTitleTranslationProvider projectKey="MOTIR" context={context}>
      <SurfaceShowOriginalSwitch />
      <SurfaceTitlesNotice />
      <ul>
        {rows.map((r) => (
          <li key={r.id} data-testid={`row-${r.id}`}>
            <SurfaceTitle id={r.id} title={r.title} />
          </li>
        ))}
      </ul>
    </SurfaceTitleTranslationProvider>
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('with the switch on', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => answer([ready('a', '내보내기 만들기')]));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends ONE request for the titles on screen, with only the ids', async () => {
    render(<Surface context={ctx()} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/MOTIR/translate-titles');
    expect(JSON.parse(init.body as string)).toEqual({ workItemIds: ['a', 'b'] });
  });

  it('draws the translated title with its mark, leaves an already-translated one alone', async () => {
    render(<Surface context={ctx()} />);
    await settle();
    const a = screen.getByTestId('row-a');
    expect(a.textContent).toContain('내보내기 만들기');
    expect(a.querySelector('[data-title-mark="translated"]')).not.toBeNull();
    expect(a.querySelector('[lang="ko"]')).not.toBeNull();
    const b = screen.getByTestId('row-b');
    expect(b.textContent).toBe('이미 한국어');
    expect(b.querySelector('[data-title-mark]')).toBeNull();
  });

  it('offers Show original once, and swaps without another request', async () => {
    render(<Surface context={ctx()} />);
    await settle();
    const sw = screen.getByRole('button', { name: 'Show original' });
    expect(sw.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sw);
    expect(screen.getByTestId('row-a').textContent).toBe('Build the export');
    expect(
      screen.getByRole('button', { name: 'Show translation' }).getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByTestId('row-a').textContent).toContain('내보내기 만들기');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('batches a later row into its own single request and asks only for the new id', async () => {
    const { rerender } = render(<Surface context={ctx()} />);
    await settle();
    fetchMock.mockImplementationOnce(async () => answer([ready('c', '세 번째')]));
    rerender(<Surface context={ctx()} rows={[...ROWS, { id: 'c', title: 'Third one' }]} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      workItemIds: ['c'],
    });
    expect(screen.getByTestId('row-c').textContent).toContain('세 번째');
  });

  it('re-asks only an id whose stored title changed', async () => {
    const { rerender } = render(<Surface context={ctx()} />);
    await settle();
    fetchMock.mockImplementationOnce(async () => answer([ready('a', '새 제목')]));
    rerender(
      <Surface context={ctx()} rows={[{ id: 'a', title: 'Build the export v2' }, ROWS[1]]} />,
    );
    await settle();
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      workItemIds: ['a'],
    });
    expect(screen.getByTestId('row-a').textContent).toContain('새 제목');
  });

  it('shows the stored title with no mark and no switch when the request fails', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    render(<Surface context={ctx()} />);
    await settle();
    expect(screen.getByTestId('row-a').textContent).toBe('Build the export');
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Some titles could not be translated');
  });

  it('announces in ONE polite live region', async () => {
    render(<Surface context={ctx()} />);
    await settle();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toBe('Titles translated');
  });
});

describe('no credit', () => {
  it('shows the notice, makes no request, and shows stored titles; Add credit only when allowed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<Surface context={ctx({ credit: 'no_credit' })} />);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    const notice = document.querySelector('[data-titles-notice="no-credit"]')!;
    expect(notice.textContent).toContain('no credit left');
    expect(notice.querySelector('a')).toBeNull();
    expect(screen.getByTestId('row-a').textContent).toBe('Build the export');
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull();
    unmount();
    render(<Surface context={ctx({ credit: 'no_credit', canAddCredit: true })} />);
    await settle();
    expect(screen.getByRole('link', { name: 'Add credit' }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
  });

  it('turns a no_credit answer into the notice and the stored text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer([{ workItemId: 'a', fieldRef: 'x', status: 'no_credit' }])),
    );
    render(<Surface context={ctx()} />);
    await settle();
    expect(document.querySelector('[data-titles-notice="no-credit"]')).not.toBeNull();
    expect(screen.getByTestId('row-a').textContent).toBe('Build the export');
  });
});

describe('with the switch off or no context', () => {
  it.each([
    ['a null context (a Visitor)', null],
    ['an off switch', ctx({ autoTranslateWorkContent: false })],
  ])(
    'mounts nothing for %s: stored titles, no request, no switch, no notice, no live region',
    async (_n, context) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      render(<Surface context={context} />);
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('row-a').textContent).toBe('Build the export');
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(document.querySelector('[data-titles-notice]')).toBeNull();
    },
  );
});

describe('useSurfaceTitleResolver', () => {
  function Label({ id, title }: { id: string; title: string }) {
    const resolve = useSurfaceTitleResolver();
    return <span data-testid="label">{resolve(id, title).name}</span>;
  }

  it('names a translated title with what the mark means', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer([ready('a', '내보내기 만들기')])),
    );
    render(
      <SurfaceTitleTranslationProvider projectKey="MOTIR" context={ctx()}>
        <SurfaceTitle id="a" title="Build the export" />
        <Label id="a" title="Build the export" />
      </SurfaceTitleTranslationProvider>,
    );
    await settle();
    expect(screen.getByTestId('label').textContent).toBe(
      '내보내기 만들기. Translated from English',
    );
  });

  it('is the stored text without a provider', () => {
    render(<Label id="a" title="Build the export" />);
    expect(screen.getByTestId('label').textContent).toBe('Build the export');
  });
});
