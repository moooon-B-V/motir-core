// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PageTreeLevelDto, PageTreeRowDto } from '@/lib/dto/pages';
import { PagePlacementPicker } from '@/components/pages/tree/PagePlacementPicker';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE MOVE TO… PICKER ON ITS OWN (Story MOTIR-5753 · MOTIR-7377, the story's
// Vitest gate). `pageTreeMove.test.tsx` drives the picker through the tree — its
// listing, lazy expand, keyboard and the refusals rendered at its top. This file
// mounts `PagePlacementPicker` alone for what the tree cannot reach from outside:
// the read with no project key, a level the network drops and its retry, a Load
// more that fails and repeats from the same cursor, the pending lock, an untitled page, and the keys and pointer moves
// that must leave the active option where it is.

const page = (id: string, title: string, hasChildren = false): PageTreeRowDto => ({
  kind: 'page',
  id,
  title,
  hasChildren,
});
const folder = (id: string, name: string): PageTreeRowDto => ({
  kind: 'folder',
  id,
  name,
  hasChildren: true,
});
const level = (rows: PageTreeRowDto[], nextCursor: string | null = null): PageTreeLevelDto => ({
  rows,
  nextCursor,
});

type Answer = PageTreeLevelDto | number;
let table: Record<string, Answer> = {};
const urls: URL[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://localhost');
  urls.push(url);
  const cursor = url.searchParams.get('cursor');
  const key = `${url.searchParams.get('parent')}${cursor ? `@${cursor}` : ''}`;
  const value = table[key];
  if (value === undefined) throw new TypeError('Failed to fetch');
  if (typeof value === 'number') return json({ code: 'X' }, value);
  return json(value);
});

const onPick = vi.fn();
const onDismiss = vi.fn();

function mount(props: { pending?: boolean; projectKey?: string } = {}) {
  return renderWithIntl(
    <PagePlacementPicker
      pageId="p2"
      title="Billing model"
      currentParent={{ kind: 'root' }}
      refusal={null}
      onPick={onPick}
      onDismiss={onDismiss}
      {...props}
    />,
  );
}

const list = () => screen.getByRole('listbox', { name: 'Folders and pages' });
const optionNames = () =>
  within(list())
    .getAllByRole('option')
    .map((el) => el.textContent);
const active = () => document.getElementById(list().getAttribute('aria-activedescendant')!)!;

async function press(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}
async function settle() {
  await act(async () => {});
}

beforeEach(() => {
  table = {};
  urls.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  onPick.mockReset();
  onDismiss.mockReset();
  vi.unstubAllGlobals();
});

describe('PagePlacementPicker — reading the levels', () => {
  it('reads the active project when no key is given, and names no project', async () => {
    table.root = level([folder('f1', 'Specs')]);
    mount();
    await settle();
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.has('projectKey')).toBe(false);
    expect(urls[0]!.searchParams.get('limit')).toBe('100');
  });

  it('a root read the network drops shows the error row; Try again reads it again', async () => {
    mount();
    await settle();
    expect(within(list()).getByText('Couldn’t load what’s inside.')).toBeTruthy();
    table.root = level([folder('f1', 'Specs')]);
    await press(within(list()).getByRole('button', { name: 'Try again' }));
    expect(optionNames()).toEqual(['Project rootCurrent location', 'Specs']);
  });

  it('a failed Load more keeps the rows and repeats from the same cursor', async () => {
    table.root = level([folder('f1', 'Specs')], 'c1');
    mount();
    await settle();
    table['root@c1'] = 500;
    await press(within(list()).getByRole('button', { name: 'Load more' }));
    expect(optionNames()).toEqual(['Project rootCurrent location', 'Specs']);
    expect(within(list()).getByText('Couldn’t load what’s inside.')).toBeTruthy();
    table['root@c1'] = level([page('p8', 'Later')]);
    await press(within(list()).getByRole('button', { name: 'Try again' }));
    expect(urls.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c1', 'c1']);
    expect(optionNames()).toEqual(['Project rootCurrent location', 'Specs', 'Later']);
  });

  it('re-expanding a folder whose read failed reads it again', async () => {
    table.root = level([folder('f1', 'Specs')]);
    mount();
    await settle();
    await press(within(list()).getByRole('button', { name: 'Expand Specs' }));
    expect(within(list()).getByText('Couldn’t load what’s inside.')).toBeTruthy();
    await press(within(list()).getByRole('button', { name: 'Collapse Specs' }));
    table['folder:f1'] = level([page('p5', 'Spec one')]);
    await press(within(list()).getByRole('button', { name: 'Expand Specs' }));
    expect(optionNames()).toContain('Spec one');
    expect(urls.filter((u) => u.searchParams.get('parent') === 'folder:f1')).toHaveLength(2);
  });

  it('re-rendering does not read the root a second time', async () => {
    table.root = level([folder('f1', 'Specs')]);
    const view = mount();
    await settle();
    view.rerender(
      <PagePlacementPicker
        pageId="p2"
        title="Billing model"
        currentParent={{ kind: 'root' }}
        projectKey="OTHER"
        refusal={null}
        onPick={onPick}
        onDismiss={onDismiss}
      />,
    );
    await settle();
    expect(urls).toHaveLength(1);
  });
});

describe('PagePlacementPicker — options and input', () => {
  it('an untitled page is offered by the untitled name, in italics', async () => {
    table.root = level([page('p7', '')]);
    mount();
    await settle();
    const untitled = within(list()).getByRole('option', { name: 'Untitled' });
    expect(untitled.querySelector('.italic')?.textContent).toBe('Untitled');
  });

  it('while a move is pending, picking does nothing', async () => {
    table.root = level([folder('f1', 'Specs')]);
    mount({ pending: true });
    await settle();
    await press(within(list()).getByRole('option', { name: 'Specs' }));
    fireEvent.keyDown(list(), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('hovering an option makes it active; hovering the page itself does not', async () => {
    table.root = level([folder('f1', 'Specs'), page('p2', 'Billing model')]);
    mount();
    await settle();
    const specs = within(list()).getByRole('option', { name: 'Specs' });
    fireEvent.mouseEnter(specs);
    expect(active()).toBe(specs);
    const self = within(list()).getByRole('option', { name: /^Billing model/ });
    fireEvent.mouseEnter(self);
    expect(active()).toBe(specs);
    // Pressing down on an option keeps focus in the listbox.
    expect(fireEvent.mouseDown(specs)).toBe(false);
  });

  it('→ on a row with nothing to open, ← on a closed row and other keys leave it as it was', async () => {
    table.root = level([page('p3', 'Onboarding'), folder('f1', 'Specs')]);
    mount();
    await settle();
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    expect(active().textContent).toBe('Onboarding');
    await act(async () => {
      fireEvent.keyDown(list(), { key: 'ArrowRight' });
      fireEvent.keyDown(list(), { key: 'ArrowLeft' });
      fireEvent.keyDown(list(), { key: 'Tab' });
    });
    expect(active().textContent).toBe('Onboarding');
    expect(urls).toHaveLength(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
