// The page size for the cross-workspace org roster (Story 6.10.5, the at-scale
// rule — finding #57). Lives in a NON-'use client' module so the server
// component (members/page.tsx) can import the runtime value directly: importing
// a value from a `'use client'` module into a server component turns it into a
// client reference (not the number), which then flows into the roster query as a
// non-numeric `take` and crashes the page. The client roster component imports
// it from here too, so the SSR first page and the client pager agree on one
// source of truth. Small so the pager is exercised at realistic team sizes; the
// service clamps any client-supplied limit.
export const ORG_ROSTER_PAGE_SIZE = 10;
