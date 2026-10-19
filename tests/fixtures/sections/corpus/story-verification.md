---
kind: story
---

Customers can export any table as a spreadsheet and trust that it matches the screen.

## Verification recipe

Export the invoices, bookings and members tables with a filter applied, open each file, and compare its rows with the table on screen.

## Scope BOUNDARY

Invoices, bookings and members. Reports keep their own export.

## Acceptance criteria

- Each of the three tables has an export action.
- An exported file never contains a row the screen hides.

## Context refs

- `components/tables/TableToolbar.tsx` — the shared toolbar
- `docs/export.md` — the export rules
