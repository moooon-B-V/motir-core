// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE SIGN-UP AGREEMENT NOTICE (Story 8.4 · Subtask MOTIR-1135 · design
// `design/auth/legal-agreement.mock.html`, panels 1–4).
//
// ⚠️ THIS TEST EXISTS BECAUSE OF A LIVE DEFECT, and the assertion that matters
// is the FIRST one. MOTIR-1134 put the legal line inside `SignUpCard`'s
// `step === 'password'` branch — but `Continue with Google` sits on the step
// BEFORE it and creates an account outright, so **a person who signed up with
// Google was never shown the Terms or the Privacy Policy at all.** GDPR Art. 13
// owes transparency at collection, and for that path collection is step 1. The
// design found it by RENDERING `/sign-up` rather than reading `SignUpCard.tsx`,
// which is exactly why this is a render test and not a grep.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth/client', () => ({ signUp: { email: vi.fn() } }));

import { SignUpCard } from '@/app/(auth)/sign-up/_components/SignUpCard';

afterEach(() => {
  cleanup();
});

/**
 * The CONFIGURED manifest's two urls, as the server resolves them (MOTIR-4010).
 * `null` is the unconfigured deployment and has its own describe block below.
 */
const LEGAL = {
  termsUrl: 'https://motir.co/legal/terms',
  privacyUrl: 'https://motir.co/legal/privacy',
};

/** The notice, addressed the way a screen reader meets it: by its two links. */
function legalLinks() {
  return {
    terms: screen.queryAllByRole('link', { name: /terms of service/i }),
    privacy: screen.queryAllByRole('link', { name: /privacy policy/i }),
  };
}

describe('the sign-up agreement notice', () => {
  it('renders on the IDENTITY step — the step Continue with Google creates an account from', () => {
    renderWithIntl(<SignUpCard legal={LEGAL} />);

    // The Google button and the notice must be on screen together. This is the
    // whole defect: before MOTIR-1135 this assertion failed.
    expect(screen.getByRole('button', { name: /google/i })).toBeTruthy();
    const links = legalLinks();
    expect(links.terms).toHaveLength(1);
    expect(links.privacy).toHaveLength(1);
    // ⚠️ AMENDED 2026-09-02 (MOTIR-4010): the hrefs are the CONFIGURED manifest's
    // absolute urls now, not `/legal/<slug>` paths this application serves. The
    // assertion this test exists for — that the notice is on the step Google
    // creates an account from — is unchanged.
    expect(links.terms[0]!.getAttribute('href')).toBe(LEGAL.termsUrl);
    expect(links.privacy[0]!.getAttribute('href')).toBe(LEGAL.privacyUrl);
  });

  it('still renders on the PASSWORD step, and only ONCE', () => {
    // Moving the notice to the card foot must not leave two of them, and must
    // not drop it from the step it used to be on. "There is exactly ONE line and
    // it is that one" — the design is explicit that MOTIR-1134's string is KEPT,
    // re-placed and re-worded, never duplicated.
    renderWithIntl(<SignUpCard legal={LEGAL} />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByRole('button', { name: /create account/i })).toBeTruthy();
    const links = legalLinks();
    expect(links.terms).toHaveLength(1);
    expect(links.privacy).toHaveLength(1);
  });

  it('is a PARAGRAPH, not a consent control — there is no tick-box to block the submit', () => {
    // The card's own body assumed a required checkbox; the design rejected it
    // and DRAWS the rejection (panel 4) so the decision stays checkable. Consent
    // is not the lawful basis — the account is Art. 6(1)(b), performance of a
    // contract — so a tick-box is evidence, not a requirement, and the evidence
    // is the `legal_acceptance` row the submit writes. Adding one would put a
    // new submit-blocked failure mode on the highest-value control in the
    // product in exchange for evidence we already keep.
    renderWithIntl(<SignUpCard legal={LEGAL} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names Motir, so the same string reads correctly beside the Google button', () => {
    // One word changed from MOTIR-1134's line ("an account" → "a Motir
    // account"). On step 1 the subject is `Continue with Google`, and "creating
    // an account" beside it reads as Google's account rather than ours.
    const { container } = renderWithIntl(<SignUpCard legal={LEGAL} />);
    // Read the whole notice's text rather than a single node: the string is rich
    // text interleaved with two links, so it is split across elements.
    expect(container.textContent).toMatch(/By creating a Motir account you agree to our/i);
  });
});

// ── MOTIR-4010: the arms the manifest introduced ────────────────────────────

describe('the notice, once the documents live somewhere else', () => {
  it('links the CONFIGURED absolute urls, not a path', () => {
    renderWithIntl(<SignUpCard legal={LEGAL} />);
    const { terms, privacy } = legalLinks();

    expect(terms[0]?.getAttribute('href')).toBe(LEGAL.termsUrl);
    expect(privacy[0]?.getAttribute('href')).toBe(LEGAL.privacyUrl);
  });

  it('uses a PLAIN ANCHOR, because the target is another application', () => {
    // ⚠️ A cross-origin `next/link` looks identical until it is used — it
    // prefetches and client-navigates to a host this app does not serve. The
    // rendered element is the only place the difference is visible, so this
    // asserts the element rather than the import.
    renderWithIntl(<SignUpCard legal={LEGAL} />);
    const anchor = legalLinks().terms[0];

    expect(anchor?.tagName).toBe('A');
    // `next/link` marks its own anchors; a plain one carries none of it.
    expect(anchor?.getAttribute('data-prefetch')).toBeNull();
  });

  it('renders NOTHING AT ALL when no documents are configured', () => {
    // ⚠️ THE ASSERTION IS THE PARAGRAPH'S ABSENCE, not the absence of an anchor.
    // A re-flowed sentence with its links stripped would satisfy the weaker
    // check and is exactly the shape AMENDMENT 2 §D rejects: the sentence is
    // entirely ABOUT two documents, so unlinked it asserts agreement to
    // documents nobody published. A self-hoster has no Terms of Service.
    renderWithIntl(<SignUpCard legal={null} />);

    const { terms, privacy } = legalLinks();
    expect(terms).toHaveLength(0);
    expect(privacy).toHaveLength(0);
    // The words are gone too — this is what separates "absent" from "unlinked".
    expect(screen.queryByText(/by creating a motir account/i)).toBeNull();
    // …and the card itself still renders, which is the point of the arm.
    expect(screen.getByRole('button', { name: /google/i })).toBeTruthy();
  });

  it('still renders the card FOOT correctly without it', () => {
    // The notice carried the `border-t`, so its removal takes a hairline as well
    // as a sentence and the card ends on the footer prompt
    // (`design/auth/legal-agreement.mock.html` panel 12).
    renderWithIntl(<SignUpCard legal={null} />);
    expect(screen.getByRole('link', { name: /log in/i })).toBeTruthy();
  });
});
