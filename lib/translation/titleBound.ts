// The most titles one `translate-titles` request translates (Story MOTIR-7738).
// Its own module so the browser-side batch client and the server-side door read
// the SAME number without the client importing a service file.

/** The excess over this is `truncated`, not refused — the caller asks again. */
export const TITLE_TRANSLATION_MAX_ITEMS = 100;
