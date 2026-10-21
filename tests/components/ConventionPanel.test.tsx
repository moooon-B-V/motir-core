// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ConventionPanel } from '@/app/(authed)/code/_components/ConventionPanel';
import type { CodingConventionDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// ⚠️ THE PLANNING DOORS READ THE ADDRESS (MOTIR-4730). Every surface that mounts
// one — and this tree mounts one — now calls `usePathname` / `useSearchParams`,
// because the workspace opens OVER the page you are on rather than navigating to
// `/planning`. Outside a router context the real hooks return `null` and the
// door throws on its first render, so the mock is no longer optional here.
const nav = vi.hoisted(() => ({
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

// The Convention tab of /code-health (MOTIR-1663), under happy-dom. This is the
// OBSERVABLE INVERSE of MOTIR-2127: a project whose motir-ai store holds a derived
// convention must render the DOCUMENT + its provenance badges — not the empty
// state the mis-shaped read-back produced for every project on the platform. The
// panel is the last layer that bug passed through, so it is asserted here directly
// rather than only through the mapper.

function convention(over: Partial<CodingConventionDTO> = {}): CodingConventionDTO {
  return {
    id: 'conv_2',
    repoKey: 'acme/web',
    version: 2,
    contentMd: '# House rules\n\n- Route → Service → Repository, never upward.',
    provenance: [
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ],
    authorKind: 'derived',
    editedByName: null,
    editedByUserId: null,
    pendingDerivedMd: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function surface(over: Partial<ConventionSurfaceDTO> = {}): ConventionSurfaceDTO {
  return {
    repoKey: 'acme/web',
    convention: convention(),
    versions: [convention()],
    nextCursor: null,
    ...over,
  };
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const edited = (over: Partial<CodingConventionDTO> = {}) =>
  convention({
    id: 'conv_3',
    version: 3,
    authorKind: 'edited',
    editedByName: 'Ada Lovelace',
    editedByUserId: 'user_1',
    contentMd: '# Our rules',
    provenance: [],
    ...over,
  });

// The toggle button of a repository's card. The repository name is split across a
// muted owner and a strong name, so it is found by its key rather than by text.
function cardHeader(repo: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button[data-card-key="${repo}"]`);
  if (!el) throw new Error(`no card header for ${repo}`);
  return el;
}

describe('ConventionPanel', () => {
  it('renders the derived convention document + provenance badges for a repo that has one', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);

    // The repo header + the derived-version pill.
    expect(cardHeader('acme/web')).toBeTruthy();
    expect(screen.getByText('v2 · derived')).toBeTruthy();
    // The document itself — rendered markdown, not a placeholder.
    expect(screen.getByText('House rules')).toBeTruthy();
    expect(screen.getByText(/Route → Service → Repository/)).toBeTruthy();
    // The byline says where the text came from (derived = auto-used, no approve gate).
    expect(screen.getByText('Derived from the code')).toBeTruthy();
    // Provenance: one Adopted rule, one Proposed rule.
    expect(screen.getByText('Adopted')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('layering.no-upward-imports')).toBeTruthy();
    // ...and NOT the "nothing derived" copy.
    expect(screen.queryByText(/No convention rules have been derived yet/)).toBeNull();
  });

  it('still renders the empty state for a project with no derived convention', () => {
    renderWithIntl(<ConventionPanel conventions={[]} />);

    expect(screen.getByText('No convention yet')).toBeTruthy();
    expect(screen.queryByText('House rules')).toBeNull();
  });

  it('renders the per-repo no-rules copy when a repo card has no convention yet', () => {
    renderWithIntl(<ConventionPanel conventions={[surface({ convention: null, versions: [] })]} />);

    expect(screen.getByText(/No convention rules have been derived yet/)).toBeTruthy();
    expect(screen.queryByText('v2 · derived')).toBeNull();
  });

  it('renders one card per connected repo, keyed by repoKey', () => {
    renderWithIntl(
      <ConventionPanel
        conventions={[
          surface(),
          surface({
            repoKey: 'acme/api',
            convention: convention({ id: 'conv_9', repoKey: 'acme/api', version: 1 }),
            versions: [convention({ id: 'conv_9', repoKey: 'acme/api', version: 1 })],
          }),
        ]}
      />,
    );

    expect(cardHeader('acme/web')).toBeTruthy();
    expect(cardHeader('acme/api')).toBeTruthy();
    expect(screen.getByText('v2 · derived')).toBeTruthy();
    expect(screen.getByText('v1 · derived')).toBeTruthy();
  });

  it('lists version history WITHOUT a lifecycle status, marking the current version', () => {
    const older = convention({ id: 'conv_1', version: 1, createdAt: '2026-07-01T00:00:00.000Z' });
    renderWithIntl(
      <ConventionPanel conventions={[surface({ versions: [convention(), older] })]} />,
      { now: new Date('2026-07-04T00:00:00.000Z') },
    );

    expect(screen.getByText('Version history')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    // Exactly one row is marked current — the latest derived version.
    expect(screen.getAllByText('Current')).toHaveLength(1);
    // The retired approve lifecycle must not reappear (MOTIR-1660/1662).
    expect(screen.queryByText('Standard')).toBeNull();
    expect(screen.queryByText('Superseded')).toBeNull();
    // The older version is dated relative to the pinned `now`.
    expect(screen.getByText('3 days ago')).toBeTruthy();
  });

  it('hides version history when there is only one version', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);

    expect(screen.queryByText('Version history')).toBeNull();
  });

  // ── MOTIR-9082 — the card is editable ──────────────────────────────────────

  it('shows an Edit button, and no Edit button when the viewer cannot configure', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    cleanup();
    renderWithIntl(<ConventionPanel conventions={[surface()]} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('names the editor on an edited version and drops the provenance list', () => {
    const e = edited();
    renderWithIntl(<ConventionPanel conventions={[surface({ convention: e, versions: [e] })]} />, {
      now: new Date('2026-07-05T00:00:00.000Z'),
    });
    expect(screen.getByText('v3 · edited')).toBeTruthy();
    expect(screen.getByText(/Edited by Ada Lovelace/)).toBeTruthy();
    expect(screen.queryByText('Rule provenance')).toBeNull();
  });

  it('offers the first write on an empty repo', () => {
    renderWithIntl(<ConventionPanel conventions={[surface({ convention: null, versions: [] })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Write the convention' }));
    expect(screen.getByText('Editing v0')).toBeTruthy();
    // An empty or whitespace-only draft cannot be saved.
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '  ' },
    });
    expect(
      (screen.getByRole('button', { name: 'Save to web' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Write something to save.')).toBeTruthy();
  });

  it('saves with the base version, returns to the read view and hands up the new surface', async () => {
    const saved = edited({ contentMd: '# Changed' });
    const savedSurface = surface({ convention: saved, versions: [saved] });
    fetchMock.mockResolvedValue(jsonResponse(200, savedSurface));
    const onSaved = vi.fn();
    renderWithIntl(<ConventionPanel conventions={[surface()]} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to web' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedSurface));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/coding-convention/convention');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      repoKey: 'acme/web',
      contentMd: '# Changed',
      baseVersion: 2,
    });
    expect(screen.queryByText('Editing v2')).toBeNull();
  });

  it('keeps the text and says so when the save fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, { code: 'MOTIR_AI_UNAVAILABLE' }));
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to web' }));

    expect(await screen.findByText(/Couldn.t save the convention/)).toBeTruthy();
    expect(
      (screen.getByLabelText('Convention for acme/web (Markdown)') as HTMLTextAreaElement).value,
    ).toBe('# Mine');
  });

  it('cancels back to the read view without calling the server', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Editing v2')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on a 409 shows the conflict, keeps mine as a copy, and loads theirs on request', async () => {
    const winner = edited({ version: 3, contentMd: '# Theirs' });
    const winnerSurface = surface({ convention: winner, versions: [winner] });
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: 'CONVENTION_VERSION_CONFLICT',
        latestVersion: 3,
        latest: winnerSurface,
      }),
    );
    const onSaved = vi.fn();
    renderWithIntl(<ConventionPanel conventions={[surface()]} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to web' }));

    expect(await screen.findByText('Someone saved a newer version')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine as a copy' }));
    expect((screen.getByLabelText(/Your text/) as HTMLTextAreaElement).value).toBe('# Mine');
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load their version' }));
    expect(onSaved).toHaveBeenCalledWith(winnerSurface);
    expect(screen.queryByText('Someone saved a newer version')).toBeNull();
  });

  it('tells an edited version that a newer derived one is waiting, and compares side by side', () => {
    const e = edited({ pendingDerivedMd: '# Derived anew' });
    renderWithIntl(<ConventionPanel conventions={[surface({ convention: e, versions: [e] })]} />);

    expect(screen.getByText('A newer version was derived from the code')).toBeTruthy();
    expect(screen.queryByText('Waiting · derived')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compare side by side' }));
    expect(screen.getByText('Waiting · derived')).toBeTruthy();
    expect(screen.getByText('Derived anew')).toBeTruthy();
  });
});

// ── MOTIR-9194 — the cards are an accordion, one expanded at a time ──────────

describe('ConventionPanel accordion', () => {
  function apiSurface(): ConventionSurfaceDTO {
    const c = convention({
      id: 'conv_9',
      repoKey: 'acme/api',
      version: 1,
      contentMd: '# API rules',
    });
    return surface({ repoKey: 'acme/api', convention: c, versions: [c] });
  }
  function emptySurface(): ConventionSurfaceDTO {
    return surface({ repoKey: 'acme/none', convention: null, versions: [] });
  }
  const header = cardHeader;
  const expandedHeaders = () =>
    screen.getAllByRole('button', { expanded: true }).filter((b) => b.closest('h3'));

  let push: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    nav.searchParams = new URLSearchParams();
    push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
  });
  afterEach(() => {
    push.mockRestore();
    nav.searchParams = new URLSearchParams();
  });

  it('expands the first repository on load and keeps the others to their header row', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface(), emptySurface()]} />);

    expect(header('acme/web').getAttribute('aria-expanded')).toBe('true');
    expect(header('acme/api').getAttribute('aria-expanded')).toBe('false');
    expect(header('acme/none').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('House rules')).toBeTruthy();
    expect(screen.queryByText('API rules')).toBeNull();
    // The collapsed header still tells the repositories apart.
    expect(screen.getByText('v1 · derived')).toBeTruthy();
    expect(screen.getByText('No convention yet')).toBeTruthy();
  });

  it('expands the repository the server resolved from ?repo=, and falls back to the first for an unknown one', () => {
    // The server reads the same address the client then sees.
    nav.searchParams = new URLSearchParams('repo=acme/api');
    renderWithIntl(
      <ConventionPanel conventions={[surface(), apiSurface()]} initialRepo="acme/api" />,
    );
    expect(header('acme/api').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('API rules')).toBeTruthy();
    cleanup();

    nav.searchParams = new URLSearchParams('repo=x/y');
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} initialRepo="x/y" />);
    expect(header('acme/web').getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses the open card when another is expanded, so at most one is ever open', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface(), emptySurface()]} />);

    fireEvent.click(header('acme/api'));
    expect(expandedHeaders()).toEqual([header('acme/api')]);
    expect(screen.getByText('API rules')).toBeTruthy();
    expect(screen.queryByText('House rules')).toBeNull();

    fireEvent.click(header('acme/none'));
    expect(expandedHeaders()).toEqual([header('acme/none')]);
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('collapses the open card on a second press, leaving none open', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    fireEvent.click(header('acme/web'));
    expect(screen.queryAllByRole('region')).toHaveLength(0);
    expect(header('acme/web').getAttribute('aria-expanded')).toBe('false');
  });

  it('writes the expanded card to ?repo= with a history entry, and drops it on collapse', () => {
    window.history.replaceState(null, '', '/code?section=health');
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    fireEvent.click(header('acme/api'));
    expect(push).toHaveBeenLastCalledWith(null, '', '/code?section=health&repo=acme%2Fapi');
    fireEvent.click(header('acme/api'));
    expect(push).toHaveBeenLastCalledWith(null, '', '/code?section=health');
    window.history.replaceState(null, '', '/');
  });

  it('follows Back and forward: a ?repo= it did not write expands that card', () => {
    const { rerender } = renderWithIntl(
      <ConventionPanel conventions={[surface(), apiSurface()]} />,
    );

    nav.searchParams = new URLSearchParams('repo=acme/api');
    rerender(<ConventionPanel conventions={[surface(), apiSurface()]} />);
    expect(header('acme/api').getAttribute('aria-expanded')).toBe('true');
  });

  it('wires aria-expanded, aria-controls and a labelled region, and keeps focus on the pressed header', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    const web = header('acme/web');
    const region = screen.getByRole('region');
    expect(web.getAttribute('aria-controls')).toBe(region.id);
    expect(region.getAttribute('aria-labelledby')).toBe(web.id);
    expect(web.closest('h3')).toBeTruthy();

    const api = header('acme/api');
    api.focus();
    fireEvent.click(api);
    expect(document.activeElement).toBe(api);
    fireEvent.click(api);
    expect(document.activeElement).toBe(api);
  });

  it('names the pending-derived marker in the header of a collapsed card', () => {
    const e = edited({ pendingDerivedMd: '# Derived anew' });
    renderWithIntl(
      <ConventionPanel conventions={[apiSurface(), surface({ convention: e, versions: [e] })]} />,
    );
    expect(screen.getByText('Newer derived waiting')).toBeTruthy();
    expect(header('acme/web').textContent).toContain('Newer derived waiting');
  });

  it('keeps a draft when another card is expanded, marks the header, and restores the text', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Half written' },
    });
    expect(header('acme/web').textContent).toContain('Editing');

    fireEvent.click(header('acme/api'));
    expect(screen.queryByLabelText('Convention for acme/web (Markdown)')).toBeNull();
    expect(header('acme/web').textContent).toContain('Unsaved draft');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(header('acme/web'));
    expect(
      (screen.getByLabelText('Convention for acme/web (Markdown)') as HTMLTextAreaElement).value,
    ).toBe('# Half written');
    expect(header('acme/web').textContent).not.toContain('Unsaved draft');
  });

  it('does not mark an editor nobody typed in, and Cancel discards a draft', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(header('acme/api'));
    expect(header('acme/web').textContent).not.toContain('Unsaved draft');

    fireEvent.click(header('acme/web'));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Typed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(header('acme/api'));
    expect(header('acme/web').textContent).not.toContain('Unsaved draft');
  });

  it('asks the browser before leaving the page while a draft exists, and not otherwise', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(unload()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Typed' },
    });
    expect(unload()).toBe(true);
    // Collapsed, the draft is still there to lose.
    fireEvent.click(header('acme/api'));
    expect(unload()).toBe(true);
    fireEvent.click(header('acme/web'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(unload()).toBe(false);
  });

  it('names the repository four times in Edit and saves only to it', () => {
    renderWithIntl(<ConventionPanel conventions={[surface(), apiSurface()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('group', { name: 'You are editing acme/web' })).toBeTruthy();
    expect(screen.getByLabelText('Convention for acme/web (Markdown)')).toBeTruthy();
    expect(screen.getByText(/Saving creates v3 of acme\/web\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save to web' })).toBeTruthy();
  });

  it('keeps the saved card expanded with the new version', async () => {
    const saved = edited({ repoKey: 'acme/web', contentMd: '# Changed' });
    const savedSurface = surface({ convention: saved, versions: [saved] });
    fetchMock.mockResolvedValue(jsonResponse(200, savedSurface));
    function Host() {
      const [list, setList] = useState([surface(), apiSurface()]);
      return (
        <ConventionPanel
          conventions={list}
          onSaved={(s) => setList((prev) => prev.map((c) => (c.repoKey === s.repoKey ? s : c)))}
        />
      );
    }
    renderWithIntl(<Host />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Convention for acme/web (Markdown)'), {
      target: { value: '# Changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to web' }));

    expect(await screen.findByText('v3 · edited')).toBeTruthy();
    expect(header('acme/web').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Changed')).toBeTruthy();
  });
});
