// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  VISITOR_ADDRESS_HEADER,
  isVisitorAddressValue,
  withVisitorAddress,
} from '@/lib/visitor/address';
import { VisitorAddressFetch } from '@/app/(visitor)/p/[identifier]/_components/VisitorAddressFetch';

// The Visitor tab names its project on every request it makes (Bug MOTIR-6892):
// the `motir_visitor` cookie is one value per browser, and a member page in the
// reader's other tab cleared it under the Visitor tab. The wrapper is what puts
// the per-tab address on the wire; the doors that read it are held by
// `visitorDataDoors.integration.test.ts`.

const ORIGIN = 'https://app.example.test';

/** A `fetch` that records the headers each call went out with. */
function recorder() {
  const sent: { url: string; headers: Headers }[] = [];
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    sent.push({ url, headers });
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { base, sent };
}

describe('withVisitorAddress', () => {
  it('adds the address to a same-origin request — relative, absolute, URL and Request alike', async () => {
    const { base, sent } = recorder();
    const f = withVisitorAddress(base, 'PUB', ORIGIN);
    await f('/api/board');
    await f(`${ORIGIN}/api/work-items/peek?key=PUB-1`);
    await f(new URL('/api/boards', ORIGIN));
    await f(new Request(`${ORIGIN}/api/sprints`, { headers: { accept: 'application/json' } }));
    expect(sent.map((s) => s.headers.get(VISITOR_ADDRESS_HEADER))).toEqual([
      'PUB',
      'PUB',
      'PUB',
      'PUB',
    ]);
    // A Request's own headers survive the wrapper.
    expect(sent[3]!.headers.get('accept')).toBe('application/json');
  });

  it('keeps the caller’s own headers and never overrides an address already on the request', async () => {
    const { base, sent } = recorder();
    const f = withVisitorAddress(base, 'PUB', ORIGIN);
    await f('/api/board', { headers: { accept: 'application/json' } });
    await f('/api/board', { headers: { [VISITOR_ADDRESS_HEADER]: 'OTHER' } });
    expect(sent[0]!.headers.get('accept')).toBe('application/json');
    expect(sent[0]!.headers.get(VISITOR_ADDRESS_HEADER)).toBe('PUB');
    expect(sent[1]!.headers.get(VISITOR_ADDRESS_HEADER)).toBe('OTHER');
  });

  it('never sends the address to another origin', async () => {
    const { base, sent } = recorder();
    const f = withVisitorAddress(base, 'PUB', ORIGIN);
    await f('https://motir.co/api/x');
    await f(new Request('https://cdn.example.test/a.js'));
    for (const s of sent) expect(s.headers.has(VISITOR_ADDRESS_HEADER)).toBe(false);
  });

  it('admits a project key’s shape and nothing else', () => {
    expect(isVisitorAddressValue('MOTIR')).toBe(true);
    expect(isVisitorAddressValue('a_b-1')).toBe(true);
    expect(isVisitorAddressValue('')).toBe(false);
    expect(isVisitorAddressValue('not a key!')).toBe(false);
    expect(isVisitorAddressValue('x'.repeat(65))).toBe(false);
  });
});

describe('<VisitorAddressFetch>', () => {
  const original = window.fetch;
  afterEach(() => {
    cleanup();
    window.fetch = original;
  });

  it('while mounted, this tab’s same-origin fetches carry the address; unmounted, none do', async () => {
    const { base, sent } = recorder();
    window.fetch = base;
    const view = render(<VisitorAddressFetch identifier="PUB" />);
    await window.fetch('/api/board');
    expect(sent[0]!.headers.get(VISITOR_ADDRESS_HEADER)).toBe('PUB');

    view.unmount();
    expect(window.fetch).toBe(base);
    await window.fetch('/api/board');
    expect(sent[1]!.headers.has(VISITOR_ADDRESS_HEADER)).toBe(false);
  });

  it('is installed before a child’s mount-time fetch runs', async () => {
    const { base, sent } = recorder();
    window.fetch = base;
    const { useEffect } = await import('react');
    function Child() {
      useEffect(() => {
        void window.fetch('/api/work-items/peek?key=PUB-1');
      }, []);
      return null;
    }
    render(
      <>
        <VisitorAddressFetch identifier="PUB" />
        <Child />
      </>,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get(VISITOR_ADDRESS_HEADER)).toBe('PUB');
  });

  it('leaves a later wrapper in place when it unmounts', () => {
    const { base } = recorder();
    window.fetch = base;
    const view = render(<VisitorAddressFetch identifier="PUB" />);
    const later = vi.fn() as unknown as typeof fetch;
    window.fetch = later;
    view.unmount();
    expect(window.fetch).toBe(later);
  });
});
