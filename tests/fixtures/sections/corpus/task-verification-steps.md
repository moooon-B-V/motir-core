---
kind: task
type: verification
---

Confirm on the staging site that the new sign-up form rejects a reused address.

## Steps

Open the sign-up page, register with a fresh address, sign out, then register again with the same address.

## Scope BOUNDARY

Staging only. Production is not touched.

## Acceptance criteria

- The second registration shows the "already registered" message.
- No second account row exists for the address.

## Context refs

- `app/signup/page.tsx` — the form under test
- `docs/staging.md` — how to reach staging
