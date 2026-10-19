---
kind: task
type: code
---

Add a CSV export action to the invoices table so a bookkeeper can pull a month into a spreadsheet.

**Difficulty: medium** — one new action, but the column order has to match the on-screen order.

## Deliverables

An export button in the table toolbar and a route that streams the file.

## Approach

Reuse the table's current sort and filter state; stream rows so a large month does not load into memory.

## Assumptions

- The invoice table already exposes its active filter as a plain object.

## Scope BOUNDARY

Only the invoices table. Other tables keep their toolbars as they are.

## Acceptance criteria

- The export button downloads a CSV of exactly the rows currently shown.
- A month with no invoices downloads a header-only file.
- The file opens in a spreadsheet with the same column order as the table.

## Context refs

- `components/invoices/InvoiceToolbar.tsx` — where the button lives
- `app/api/invoices/export/route.ts` — the streaming route
