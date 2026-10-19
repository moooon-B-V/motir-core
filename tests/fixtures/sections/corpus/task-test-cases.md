---
kind: task
type: test
---

Cover the proration rules of the plan-change calculator.

## Cases

- upgrade on the first day of the cycle → the full difference is charged
- downgrade mid cycle → a credit for the unused days is recorded
- change on the last day of the cycle → nothing is charged

## Tier

unit

## Approach

Pure function tests over fixed dates; no clock mocking beyond passing the date in.

## Scope BOUNDARY

The calculator only. Invoicing and tax are not exercised here.

## Acceptance criteria

- Every case above has its own named test.
- The tests pass without a database.

## Context refs

- `lib/billing/proration.ts` — the unit under test
- `tests/billing/proration.test.ts` — where the cases go
