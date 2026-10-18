// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { AutoTranslateContextDTO } from '@/lib/dto/autoTranslate';
import type { ReaderTranslationDTO, TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import { TranslationProvider } from '@/app/(authed)/items/[key]/_components/translation/TranslationProvider';
import { TranslateControl } from '@/app/(authed)/items/[key]/_components/translation/TranslateControl';
import { FieldTranslationMark } from '@/app/(authed)/items/[key]/_components/translation/FieldTranslationMark';
import { TranslatableTitle } from '@/app/(authed)/items/[key]/_components/translation/TranslatableFields';
import { initialTranslationState } from '@/app/(authed)/items/[key]/_components/translation/translationReducer';

// AUTO-TRANSLATE ON THE OPENED WORK ITEM (Story MOTIR-7738 · MOTIR-8832; design
// MOTIR-8823 A1–A6). With the project's switch on, the host runs the press AT
// MOUNT: the bar opens busy (never the offered face), the request is the press's
// own, nothing is announced when it starts, and a context that says the
// organisation cannot pay makes no request and takes no focus.

afterEach(cleanup);

const OFFER: TranslationOfferDTO = {
  targetLanguage: 'ko',
  anyNeedsTranslation: true,
  fields: {
    title: { needsTranslation: true, kept: false, sourceLanguage: 'en', revision: 'r1' },
    description: { needsTranslation: true, kept: false, sourceLanguage: 'en', revision: 'r1' },
    explanation: { needsTranslation: false, kept: false, sourceLanguage: 'ko', revision: 'r1' },
  },
};

/** Only an undrawn field differs (the quick view's second case). */
const EXPLANATION_ONLY: TranslationOfferDTO = {
  targetLanguage: 'ko',
  anyNeedsTranslation: true,
  fields: {
    title: { needsTranslation: false, kept: false, sourceLanguage: 'ko', revision: 'r1' },
    description: { needsTranslation: false, kept: false, sourceLanguage: 'ko', revision: 'r1' },
    explanation: { needsTranslation: true, kept: false, sourceLanguage: 'en', revision: 'r1' },
  },
};

function auto(over: Partial<AutoTranslateContextDTO> = {}): AutoTranslateContextDTO {
  return {
    autoTranslateWorkContent: true,
    targetLanguage: 'ko',
    credit: 'ok',
    canAddCredit: false,
    ...over,
  };
}

function Harness({
  offer = OFFER,
  autoContext,
  canAddCredits = false,
  fields,
}: {
  offer?: TranslationOfferDTO;
  autoContext?: AutoTranslateContextDTO | null;
  canAddCredits?: boolean;
  fields?: readonly string[];
}) {
  const translation: ReaderTranslationDTO = { offer, canAddCredits, auto: autoContext };
  return (
    <TranslationProvider itemId="item-1" translation={translation} fields={fields}>
      <h1>
        <TranslatableTitle title="Build the export" projectIdentifier="MOTIR" workItemRefs={{}} />
      </h1>
      <FieldTranslationMark fieldRef="title" field="title" />
      <TranslateControl />
    </TranslationProvider>
  );
}

function ok(fields: unknown[]) {
  return { ok: true, json: async () => ({ targetLanguage: 'ko', fields }) } as Response;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const live = (c: HTMLElement) => c.querySelector('[data-translation-live]')!;
const bar = (c: HTMLElement) => c.querySelector('[data-translation-bar]');

describe('the auto start', () => {
  it('opens on the busy face and never renders Translate, then lands in the reader’s language', async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValue(d.promise);
    const { container } = render(<Harness autoContext={auto()} />);

    // First paint: busy, the offered face unreachable, the stored title in place.
    expect(bar(container)!.getAttribute('data-translation-bar')).toBe('busy');
    expect(screen.queryByRole('button', { name: 'Translate' })).toBeNull();
    const busy = screen.getByRole('button', { name: /Translating/ });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('heading').textContent).toBe('Build the export');
    expect(container.querySelectorAll('[data-translation-mark="loading"]')).toHaveLength(1);

    // The request is the press's own: one POST naming only the item.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/work-items/item-1/translate');
    expect(fetchMock.mock.calls[0]![1]).toEqual({ method: 'POST' });
    // Nothing is announced when the request starts (design A5).
    expect(live(container).textContent).toBe('');

    await act(async () => {
      d.resolve(
        ok([
          { fieldRef: 'title', status: 'ready', text: '내보내기 만들기' },
          { fieldRef: 'description', status: 'ready', text: '설명' },
        ]),
      );
    });

    expect(screen.getByRole('heading').textContent).toBe('내보내기 만들기');
    expect(screen.getByRole('button', { name: 'Show original' })).toBeTruthy();
    // The settled line is announced ONCE.
    expect(live(container).textContent).toBe('Translated into Korean.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Show original and Show translation issue no request in either direction', async () => {
    fetchMock.mockResolvedValue(ok([{ fieldRef: 'title', status: 'ready', text: '제목' }]));
    render(<Harness autoContext={auto()} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: 'Show original' }));
    expect(screen.getByRole('heading').textContent).toBe('Build the export');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByRole('heading').textContent).toBe('제목');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed attempt keeps the stored text, offers Retry, and a retry reaches the translated view', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(ok([{ fieldRef: 'title', status: 'ready', text: '제목' }]));
    const { container } = render(<Harness autoContext={auto()} />);
    await act(async () => {});

    expect(bar(container)!.getAttribute('data-translation-bar')).toBe('failed');
    expect(screen.getByRole('heading').textContent).toBe('Build the export');
    expect(container.querySelector('[data-translation-message="failed"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading').textContent).toBe('제목');
  });
});

