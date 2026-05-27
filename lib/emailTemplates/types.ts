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
}
