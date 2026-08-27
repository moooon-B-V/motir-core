// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { OutstandingDocument } from '@/lib/legal/consent';

// THE RE-CONSENT INTERSTITIAL (Story 8.4 · Subtask MOTIR-1135 · design
// `design/auth/legal-agreement.mock.html`, panels 5–8).
//
// What these assertions are really protecting are clauses, not pixels:
// `content/legal/terms.md` §14 promises an affirmative act and a stated decline
// consequence, and the design is emphatic that the screen is NOT an error state.
// Each of those is a thing a later refactor could quietly undo.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const acceptAction = vi.fn(async () => undefined);
vi.mock('@/app/(auth)/re-consent/_actions', () => ({
  acceptCurrentLegalDocumentsAction: () => acceptAction(),
}));

const signOut = vi.fn(async (_options?: unknown) => undefined);
vi.mock('@/lib/auth/client', () => ({ signOut: (options?: unknown) => signOut(options) }));

import { ReconsentCard } from '@/app/(auth)/re-consent/_components/ReconsentCard';
import { ReconsentDeferred } from '@/app/(auth)/re-consent/_components/ReconsentDeferred';

function outstanding(overrides: Partial<OutstandingDocument> = {}): OutstandingDocument {
  return {
    slug: 'terms',
    title: 'Terms of Service',
    currentVersion: '2.0.0',
    acceptedVersion: '1.0.0',
    changeSummary: 'Adds the hosted-agent execution service.',
    effectiveDate: '12 October 2026',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the re-consent interstitial', () => {
  it('names the document, what moved, and links to the new version', () => {
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/items/MOTIR-1" />);

    expect(
      screen.getByRole('heading', { name: /we've updated our terms of service/i }),
    ).toBeTruthy();
    expect(screen.getByText('1.0.0 → 2.0.0')).toBeTruthy();
    expect(screen.getByText(/adds the hosted-agent execution service/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /read the new version/i }).getAttribute('href')).toBe(
      '/legal/terms',
    );
  });

  it('renders the degraded row when no author wrote a change summary', () => {
    // The design names this an ACCEPTABLE FALLBACK, not a reason to hold the
    // card: the delta and the link still say what to read. What must not happen
    // is an invented sentence describing a change nobody described.
    renderWithIntl(
      <ReconsentCard documents={[outstanding({ changeSummary: null })]} destination="/home" />,
    );

    expect(screen.getByText('1.0.0 → 2.0.0')).toBeTruthy();
    expect(screen.getByRole('link', { name: /read the new version/i })).toBeTruthy();
  });

  it('is ONE agreement with ONE control — never a tick-box per document', () => {
    // `terms.md` §15 makes the three documents a single agreement, so a
    // per-document tick-box would ask for three decisions where the product
    // offers one outcome. The button's own words carry the scope instead.
    renderWithIntl(
      <ReconsentCard
        documents={[outstanding(), outstanding({ slug: 'privacy', title: 'Privacy Policy' })]}
        destination="/home"
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: /agree to both and continue/i })).toBeTruthy();
  });

  it('scales the button label with the number of documents', () => {
    const three = [
      outstanding(),
      outstanding({ slug: 'privacy', title: 'Privacy Policy' }),
      outstanding({ slug: 'acceptable-use', title: 'Acceptable Use Policy' }),
    ];
    renderWithIntl(<ReconsentCard documents={three} destination="/home" />);
    expect(screen.getByRole('button', { name: /agree to all and continue/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /we've updated 3 of our documents/i })).toBeTruthy();
  });

  it('records the agreement and returns the reader to where they were going', async () => {
    // The whole point of the destination: landing somebody on a generic
    // dashboard after they clicked a specific link is the failure the arrival
    // flow exists to prevent.
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/items/MOTIR-1135" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /agree and continue/i }));
    });

    expect(acceptAction).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/items/MOTIR-1135');
  });

  it('does NOT send the reader onward when the write fails', async () => {
    // The record is the point of the screen. Navigating anyway would send them
    // into the product with nothing on file, and the gate would catch them again
    // on the next page load — which reads as the button being broken.
    acceptAction.mockRejectedValueOnce(new Error('nope'));
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/home" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /agree and continue/i }));
    });

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn't record that just now/i)).toBeTruthy();
  });

  it('always offers the way out — deferring is not declining', async () => {
    // Every other route is closed to this person, so a screen with no exit is a
    // trap: somebody on a borrowed laptop, or who simply does not want to do
    // this now, must be able to leave. The line under it removes the fear that
    // leaving costs something.
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/home" />);

    expect(screen.getByText(/we'll ask again the next time you sign in/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /not now — sign out/i }));
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('draws DECLINING whole, and destroys nothing on the way', async () => {
    // The half most likely to be skipped and the half a regulator reads first.
    // A decline path that silently does nothing is worse than no decline path —
    // and reading the consequence must not itself be a commitment, which is why
    // this is a local view with a way back rather than a navigation.
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/home" />);

    fireEvent.click(screen.getByRole('button', { name: /tell us you don't accept/i }));

    expect(
      screen.getByRole('heading', { name: /if you don't accept, you can close your account/i }),
    ).toBeTruthy();
    expect(screen.getByText(/nothing happens on this screen until you choose it/i)).toBeTruthy();
    // §15's own notice address — the route a person can actually use today.
    expect(screen.getByRole('link', { name: /legal@motir\.co/i }).getAttribute('href')).toBe(
      'mailto:legal@motir.co',
    );

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('button', { name: /agree and continue/i })).toBeTruthy();
  });

  it('is NOT an error state', () => {
    // No `role="alert"`, no `aria-live`: nothing has gone wrong, a document was
    // updated. Announcing a policy update as an error is both wrong and
    // alarming — and the one alert this surface CAN show is for a failed write,
    // which is a real error and is asserted separately above.
    const { container } = renderWithIntl(
      <ReconsentCard documents={[outstanding()]} destination="/home" />,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('says the effective date, and says so honestly when nothing is in force yet', () => {
    renderWithIntl(<ReconsentCard documents={[outstanding()]} destination="/home" />);
    expect(screen.getByText(/takes effect 12 october 2026/i)).toBeTruthy();
    cleanup();

    // `effectiveDate: TBD` maps to null in the loader, and `TBD` must never
    // reach a rendered page.
    renderWithIntl(
      <ReconsentCard documents={[outstanding({ effectiveDate: null })]} destination="/home" />,
    );
    expect(screen.getByText(/not yet in effect/i)).toBeTruthy();
    expect(screen.queryByText(/TBD/)).toBeNull();
  });

  it('reads a never-accepted document as NEW rather than as a delta from nothing', () => {
    renderWithIntl(
      <ReconsentCard documents={[outstanding({ acceptedVersion: null })]} destination="/home" />,
    );
    expect(screen.getByText(/new — version 2\.0\.0/i)).toBeTruthy();
  });

  it('opens with the effective-date chip ABOVE the headline, as the mock draws it', () => {
    // `.ac-head` is chip → `h1` → body copy: the chip says what STATE the reader
    // is in before the headline says what to do about it. Asserted by DOM order
    // rather than by a class, so a restyle cannot silently reverse it.
    const { container } = renderWithIntl(
      <ReconsentCard documents={[outstanding()]} destination="/home" />,
    );
    const header = container.querySelector('header')!;
    const chip = screen.getByText(/takes effect/i);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(header.contains(chip)).toBe(true);
    expect(chip.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the deferred screen', () => {
  it('says nothing changed, and still lets the document be read signed out', () => {
    // Deferring is DEFERRING. The reassurance is worthless if the reader has to
    // sign back in to receive it — and you cannot ask somebody to accept a
    // document you will not let them open.
    renderWithIntl(
      <ReconsentDeferred terms={{ slug: 'terms', title: 'Terms of Service', version: '2.0.0' }} />,
    );

    expect(screen.getByRole('heading', { name: /no problem — take your time/i })).toBeTruthy();
    expect(screen.getByText(/you've been signed out and nothing has changed/i)).toBeTruthy();
    // The mint status chip, by its exact text — the body copy also contains the
    // phrase "signed out", which is what a loose matcher trips over.
    expect(screen.getByText('Signed out')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /read it without signing in/i }).getAttribute('href'),
    ).toBe('/legal/terms');
    expect(screen.getByRole('link', { name: /back to sign in/i }).getAttribute('href')).toBe(
      '/sign-in',
    );
  });

  it('still says its piece when the Terms file cannot be read', () => {
    // The row is the extra; the sentence is the point.
    renderWithIntl(<ReconsentDeferred terms={null} />);
    expect(screen.getByRole('heading', { name: /no problem — take your time/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /read it without signing in/i })).toBeNull();
  });

  it('is NOT an error state either', () => {
    const { container } = renderWithIntl(<ReconsentDeferred terms={null} />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});