describe('no credit, known before any request', () => {
  it('makes NO request, draws the notice on the first paint, and takes no focus', async () => {
    const { container } = render(
      <Harness autoContext={auto({ credit: 'no_credit', canAddCredit: true })} canAddCredits />,
    );
    await act(async () => {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bar(container)!.getAttribute('data-translation-bar')).toBe('no-credit');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: /Add credits/ }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
    // Focus stays where the browser put it; nothing is announced.
    expect(document.activeElement).toBe(document.body);
    expect(live(container).textContent).toBe('');
    expect(screen.getByRole('heading').textContent).toBe('Build the export');
    expect(container.querySelectorAll('[data-translation-mark]')).toHaveLength(0);
  });

  it('shows a member the line without the link', async () => {
    render(<Harness autoContext={auto({ credit: 'no_credit' })} canAddCredits={false} />);
    await act(async () => {});
    expect(screen.queryByRole('link', { name: /Add credits/ })).toBeNull();
    expect(screen.getByText(/An organization owner or admin can add them\./)).toBeTruthy();
  });

  it('a no-credit answer to an auto request does not take focus either — the reader pressed nothing', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { fieldRef: 'title', status: 'no_credit' },
        { fieldRef: 'description', status: 'no_credit' },
      ]),
    );
    const { container } = render(<Harness autoContext={auto()} />);
    await act(async () => {});
    expect(bar(container)!.getAttribute('data-translation-bar')).toBe('no-credit');
    expect(document.activeElement).toBe(document.body);
  });

  it('on demand, a PRESSED button that meets no-credit still hands focus to the message', async () => {
    fetchMock.mockResolvedValue(ok([{ fieldRef: 'title', status: 'no_credit' }]));
    render(<Harness autoContext={null} />);
    const button = screen.getByRole('button', { name: 'Translate' });
    button.focus();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(document.activeElement?.getAttribute('data-translation-message')).toBe('no-credit');
  });
});

describe('nothing is asked for that is not needed', () => {
  it('a reader whose language matches every recorded language fires no request and draws no bar', async () => {
    const same: TranslationOfferDTO = {
      targetLanguage: 'ko',
      anyNeedsTranslation: false,
      fields: {
        title: { needsTranslation: false, kept: false, sourceLanguage: 'ko', revision: 'r1' },
      },
    };
    const { container } = render(<Harness offer={same} autoContext={auto()} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bar(container)).toBeNull();
  });

  it('the quick view with only an undrawn field differing draws nothing and fires nothing', async () => {
    const { container } = render(
      <Harness offer={EXPLANATION_ONLY} autoContext={auto()} fields={['title', 'description']} />,
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bar(container)).toBeNull();
    expect(container.querySelectorAll('[data-translation-mark]')).toHaveLength(0);
  });

  it('the quick view marks only what it draws, and still asks for the item once', async () => {
    const wide: TranslationOfferDTO = {
      ...OFFER,
      fields: {
        ...OFFER.fields,
        explanation: { needsTranslation: true, kept: false, sourceLanguage: 'en', revision: 'r1' },
      },
    };
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(
      <Harness offer={wide} autoContext={auto()} fields={['title', 'description']} />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The harness draws one mark (the title's); the undrawn explanation adds none.
    expect(container.querySelectorAll('[data-translation-mark="loading"]')).toHaveLength(1);
  });

  it('with the switch OFF the on-demand host is unchanged: Translate offered, nothing sent', async () => {
    const { container } = render(
      <Harness autoContext={auto({ autoTranslateWorkContent: false })} />,
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bar(container)!.getAttribute('data-translation-bar')).toBe('offered');
    expect(screen.getByRole('button', { name: 'Translate' })).toBeTruthy();
  });

  it('a context-less host (no auto at all) is the shipped on-demand host', async () => {
    render(<Harness />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Translate' })).toBeTruthy();
  });
});

describe('initialTranslationState', () => {
  it('on demand: idle, original shown, not pressed', () => {
    const s = initialTranslationState(OFFER);
    expect(s.busy).toBe(false);
    expect(s.pressed).toBe(false);
    expect(Object.values(s.fields).every((f) => f.state === 'idle')).toBe(true);
  });

  it('auto start: pending, busy and pressed from the first state', () => {
    const s = initialTranslationState(OFFER, 'start');
    expect(s.busy).toBe(true);
    expect(s.pressed).toBe(true);
    expect(s.view).toBe('translated');
    expect(Object.keys(s.fields)).toEqual(['title', 'description']);
    expect(Object.values(s.fields).every((f) => f.state === 'pending')).toBe(true);
  });

  it('auto no_credit: every differing field in no_credit, not busy, not pressed', () => {
    const s = initialTranslationState(OFFER, 'no_credit');
    expect(s.busy).toBe(false);
    expect(s.pressed).toBe(false);
    expect(Object.values(s.fields).every((f) => f.state === 'no_credit')).toBe(true);
  });
});
