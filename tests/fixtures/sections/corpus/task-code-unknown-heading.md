---
kind: task
type: code
---

Retire the legacy webhook retry loop in favour of the queue.

## Scope BOUNDARY

The retry loop only. Webhook signing is unchanged.

## Rollout notes

Ship behind the existing flag and watch the dead-letter count for a day.

## Acceptance criteria

- Failed deliveries are retried through the queue.
- The legacy loop is deleted.

## Context refs

- `lib/webhooks/deliver.ts` — the loop to retire
- `lib/jobs/registry.ts` — where the queue job is registered
