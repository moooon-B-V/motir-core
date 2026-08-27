// Every email template renders to this triple. Services spread the
// result into `sendEmail(...)`.
//
// `subject` — RFC 5322 subject line. ASCII only is safest; non-ASCII
//             needs RFC 2047 encoding which most providers do for
//             you, but keep templates plain.
// `text`    — plain-text body. Each template MUST hand-write this
//             (not rely on HTML-to-text inference) so the dev-console
//             email provider's "link unredacted in text body"
//             contract from 1.1.6 is preserved per-template.
// `html`    — rendered HTML body. Comes from @react-email/render.
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /**
   * Extra RFC-5322 headers this template needs on the wire (Story 8.9 ·
   * Subtask 8.9.7). Optional and rare — the only shipped use is the follower
   * digest's `List-Unsubscribe` / `List-Unsubscribe-Post` pair, which lets a
   * mail client render its OWN unsubscribe button and is what keeps a bulk
   * sender out of a spam folder.
   *
   * It lives on the RENDER result rather than on the send call because the
   * value is per-template content: only the digest knows the recipient's
   * unsubscribe URL, and it already receives it as a prop. Templates stay pure
   * — this is data returned, not a side effect performed.
   */
  headers?: Record<string, string>;
}
