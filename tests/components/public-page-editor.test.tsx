// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  PUBLIC_TAGLINE_MAX_LENGTH,
  PUBLIC_TAGS_MAX_COUNT,
  PUBLIC_TAG_MAX_LENGTH,
} from '@/lib/publicProjects/limits';

// The Public page room's island (Story MOTIR-3875 · MOTIR-4171) —
// `design/projects/public-page.mock.html` Panel B and the six states of Panel C,
// per `design/projects/design-notes.md` § *Public page — the room in project
// settings*. Driven under happy-dom (DB-free): the island is a pure client
// consumer of `PATCH /api/projects/[key]/public-overview`, so `fetch` is
// stubbed and the design's states are asserted:
//   C1  empty — placeholders, *No tags yet*, `0 / 8 tags`, the auto-intro
//       helper, both actions disabled;
//   C2  unsaved changes — the hint, Cancel reverts to the saved baseline;
//   C3  saving — *Saving…*, both actions disabled, one in-flight write;
//   C4  per-field errors — the caps checked as the reader types, AND a typed
//       422 from the door landing under the field it names; a failure that is
//       neither is the toast, with the edits kept;
//   C5  saved — *Saved* in the footer, nothing refreshed;
//   C6  not yet public — the band with its link, no *View public page*.
// Plus the tag-chip control (add / remove / the caps) and the unsaved-changes
// guard (an in-app link click asks first; *Discard* leaves, *Keep editing*
// stays; a hard navigation is refused through `beforeunload`).

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/project/public',
  useSearchParams: () => new URLSearchParams(),
}));

