// Public-projection field limits (Story 6.12 / 6.16). Kept in their OWN
// dependency-free module so BOTH the server write path (`projectsService`, which
// validates against them) AND the client on-page editor (6.16.5, which enforces
// them optimistically in the browser) can import the SAME numbers without the
// client bundle pulling in the whole service layer (and `db`).

// Server cap on the public Overview/README body (Subtask 6.12.8). Generous — a
// long README fits — but bounds the stored public-projection payload a single
// admin edit can write.
export const PUBLIC_OVERVIEW_MAX_LENGTH = 50_000;

// Caps on the public hero fields (Subtask 6.16.2), edited in place on the public
// page. The tagline is a short subtitle; tags are a small set of short meta
// pills. (The `public_tagline` column is unbounded TEXT, so this cap is an
// app-level bound, not a schema mirror.) 500 gives generous room for the
// product's own 149-char hero tagline plus much longer authored framing, while
// still bounding the stored projection; it was raised from a too-short tweet-era
// 140 (bug 6.16 / MOTIR-982). In line with how loosely mirror products bound a
// short description (a GitHub repo description allows ~350).
export const PUBLIC_TAGLINE_MAX_LENGTH = 500;
export const PUBLIC_TAGS_MAX_COUNT = 8;
export const PUBLIC_TAG_MAX_LENGTH = 24;
