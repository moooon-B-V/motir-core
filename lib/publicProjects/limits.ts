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
// pills. These match the schema columns' bounds.
export const PUBLIC_TAGLINE_MAX_LENGTH = 140;
export const PUBLIC_TAGS_MAX_COUNT = 8;
export const PUBLIC_TAG_MAX_LENGTH = 24;