// The editor is tiptap; the island only needs a controlled text surface.
vi.mock('@/components/ui/MarkdownEditor', () => ({
  MarkdownEditor: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
  }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import {
  PublicPageEditor,
  publicHeroEqual,
  type PublicHeroValues,
} from '@/app/(authed)/settings/project/public/_components/PublicPageEditor';

const fetchMock = vi.fn();

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

function mount(
  initial: Partial<PublicHeroValues> = {},
  props: { isPublic?: boolean; publicPageUrl?: string } = {},
) {
  return render(
    <>
      <a href="/settings/project/members">Members &amp; access (rail)</a>
      <a href="https://motir.co/p/PROD" target="_blank" rel="noreferrer">
        Somewhere else
      </a>
      <PublicPageEditor
        projectKey="PROD"
        initial={{ publicOverviewMd: null, publicTagline: null, publicTags: [], ...initial }}
        isPublic={props.isPublic ?? true}
        publicPageUrl={props.publicPageUrl ?? 'https://motir.co/p/PROD'}
      />
    </>,
  );
}

const populated: PublicHeroValues = {
  publicOverviewMd: '# Motir\n\nA README body.',
  publicTagline: 'The planning platform.',
  publicTags: ['planning', 'agents'],
};

const tagline = () => screen.getByLabelText('Tagline') as HTMLInputElement;
const readme = () => screen.getByLabelText('README') as HTMLTextAreaElement;
const saveButton = () => screen.getByTestId('public-page-save') as HTMLButtonElement;
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
const hint = () => screen.getByTestId('public-page-footer-hint');

function lastPatch(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1], body: JSON.parse(String(call[1].body)) };
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('publicHeroEqual', () => {
  it('is order-sensitive on tags and exact on the two strings', () => {
    const a = { tagline: 'x', tags: ['a', 'b'], readme: 'r' };
    expect(publicHeroEqual(a, { ...a, tags: ['a', 'b'] })).toBe(true);
    expect(publicHeroEqual(a, { ...a, tags: ['b', 'a'] })).toBe(false);
    expect(publicHeroEqual(a, { ...a, readme: 'r ' })).toBe(false);
  });
});

describe('C1 · empty', () => {
  it('renders placeholders, the caps as helpers, *No tags yet*, the count, and both actions disabled', () => {
    mount();

    expect(tagline().value).toBe('');
    expect(tagline().placeholder).toBe('One sentence about what this project is');
    expect(
      screen.getByText(
        `Shown under the project’s name. Up to ${PUBLIC_TAGLINE_MAX_LENGTH} characters.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText('No tags yet')).toBeTruthy();
    expect(screen.getByText(`0 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();
    expect(
      screen.getByText(
        `Up to ${PUBLIC_TAGS_MAX_COUNT} tags, ${PUBLIC_TAG_MAX_LENGTH} characters each.`,
      ),
    ).toBeTruthy();
    expect(readme().value).toBe('');
    // The auto-intro helper — what the public page shows instead of a README.
    expect(screen.getByText(/shows a short automatic introduction/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    expect(hint().textContent).toBe('');
  });
});

describe('Panel B · populated, and the head link', () => {
  it('seeds the three fields from the read and links the PUBLIC host in the head', () => {
    mount(populated, { publicPageUrl: 'https://motir.co/p/PROD' });

    expect(tagline().value).toBe('The planning platform.');
    expect(readme().value).toBe('# Motir\n\nA README body.');
    expect(screen.getByText('planning')).toBeTruthy();
    expect(screen.getByText('agents')).toBeTruthy();
    expect(screen.getByText(`2 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();
    // The README helper carries the cap once something is written.
    expect(screen.getByText(/Markdown\. Up to 50,000 characters/)).toBeTruthy();

    const view = screen.getByTestId('public-page-view-link') as HTMLAnchorElement;
    expect(view.getAttribute('href')).toBe('https://motir.co/p/PROD');
    expect(view.target).toBe('_blank');
    expect(screen.queryByTestId('public-page-not-public')).toBeNull();
  });
});

describe('C6 · not yet public', () => {
  it('shows the band with its link to Members & access, and no *View public page*', () => {
    mount(populated, { isPublic: false });

    const band = screen.getByTestId('public-page-not-public');
    expect(within(band).getByText('Not building in public yet.')).toBeTruthy();
    const link = within(band).getByRole('link', { name: 'Members & access' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/project/members');
    expect(screen.queryByTestId('public-page-view-link')).toBeNull();
    // The room is fully usable: the fields are live.
    expect(tagline().disabled).toBe(false);
  });
});

describe('C2 · unsaved changes', () => {
  it('shows the hint on an edit and Cancel reverts to the saved baseline', () => {
    mount(populated);

    fireEvent.change(tagline(), { target: { value: 'Changed' } });
    expect(hint().textContent).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(false);

    fireEvent.click(cancelButton());
    expect(tagline().value).toBe('The planning platform.');
    expect(hint().textContent).toBe('');
    expect(saveButton().disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the tag-chip control', () => {
  it('adds a tag on Enter, removes one from its chip, and counts', () => {
    mount({ publicTags: ['planning'] });

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    const draft = screen.getByTestId('public-page-tag-draft') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: '  design ' } });
    fireEvent.keyDown(draft, { key: 'Enter' });

    expect(screen.getByText('design')).toBeTruthy();
    expect(screen.getByText(`2 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();
    expect(screen.queryByTestId('public-page-tag-draft')).toBeNull();
    expect(hint().textContent).toBe('Unsaved changes');

    fireEvent.click(screen.getByRole('button', { name: 'Remove planning' }));
    expect(screen.queryByText('planning')).toBeNull();
    expect(screen.getByText(`1 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();
  });

  it('Escape cancels the draft, and a duplicate is not added twice', () => {
    mount({ publicTags: ['planning'] });

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    fireEvent.change(screen.getByTestId('public-page-tag-draft'), { target: { value: 'x' } });
    fireEvent.keyDown(screen.getByTestId('public-page-tag-draft'), { key: 'Escape' });
    expect(screen.queryByTestId('public-page-tag-draft')).toBeNull();
    expect(screen.queryByText('x')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    fireEvent.change(screen.getByTestId('public-page-tag-draft'), {
      target: { value: 'Planning' },
    });
    fireEvent.keyDown(screen.getByTestId('public-page-tag-draft'), { key: 'Enter' });
    expect(screen.getAllByText(/planning/i)).toHaveLength(1);
    expect(screen.getByText(`1 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();
  });

  it('refuses a tag over the length cap at the field, and disables Add at the count cap', () => {
    mount({ publicTags: ['planning'] });

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    fireEvent.change(screen.getByTestId('public-page-tag-draft'), {
      target: { value: 'x'.repeat(PUBLIC_TAG_MAX_LENGTH + 1) },
    });
    fireEvent.keyDown(screen.getByTestId('public-page-tag-draft'), { key: 'Enter' });

    expect(screen.getByRole('alert').textContent).toBe(
      `Each tag must be ${PUBLIC_TAG_MAX_LENGTH} characters or fewer, and there can be at most ${PUBLIC_TAGS_MAX_COUNT}.`,
    );
    // The draft stays open for the reader to fix it; nothing was added.
    expect(screen.getByTestId('public-page-tag-draft')).toBeTruthy();
    expect(screen.getByText(`1 / ${PUBLIC_TAGS_MAX_COUNT} tags`)).toBeTruthy();

    cleanup();
    mount({ publicTags: Array.from({ length: PUBLIC_TAGS_MAX_COUNT }, (_, i) => `t${i}`) });
    expect((screen.getByRole('button', { name: 'Add tag' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('C4 · per-field errors', () => {
  it('a tagline over the cap is refused at the field as the reader types, and blocks Save', () => {
    mount(populated);

    fireEvent.change(tagline(), { target: { value: 'x'.repeat(PUBLIC_TAGLINE_MAX_LENGTH + 1) } });

    expect(screen.getByRole('alert').textContent).toBe(
      `Too long — ${PUBLIC_TAGLINE_MAX_LENGTH} characters at most.`,
    );
    expect(tagline().getAttribute('aria-invalid')).toBe('true');
    expect(hint().textContent).toBe('Fix the highlighted fields to save');
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(tagline(), { target: { value: 'short again' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('a typed 422 from the door lands under the field it names, in the catalog’s copy, and the edits are kept', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'A tag is too long.',
          code: 'PROJECT_TAGS_INVALID',
          field: 'publicTags',
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );
    mount(populated);

    fireEvent.change(tagline(), { target: { value: 'Edited tagline' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toBe(
      `Each tag must be ${PUBLIC_TAG_MAX_LENGTH} characters or fewer, and there can be at most ${PUBLIC_TAGS_MAX_COUNT}.`,
    );
    // Not the server's English.
    expect(screen.queryByText('A tag is too long.')).toBeNull();
    expect(tagline().value).toBe('Edited tagline');
    expect(hint().textContent).toBe('Fix the highlighted fields to save');
    expect(saveButton().disabled).toBe(true);

    // Touching the named field clears its server error.
    fireEvent.click(screen.getByRole('button', { name: 'Remove agents' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('a failure that names no field is the toast, and the edits are kept', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    mount(populated);

    fireEvent.change(tagline(), { target: { value: 'Edited tagline' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText('Couldn’t save the public page. Try again.')).toBeTruthy(),
    );
    expect(tagline().value).toBe('Edited tagline');
    expect(hint().textContent).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);
  });
});

describe('C3 · saving → C5 · saved', () => {
  it('sends ONE PATCH carrying all three fields (an emptied tagline as null), shows *Saving…*, then *Saved*', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    mount(populated);

    fireEvent.change(tagline(), { target: { value: '   ' } });
    fireEvent.change(readme(), { target: { value: '# New body' } });
    fireEvent.click(saveButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = lastPatch();
    expect(url).toBe('/api/projects/PROD/public-overview');
    expect(init.method).toBe('PATCH');
    expect(body).toEqual({
      publicOverviewMd: '# New body',
      publicTagline: null,
      publicTags: ['planning', 'agents'],
    });

    expect(screen.getByRole('status').textContent).toBe('Saving…');
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    expect(tagline().disabled).toBe(true);

    await act(async () => {
      resolve(new Response(null, { status: 204 }));
    });

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'));
    // The success response IS the confirmation — the values stay, the baseline moved.
    expect(readme().value).toBe('# New body');
    expect(cancelButton().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    // Nothing re-read the page.
    expect(push).not.toHaveBeenCalled();
  });
});

describe('the unsaved-changes guard', () => {
  it('an in-app link click with edits pending asks first; *Keep editing* stays, *Discard* leaves', async () => {
    mount(populated);
    fireEvent.change(tagline(), { target: { value: 'Edited' } });

    fireEvent.click(screen.getByRole('link', { name: 'Members & access (rail)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Discard unsaved changes?')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(tagline().value).toBe('Edited');
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Members & access (rail)' }));
    fireEvent.click(await screen.findByTestId('public-page-discard'));
    expect(push).toHaveBeenCalledWith('/settings/project/members');
    expect(tagline().value).toBe('The planning platform.');
  });

  it('does not intercept a link that opens elsewhere, and asks nothing while clean', () => {
    mount(populated);
    fireEvent.click(screen.getByRole('link', { name: 'Members & access (rail)' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.change(tagline(), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('link', { name: 'Somewhere else' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('refuses a hard navigation through beforeunload only while dirty', () => {
    mount(populated);

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(tagline(), { target: { value: 'Edited' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
